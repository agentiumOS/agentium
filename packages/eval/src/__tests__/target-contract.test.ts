import { Agent, type MessageContent, type ModelProvider, type RunOpts, type RunOutput } from "@agentium/core";
import { afterEach, expect, it, vi } from "vitest";
import { EvalSuite } from "../suite.js";
import type { EvalTarget } from "../types.js";

const output: RunOutput = {
  text: "answer",
  status: "completed",
  toolCalls: [],
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
};
const scorer = { name: "valid", score: async () => ({ score: 1, pass: true }) };
afterEach(() => vi.useRealTimers());
it("accepts a literal structural target and forwards multimodal content", async () => {
  const input: MessageContent = [
    { type: "text", text: "describe" },
    { type: "image", data: "AA==", mimeType: "image/png" },
  ];
  const run = vi.fn(async (_input: MessageContent, _opts?: RunOpts) => output);
  const target: EvalTarget = { run };
  expect(
    (
      await new EvalSuite({
        name: "literal",
        agent: target,
        cases: [{ name: "image", input }],
        scorers: [scorer],
      }).run()
    ).passed,
  ).toBe(1);
  expect(run.mock.calls[0]?.[0]).toEqual(input);
});
it("preserves ordinary Agent compatibility", async () => {
  const model: ModelProvider = {
    providerId: "fixture",
    modelId: "fixture",
    generate: async () => ({
      message: { role: "assistant", content: "answer" },
      usage: output.usage,
      finishReason: "stop",
      raw: {},
    }),
    stream: async function* () {},
  };
  const agent = new Agent({ name: "compatible", model, register: false });
  const target: EvalTarget = agent;
  try {
    expect(
      (
        await new EvalSuite({
          name: "agent",
          agent: target,
          cases: [{ name: "one", input: "hello" }],
          scorers: [scorer],
        }).run()
      ).passed,
    ).toBe(1);
  } finally {
    await agent.close();
  }
});
it("reserves an explicit structural target session until ignored cancellation settles", async () => {
  vi.useFakeTimers();
  let resolveRun: ((value: RunOutput) => void) | undefined;
  const run = vi.fn(
    () =>
      new Promise<RunOutput>((resolve) => {
        resolveRun = resolve;
      }),
  );
  const target: EvalTarget = { run };
  const suite = () =>
    new EvalSuite({
      name: "reserved",
      agent: target,
      cases: [{ name: "one", input: "hello", runOpts: { sessionId: "same" } }],
      timeoutMs: 5,
      scorers: [scorer],
    });
  const first = suite().run();
  await vi.advanceTimersByTimeAsync(5);
  expect((await first).results[0]).toMatchObject({ failureKind: "timeout", cleanupPending: true });
  expect((await suite().run()).results[0].failureKind).toBe("infrastructure");
  expect(run).toHaveBeenCalledTimes(1);
  resolveRun?.(output);
  await vi.advanceTimersByTimeAsync(0);
  run.mockResolvedValue(output);
  expect((await suite().run()).passed).toBe(1);
});
it("starts no structural target work after cancellation", async () => {
  const parent = new AbortController();
  parent.abort();
  const run = vi.fn(async (_input: MessageContent, _opts?: RunOpts) => output);
  expect(
    (
      await new EvalSuite({
        name: "cancelled",
        agent: { run },
        cases: [{ name: "one", input: "hello" }],
        signal: parent.signal,
        scorers: [scorer],
      }).run()
    ).results[0].failureKind,
  ).toBe("cancelled");
  expect(run).not.toHaveBeenCalled();
});
