import { randomUUID } from "node:crypto";
import { type Agent, getTextContent, type RunOutput } from "@agentium/core";
import type { EvalCase, EvalResult, EvalSuiteResult, Reporter, Scorer, ScorerContext, ScorerResult } from "./types.js";

export function positive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
    throw new Error(`${name} must be a positive integer no greater than 2147483647`);
}
export function threshold(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("threshold must be between 0 and 1");
}
export function validateConfig(config: { concurrency?: number; timeoutMs?: number; threshold?: number }): void {
  positive(config.concurrency ?? 1, "concurrency");
  positive(config.timeoutMs ?? 30000, "timeoutMs");
  threshold(config.threshold ?? 0.7);
}
export function validateScorers(scorers: Scorer[], requireOne = false): void {
  if (
    (requireOne && !scorers.length) ||
    scorers.some((s) => !s.name.trim()) ||
    new Set(scorers.map((s) => s.name)).size !== scorers.length
  )
    throw new Error("Scorers must have nonempty, unique names");
}
export function validateScore(score: ScorerResult): ScorerResult {
  if (!score || !Number.isFinite(score.score) || score.score < 0 || score.score > 1 || typeof score.pass !== "boolean")
    throw new Error("Scorer must return a finite score in [0,1] and an explicit boolean pass");
  return score;
}
export function successful(output: RunOutput): boolean {
  return output.status === undefined || output.status === "completed";
}
export function scoresPass(scores: Record<string, ScorerResult>, minimum: number): boolean {
  return (
    Object.values(scores).length > 0 && Object.values(scores).every((s) => validateScore(s).pass && s.score >= minimum)
  );
}
export class EvalInterruption extends Error {
  constructor(
    readonly kind: "timeout" | "cancelled" | "infrastructure",
    message: string,
  ) {
    super(message);
  }
}
// A timed-out callback may still be running. Never overlap a reused explicit session with it.
const activeSessions = new WeakMap<Agent, Map<string, Promise<RunOutput>>>();
export class CaseLifecycle implements ScorerContext {
  readonly deadline: number;
  readonly signal: AbortSignal;
  private controller = new AbortController();
  private pending = new Set<Promise<unknown>>();
  private timer: ReturnType<typeof setTimeout>;
  private closed = false;
  private readonly timeoutMs: number;
  private readonly abort: () => void;
  constructor(
    timeoutMs: number,
    private parent?: AbortSignal,
  ) {
    positive(timeoutMs, "timeoutMs");
    this.timeoutMs = timeoutMs;
    this.signal = this.controller.signal;
    this.deadline = Date.now() + timeoutMs;
    this.abort = () => this.controller.abort(new EvalInterruption("cancelled", "Evaluation cancelled"));
    parent?.addEventListener("abort", this.abort, { once: true });
    if (parent?.aborted) this.abort();
    this.timer = setTimeout(
      () => this.controller.abort(new EvalInterruption("timeout", `Evaluation timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  }
  check(): void {
    if (!this.signal.aborted && Date.now() >= this.deadline)
      this.controller.abort(new EvalInterruption("timeout", `Evaluation timed out after ${this.timeoutMs}ms`));
    this.signal.throwIfAborted();
    if (this.closed) throw new EvalInterruption("infrastructure", "Evaluation lifecycle already closed");
  }
  async wait<T>(operation: () => Promise<T>): Promise<T> {
    this.check();
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(this.signal.reason);
    });
    this.signal.addEventListener("abort", abort, { once: true });
    const work = Promise.resolve().then(() => {
      this.check();
      return operation();
    });
    this.pending.add(work);
    void work.then(
      () => this.pending.delete(work),
      () => this.pending.delete(work),
    );
    try {
      const result = await Promise.race([work, cancelled]);
      this.check();
      return result;
    } finally {
      this.signal.removeEventListener("abort", abort);
    }
  }
  async agent(agent: Agent, evalCase: EvalCase): Promise<RunOutput> {
    this.check();
    const sessionId =
      evalCase.runOpts?.sessionId ?? evalCase.runOpts?.executionServices?.sessionKey ?? `eval-${randomUUID()}`;
    let sessions = activeSessions.get(agent);
    if (!sessions) {
      sessions = new Map();
      activeSessions.set(agent, sessions);
    }
    if (sessions.has(sessionId))
      throw new EvalInterruption("infrastructure", "Evaluation session still has unsettled work");
    const owned = sessions;
    return this.wait(() => {
      if (owned.has(sessionId))
        throw new EvalInterruption("infrastructure", "Evaluation session still has unsettled work");
      const work = Promise.resolve().then(() => {
        this.check();
        return agent.run(evalCase.input, { ...evalCase.runOpts, sessionId, signal: this.signal });
      });
      owned.set(sessionId, work);
      void work.then(
        () => owned.delete(sessionId),
        () => owned.delete(sessionId),
      );
      return work;
    });
  }
  get cleanupPending(): boolean {
    return this.pending.size > 0;
  }
  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.parent?.removeEventListener("abort", this.abort);
  }
}
export function failure(error: unknown): Pick<EvalResult, "error" | "failureKind"> {
  return {
    error: error instanceof Error ? error.message : String(error),
    failureKind: error instanceof EvalInterruption ? error.kind : "execution",
  };
}
export function inputText(evalCase: EvalCase): string {
  return typeof evalCase.input === "string" ? evalCase.input : getTextContent(evalCase.input);
}
export type CaseOutcome = Pick<EvalResult, "output" | "scores" | "pass">;
export async function evaluateCase(
  evalCase: EvalCase,
  timeoutMs: number,
  parent: AbortSignal | undefined,
  evaluate: (life: CaseLifecycle) => Promise<CaseOutcome>,
): Promise<EvalResult> {
  const started = Date.now();
  const signals = [parent, evalCase.runOpts?.signal, evalCase.runOpts?.executionServices?.signal].filter(
    (s): s is AbortSignal => !!s,
  );
  const life = new CaseLifecycle(timeoutMs, signals.length ? AbortSignal.any(signals) : undefined);
  try {
    life.check();
    const result = await evaluate(life);
    life.check();
    return { ...result, caseName: evalCase.name, input: inputText(evalCase), durationMs: Date.now() - started };
  } catch (error) {
    await Promise.resolve();
    return {
      caseName: evalCase.name,
      input: inputText(evalCase),
      scores: {},
      pass: false,
      durationMs: Date.now() - started,
      ...failure(error),
      ...(life.cleanupPending ? { cleanupPending: true } : {}),
    };
  } finally {
    life.close();
  }
}
export async function runCases<T extends EvalCase>(
  config: { name: string; cases: T[]; timeoutMs?: number; concurrency?: number; signal?: AbortSignal },
  evaluate: (item: T, life: CaseLifecycle) => Promise<CaseOutcome>,
  reporters?: Reporter[],
): Promise<EvalSuiteResult> {
  validateConfig(config);
  const start = Date.now();
  const results: EvalResult[] = [];
  for (let i = 0; i < config.cases.length; i += config.concurrency ?? 1) {
    const batch = config.cases.slice(i, i + (config.concurrency ?? 1));
    results.push(
      ...(await Promise.all(
        batch.map((item) =>
          evaluateCase(item, config.timeoutMs ?? 30000, config.signal, (life) => evaluate(item, life)),
        ),
      )),
    );
  }
  const values = results.flatMap((r) => Object.values(r.scores).map((s) => s.score));
  const passed = results.filter((r) => r.pass).length;
  const result = {
    name: config.name,
    results,
    passed,
    failed: results.length - passed,
    total: results.length,
    averageScore: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0,
    durationMs: Date.now() - start,
  };
  for (const reporter of reporters ?? []) await reporter.report(result);
  return result;
}
