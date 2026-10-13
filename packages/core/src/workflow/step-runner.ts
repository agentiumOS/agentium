import type { RunContext } from "../agent/run-context.js";
import type { RunOpts } from "../agent/types.js";
import { abortable } from "../models/request-controls.js";
import { WorkflowCancellationError, WorkflowMergeConflict } from "./errors.js";
import type { AgentStep, ConditionStep, FunctionStep, ParallelStep, StepDef, StepResult } from "./types.js";

interface StepExecution<TState> {
  state: TState;
  patch: Partial<TState>;
  results: StepResult[];
}

function fatal(error: unknown): boolean {
  return error instanceof WorkflowMergeConflict || error instanceof WorkflowCancellationError;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Branch snapshots are shallow. Return owned patches and replace nested objects
 * rather than mutating shared input references. */
export class StepRunner<TState extends Record<string, unknown>> {
  constructor(
    private readonly retryPolicy?: { maxRetries: number; backoffMs: number },
    private readonly failurePolicy: "continue" | "stop" = "continue",
  ) {}

  async executeSteps(
    steps: StepDef<TState>[],
    state: TState,
    ctx: RunContext,
    opts?: RunOpts,
  ): Promise<{ state: TState; results: StepResult[] }> {
    const outcome = await this.executeStepsWithPatch(steps, state, ctx, opts);
    return { state: outcome.state, results: outcome.results };
  }

  private async executeStepsWithPatch(
    steps: StepDef<TState>[],
    state: TState,
    ctx: RunContext,
    opts?: RunOpts,
  ): Promise<StepExecution<TState>> {
    let currentState = { ...state };
    const patch: Partial<TState> = {};
    const results: StepResult[] = [];
    let stopped = false;
    for (const step of steps) {
      ctx.signal?.throwIfAborted();
      if (stopped) {
        results.push({ stepName: step.name, status: "skipped", durationMs: 0 });
        continue;
      }
      const outcome = await this.executeStepWithPatch(step, currentState, ctx, opts);
      currentState = outcome.state;
      Object.assign(patch, outcome.patch);
      results.push(...outcome.results);
      stopped = this.failurePolicy === "stop" && outcome.results.some((result) => result.status === "error");
    }
    ctx.signal?.throwIfAborted();
    return { state: currentState, patch, results };
  }

  private emit(ctx: RunContext, stepName: string, status: "start" | "done" | "error"): void {
    ctx.eventBus.emit("workflow.step", { runId: ctx.runId, stepName, status });
  }

  private async executeStepWithPatch(
    step: StepDef<TState>,
    state: TState,
    ctx: RunContext,
    opts?: RunOpts,
  ): Promise<StepExecution<TState>> {
    ctx.signal?.throwIfAborted();
    const start = Date.now();
    this.emit(ctx, step.name, "start");
    try {
      let outcome: StepExecution<TState>;
      if ("condition" in step) outcome = await this.executeConditionStep(step, state, ctx, opts);
      else if ("parallel" in step) outcome = await this.executeParallelStep(step, state, ctx, opts);
      else if ("agent" in step)
        outcome = await this.withRetry(() => this.executeAgentStep(step, state, ctx, opts), ctx);
      else outcome = await this.withRetry(() => this.executeFunctionStep(step, state, ctx), ctx);
      ctx.signal?.throwIfAborted();
      outcome.results[0].durationMs = Date.now() - start;
      this.emit(ctx, step.name, outcome.results[0].status === "error" ? "error" : "done");
      return outcome;
    } catch (error) {
      ctx.signal?.throwIfAborted();
      if (fatal(error)) throw error;
      this.emit(ctx, step.name, "error");
      return {
        state,
        patch: {},
        results: [{ stepName: step.name, status: "error", error: errorMessage(error), durationMs: Date.now() - start }],
      };
    }
  }

  private ownedPatch(value: unknown): Partial<TState> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Workflow function patch must be a non-null, non-array object");
    }
    const patch: Partial<TState> = {};
    for (const key of Object.keys(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      Object.assign(patch, { [key]: Reflect.get(value, key) });
    }
    return patch;
  }

  private async executeAgentStep(
    step: AgentStep<TState>,
    state: TState,
    ctx: RunContext,
    opts?: RunOpts,
  ): Promise<StepExecution<TState>> {
    const input = step.inputFrom ? step.inputFrom(state) : JSON.stringify(state);
    const output = await step.agent.run(input, {
      sessionId: `${ctx.sessionId}:${step.name}`,
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      signal: ctx.signal,
      runMode: ctx.runMode,
      executionServices: ctx.executionServices,
      executionPolicy: opts?.executionPolicy,
      apiKey: opts?.apiKey,
      dependencies: opts?.dependencies,
      questions: opts?.questions,
      metadata: { ...ctx.metadata, parentRunId: ctx.runId },
    });
    ctx.signal?.throwIfAborted();
    if (output.status === "cancelled") throw new WorkflowCancellationError(step.name, output.reason?.message);
    if (output.status === "error" || output.status === "stopped") {
      return {
        state,
        patch: {},
        results: [
          {
            stepName: step.name,
            status: "error",
            error: output.reason?.message ?? `Child Agent ${output.status}`,
            output: { text: output.text, status: output.status, reason: output.reason },
            durationMs: 0,
          },
        ],
      };
    }
    const patch = this.ownedPatch(Object.assign({}, { [`${step.name}_output`]: output.text }));
    return { state: { ...state, ...patch }, patch, results: [{ stepName: step.name, status: "done", durationMs: 0 }] };
  }

  private async executeFunctionStep(
    step: FunctionStep<TState>,
    state: TState,
    ctx: RunContext,
  ): Promise<StepExecution<TState>> {
    const value = ctx.executionServices
      ? await ctx.executionServices.dispatchEffect(`workflow:${step.name}`, { state }, async (args) =>
          step.run(args.state as TState, ctx),
        )
      : await step.run(state, ctx);
    ctx.signal?.throwIfAborted();
    const patch = this.ownedPatch(value);
    return { state: { ...state, ...patch }, patch, results: [{ stepName: step.name, status: "done", durationMs: 0 }] };
  }

  private async executeConditionStep(
    step: ConditionStep<TState>,
    state: TState,
    ctx: RunContext,
    opts?: RunOpts,
  ): Promise<StepExecution<TState>> {
    if (!step.condition(state))
      return { state, patch: {}, results: [{ stepName: step.name, status: "skipped", durationMs: 0 }] };
    const outcome = await this.executeStepsWithPatch(step.steps, state, ctx, opts);
    const failed = outcome.results.some((result) => result.status === "error");
    return {
      ...outcome,
      results: [{ stepName: step.name, status: failed ? "error" : "done", durationMs: 0 }, ...outcome.results],
    };
  }

  private async executeParallelStep(
    step: ParallelStep<TState>,
    state: TState,
    ctx: RunContext,
    opts?: RunOpts,
  ): Promise<StepExecution<TState>> {
    const settled = await Promise.allSettled(
      step.parallel.map((branch) => this.executeStepWithPatch(branch, { ...state }, ctx, opts)),
    );
    ctx.signal?.throwIfAborted();
    for (const outcome of settled) {
      if (outcome.status === "rejected" && fatal(outcome.reason)) throw outcome.reason;
    }
    const patch: Partial<TState> = {};
    const results: StepResult[] = [];
    const written = new Set<string>();
    const conflicts = new Set<string>();
    for (const [index, outcome] of settled.entries()) {
      if (outcome.status === "rejected") {
        results.push({
          stepName: step.parallel[index].name,
          status: "error",
          error: errorMessage(outcome.reason),
          durationMs: 0,
        });
        continue;
      }
      for (const key of Object.keys(outcome.value.patch)) {
        if (written.has(key)) conflicts.add(key);
        written.add(key);
      }
      Object.assign(patch, outcome.value.patch);
      results.push(...outcome.value.results);
    }
    if (step.merge === "error" && conflicts.size > 0) throw new WorkflowMergeConflict(step.name, [...conflicts]);
    const failed = results.some((result) => result.status === "error");
    return {
      state: { ...state, ...patch },
      patch,
      results: [{ stepName: step.name, status: failed ? "error" : "done", durationMs: 0 }, ...results],
    };
  }

  private async withRetry(fn: () => Promise<StepExecution<TState>>, ctx: RunContext): Promise<StepExecution<TState>> {
    const maxRetries = this.retryPolicy?.maxRetries ?? 0;
    const backoffMs = this.retryPolicy?.backoffMs ?? 1000;
    for (let attempt = 0; ; attempt++) {
      ctx.signal?.throwIfAborted();
      try {
        return await fn();
      } catch (error) {
        ctx.signal?.throwIfAborted();
        if (fatal(error) || ctx.executionServices || attempt >= maxRetries) throw error;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const waiting = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, backoffMs * 2 ** attempt);
        });
        try {
          await (ctx.signal ? abortable(waiting, ctx.signal) : waiting);
        } finally {
          clearTimeout(timer);
        }
      }
    }
  }
}
