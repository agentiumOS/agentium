import { getEventListeners } from "node:events";
import type { Agent, ModelProvider, RunOutput } from "@agentium/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccuracyEval } from "../accuracy-eval.js";
import { AgentJudgeEval } from "../agent-judge-eval.js";
import { CaseLifecycle } from "../case-lifecycle.js";
import { ConversationSuite } from "../conversational/conversation-suite.js";
import { ConversationRunner } from "../conversational/scenario-runner.js";
import { SyntheticUser } from "../conversational/synthetic-user.js";
import { PerformanceEval } from "../performance-eval.js";
import { ReliabilityEval } from "../reliability-eval.js";
import { llmJudge } from "../scorers/llm-judge.js";
import { toolCallMatch } from "../scorers/tool-call-match.js";
import { EvalSuite } from "../suite.js";
import type { Scorer, ScorerContext } from "../types.js";

const output = (status?: RunOutput["status"]): RunOutput => ({
  text: "answer",
  toolCalls: [],
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  status,
});
const fakeAgent = (run = vi.fn().mockResolvedValue(output())) => ({ run }) as unknown as Agent;
const fakeModel = (text = "1") =>
  ({
    generate: vi.fn().mockResolvedValue({ message: { role: "assistant", content: text } }),
  }) as unknown as ModelProvider;
const cases = [{ name: "retained-name", input: "retained-input" }];
const scorer: Scorer = { name: "check", score: async () => ({ score: 1, pass: true }) };
const scenario = {
  name: "scenario",
  initialMessage: "hello",
  successCriteria: "correct answer",
  persona: { name: "user", description: "curious", goal: "get answer", maxTurns: 3 },
};
afterEach(() => {
  vi.useRealTimers();
});

const runners = [
  [
    "suite",
    (agent: Agent, timeoutMs: number, signal?: AbortSignal) =>
      new EvalSuite({ name: "test", agent, cases, scorers: [scorer], timeoutMs, signal }).run(),
  ],
  [
    "accuracy",
    (agent: Agent, timeoutMs: number, signal?: AbortSignal) =>
      new AccuracyEval({ name: "test", agent, cases, judge: fakeModel(), timeoutMs, signal }).run(),
  ],
  [
    "judge",
    (agent: Agent, timeoutMs: number, signal?: AbortSignal) =>
      new AgentJudgeEval({
        name: "test",
        agent,
        cases,
        judge: fakeModel(),
        criteria: ["quality"],
        timeoutMs,
        signal,
      }).run(),
  ],
  [
    "reliability",
    (agent: Agent, timeoutMs: number, signal?: AbortSignal) =>
      new ReliabilityEval({ name: "test", agent, cases, timeoutMs, signal }).run(),
  ],
  [
    "performance",
    (agent: Agent, timeoutMs: number, signal?: AbortSignal) =>
      new PerformanceEval({ name: "test", agent, cases, timeoutMs, signal }).run(),
  ],
] as const;

describe.each(runners)("%s lifecycle", (_name, run) => {
  it("cancels timed-out agent work and retains case identity", async () => {
    vi.useFakeTimers();
    let received: AbortSignal | undefined;
    const agent = fakeAgent(
      vi.fn(
        (_input, opts) =>
          new Promise((_resolve, reject) => {
            received = opts.signal;
            opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true });
          }),
      ),
    );
    const pending = run(agent, 20);
    await vi.advanceTimersByTimeAsync(20);
    const {
      results: [result],
    } = await pending;
    expect(received?.aborted).toBe(true);
    expect(result).toMatchObject({
      caseName: "retained-name",
      input: "retained-input",
      pass: false,
      failureKind: "timeout",
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not start work after parent cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const agent = fakeAgent();
    const result = await run(agent, 100, controller.signal);
    expect(agent.run).not.toHaveBeenCalled();
    expect(result.results[0].failureKind).toBe("cancelled");
  });
  it("rejects invalid timeout before execution", async () => {
    const agent = fakeAgent();
    await expect(Promise.resolve().then(() => run(agent, Infinity))).rejects.toThrow("timeoutMs");
    expect(agent.run).not.toHaveBeenCalled();
  });
});

it.each([0, -1, NaN, Infinity, 1.5])("rejects invalid concurrency %s", (concurrency) => {
  expect(() => new EvalSuite({ name: "test", agent: fakeAgent(), cases, scorers: [scorer], concurrency })).toThrow(
    "concurrency",
  );
  expect(() => new ConversationSuite({ name: "test", scenarios: [scenario], concurrency }, fakeModel())).toThrow(
    "concurrency",
  );
});
it.each([NaN, Infinity, -0.1, 1.1])("rejects invalid score %s even at threshold zero", async (score) => {
  const result = await new EvalSuite({
    name: "test",
    agent: fakeAgent(),
    cases,
    threshold: 0,
    scorers: [{ name: "bad", score: async () => ({ score, pass: true }) }],
  }).run();
  expect(result.results[0]).toMatchObject({ pass: false, scores: { bad: { score: 0, pass: false } } });
});
it("requires explicit scorer pass and completed run status", async () => {
  for (const agent of [fakeAgent(), fakeAgent(vi.fn().mockResolvedValue(output("stopped")))]) {
    const result = await new EvalSuite({
      name: "test",
      agent,
      cases,
      threshold: 0,
      scorers: [{ name: "veto", score: async () => ({ score: 1, pass: false }) }],
    }).run();
    expect(result.passed).toBe(0);
  }
  const result = await new EvalSuite({
    name: "test",
    agent: fakeAgent(vi.fn().mockResolvedValue(output("stopped"))),
    cases,
    scorers: [scorer],
  }).run();
  expect(result.passed).toBe(0);
});
it("removes parent listeners and timers after successful completion", async () => {
  vi.useFakeTimers();
  const parent = new AbortController();
  const life = new CaseLifecycle(100, parent.signal);
  expect(getEventListeners(parent.signal, "abort")).toHaveLength(1);
  await life.wait(async () => 1);
  life.close();
  expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
  expect(getEventListeners(life.signal, "abort")).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});
it("reserves an explicit session until a callback ignoring abort settles", async () => {
  vi.useFakeTimers();
  let settle!: (output: RunOutput) => void;
  const agent = fakeAgent(
    vi.fn(
      () =>
        new Promise<RunOutput>((resolve) => {
          settle = resolve;
        }),
    ),
  );
  const suite = () =>
    new EvalSuite({
      name: "test",
      agent,
      cases: [{ ...cases[0], runOpts: { sessionId: "shared" } }],
      scorers: [scorer],
      timeoutMs: 20,
    });
  const pending = suite().run();
  await vi.advanceTimersByTimeAsync(20);
  expect((await pending).results[0]).toMatchObject({ failureKind: "timeout", cleanupPending: true });
  expect((await suite().run()).results[0].failureKind).toBe("infrastructure");
  expect(agent.run).toHaveBeenCalledTimes(1);
  settle(output());
  await vi.advanceTimersByTimeAsync(0);
  vi.mocked(agent.run).mockResolvedValue(output());
  expect((await suite().run()).passed).toBe(1);
});
it("the same deadline aborts judging after the agent has completed", async () => {
  vi.useFakeTimers();
  let context: ScorerContext | undefined;
  const pending = new EvalSuite({
    name: "test",
    agent: fakeAgent(),
    cases,
    timeoutMs: 25,
    scorers: [
      {
        name: "slow",
        score: async (_i, _o, _e, ctx) => {
          context = ctx;
          return new Promise(() => {});
        },
      },
    ],
  }).run();
  await vi.advanceTimersByTimeAsync(25);
  expect((await pending).results[0]).toMatchObject({ failureKind: "timeout", cleanupPending: true });
  expect(context?.signal.aborted).toBe(true);
});
it("forwards cancellation to the judge model", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const judge = {
    generate: vi.fn((_messages, opts) => {
      signal = opts.signal;
      return new Promise(() => {});
    }),
  } as unknown as ModelProvider;
  const pending = new AccuracyEval({ name: "test", agent: fakeAgent(), cases, judge, timeoutMs: 25 }).run();
  await vi.advanceTimersByTimeAsync(25);
  expect((await pending).results[0].failureKind).toBe("timeout");
  expect(signal?.aborted).toBe(true);
});
it.each(["NOT PASS", "PASS because it is good", "0.8 trailing", "NaN"])(
  "strictly rejects judge text %s",
  async (text) => {
    const result = await new AgentJudgeEval({
      name: "test",
      agent: fakeAgent(),
      cases,
      judge: fakeModel(text),
      criteria: ["quality"],
      scoringMode: text.includes("PASS") ? "binary" : "numeric",
    }).run();
    expect(result.passed).toBe(0);
  },
);
it.each(['{"score":"1"}', '{"score":2}', '{"score":1e999}', 'prefix {"score":1}'])(
  "rejects malformed JSON judge result %s",
  async (text) => {
    expect((await llmJudge({ model: fakeModel(text) }).score("question", output())).pass).toBe(false);
  },
);
it("missing required TTFT cannot pass a performance evaluation", async () => {
  const result = await new PerformanceEval({
    name: "test",
    agent: fakeAgent(),
    cases,
    maxTimeToFirstTokenMs: 10,
  }).run();
  expect(result.results[0]).toMatchObject({ pass: false, scores: { ttft: { pass: false } } });
});
it("tool matching can distinguish attempts from successful effects", async () => {
  const result = { ...output(), toolCalls: [{ toolName: "mail", error: "denied" }] } as RunOutput;
  expect((await toolCallMatch(["mail"]).score("q", result)).pass).toBe(true);
  expect((await toolCallMatch(["mail"], { mode: "successful" }).score("q", result)).pass).toBe(false);
});
it("cancels synthetic generation and starts no later conversation turn", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const model = {
    generate: vi.fn((_messages, opts) => {
      signal = opts.signal;
      return new Promise(() => {});
    }),
  } as unknown as ModelProvider;
  const agent = fakeAgent();
  const pending = new ConversationRunner(model).run(agent, scenario, [], { timeoutMs: 30 });
  await vi.advanceTimersByTimeAsync(30);
  const result = await pending;
  expect(result).toMatchObject({
    caseName: "scenario",
    input: "hello",
    pass: false,
    failureKind: "timeout",
    turnCount: 1,
  });
  expect(signal?.aborted).toBe(true);
  expect(agent.run).toHaveBeenCalledTimes(1);
});
it("matches only the exact synthetic completion marker and ties two failed agents", async () => {
  const synthetic = new SyntheticUser(scenario.persona, fakeModel("not GOAL_COMPLETE yet"));
  expect((await synthetic.generateMessage([])).goalComplete).toBe(false);
  const runner = new ConversationRunner(fakeModel("GOAL_COMPLETE"));
  const stopped = fakeAgent(vi.fn().mockResolvedValue(output("stopped")));
  expect((await runner.runComparison(stopped, stopped, scenario)).winner).toBe("tie");
});

it("retains prototype-like scorer names as real required assertions", async () => {
  const scorers: Scorer[] = [{ name: "__proto__", score: async () => ({ score: 0, pass: false }) }, scorer];
  const result = await new EvalSuite({ name: "test", agent: fakeAgent(), cases, scorers }).run();
  expect(result.passed).toBe(0);
  expect(Object.keys(result.results[0].scores)).toContain("__proto__");
  expect((await new ConversationRunner(fakeModel("GOAL_COMPLETE")).run(fakeAgent(), scenario, scorers)).pass).toBe(
    false,
  );
});
it("rejects duplicate or empty conversation scorer names before Agent I/O", async () => {
  const agent = fakeAgent();
  const runner = new ConversationRunner(fakeModel("GOAL_COMPLETE"));
  for (const scorers of [[scorer, scorer], [{ ...scorer, name: "  " }]]) {
    await expect(runner.run(agent, scenario, scorers)).rejects.toThrow("unique");
    expect(() => new EvalSuite({ name: "test", agent, cases, scorers })).toThrow("unique");
  }
  expect(agent.run).not.toHaveBeenCalled();
});

it("classifies inherited execution service cancellation as cancellation, never an expected error", async () => {
  const controller = new AbortController();
  controller.abort(new Error("Host cancelled"));
  const agent = fakeAgent();
  const result = await new ReliabilityEval({
    name: "test",
    agent,
    cases: [{ ...cases[0], shouldError: true, runOpts: { executionServices: { signal: controller.signal } as never } }],
  }).run();
  expect(result.results[0]).toMatchObject({ pass: false, failureKind: "cancelled" });
  expect(agent.run).not.toHaveBeenCalled();
});
it("checks elapsed wall time even when synchronous work prevents the timer from firing", async () => {
  vi.useFakeTimers();
  const agent = fakeAgent(
    vi.fn(async () => {
      vi.setSystemTime(Date.now() + 20);
      return output();
    }),
  );
  const result = await new EvalSuite({ name: "test", agent, cases, timeoutMs: 10, scorers: [scorer] }).run();
  expect(result.results[0]).toMatchObject({ pass: false, failureKind: "timeout" });
  expect(vi.getTimerCount()).toBe(0);
});
