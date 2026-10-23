import type { DurableJSON, ModelProvider, StreamChunk } from "@agentium/core";
import { describe, expect, it } from "vitest";
import { type ExecutionDriver, HarnessRuntime } from "../driver.js";
import { createHarnessNativeRecovery } from "../native-recovery.js";

describe("native stream ownership", () => {
  it("aborts a stalled producer on early return without committing a partial response", async () => {
    const records = new Map<string, DurableJSON>();
    const recovery = createHarnessNativeRecovery(
      {
        taskId: "early-return",
        configuration: {},
        journal: {
          async operation(id, _input, execute) {
            const value = await execute();
            records.set(id, value);
            return value;
          },
        },
      },
      {},
      { capture: () => ({}), restore: () => {} },
    );
    let closed = false;
    let release: () => void = () => {};
    const stream = recovery.stream(
      {},
      async function* (signal = new AbortController().signal): AsyncGenerator<StreamChunk> {
        try {
          yield { type: "text", text: "partial" };
          await new Promise<void>((resolve, reject) => {
            release = resolve;
            const abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          });
          yield { type: "finish", finishReason: "stop" };
        } finally {
          closed = true;
        }
      },
    );
    expect(await stream.next()).toEqual({ done: false, value: { type: "text", text: "partial" } });
    const returned = stream.return(undefined);
    const promptlyClosed = await Promise.race([
      returned.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    // Release the fixture even on regression, so a failing check leaves no producer running.
    release();
    await returned;
    expect(promptlyClosed).toBe(true);
    expect(closed).toBe(true);
    expect(records.has("native/0-stream")).toBe(false);
  });

  it("forwards early-return cancellation through the harness to the provider", async () => {
    let closed = false;
    let release: () => void = () => {};
    const retainedKinds: unknown[] = [];
    const provider: ModelProvider = {
      providerId: "offline",
      modelId: "stalled",
      async generate() {
        throw new Error("Unexpected nonstreaming call");
      },
      async *stream(_messages, options) {
        try {
          yield { type: "text", text: "partial" };
          await new Promise<void>((resolve, reject) => {
            release = resolve;
            const abort = () => reject(options?.signal?.reason);
            options?.signal?.addEventListener("abort", abort, { once: true });
            if (options?.signal?.aborted) abort();
          });
          yield {
            type: "finish",
            finishReason: "stop",
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
        } finally {
          closed = true;
        }
      },
    };
    const driver: ExecutionDriver = {
      id: "early-return",
      version: 1,
      capabilities: { controlledExecution: true, controls: [], policyCoverage: "local", durable: false },
      async start(_request, services) {
        const stream = services.streamModel(provider, [{ role: "user", content: "Start" }]);
        await stream.next();
        await stream.return(undefined);
        return { text: "stopped reading" };
      },
    };
    const runtime = new HarnessRuntime({ driver, grants: { modelRoles: ["main"], toolIds: [] } });
    const handle = runtime.start("Start", {
      identity: { tenantId: "tenant", userId: "actor" },
      sessionId: "early-return",
      recovery: {
        persistBudget: async () => {},
        native: {
          taskId: "early-return",
          configuration: {},
          journal: {
            async operation(_id, input, execute) {
              const value = await execute();
              if (input !== null && typeof input === "object" && !Array.isArray(input)) retainedKinds.push(input.kind);
              return value;
            },
          },
        },
      },
    });
    const result = handle.result();
    const settledPromptly = await Promise.race([
      result.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    release();
    await result;
    expect(settledPromptly).toBe(true);
    expect(closed).toBe(true);
    expect(retainedKinds).not.toContain("stream");
  });
});
