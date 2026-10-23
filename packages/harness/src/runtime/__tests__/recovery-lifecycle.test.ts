import type { DurableJSON, ModelProvider } from "@agentium/core";
import { defineTool, durableDigest, RunContext } from "@agentium/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";
import { agentDriver } from "../../drivers.js";
import { type ExecutionDriver, HarnessRuntime } from "../driver.js";
import {
  createHarnessRecoveryLifecycle,
  type HarnessRecoveryBoundary,
  type HarnessRecoveryLifecycleOptions,
  type HarnessRecoveryState,
} from "../recovery-lifecycle.js";

const scope = { tenantId: "tenant-a", taskId: "task-a" };
const stateSchema = z.object({ models: z.number(), tools: z.array(z.string()) });
const model = (text: string): HarnessRecoveryBoundary => ({
  type: "model.settled",
  providerId: "offline",
  modelId: "fixture",
  requestDigest: durableDigest({ question: "original" }),
  output: { text },
});
const batch: HarnessRecoveryBoundary = {
  type: "tools.settled",
  results: [
    { toolCallId: "first", toolName: "a", result: "A" },
    { toolCallId: "second", toolName: "b", result: "B" },
  ],
};
function fixture(saved?: HarnessRecoveryState) {
  let visible = { models: 0, tools: [] as string[] };
  const persisted: HarnessRecoveryState[] = [];
  const reduce = vi.fn((state: DurableJSON, boundary: HarnessRecoveryBoundary): DurableJSON => {
    const previous = stateSchema.parse(state);
    if (boundary.type === "model.settled") return { ...previous, models: previous.models + 1 };
    return {
      ...previous,
      tools: [
        ...previous.tools,
        ...boundary.results.map((result) => z.object({ result: z.string() }).parse(result).result),
      ],
    };
  });
  const options: HarnessRecoveryLifecycleOptions = {
    adapter: {
      id: "manifest-state",
      version: "1",
      configuration: { tools: "catalog-v1", skills: "skills-v1" },
      captureInitialState: () => visible,
      restoreState: (state) => {
        visible = stateSchema.parse(state);
      },
      reduce,
    },
    ...(saved ? { state: saved } : {}),
    persist: async (state) => {
      persisted.push(structuredClone(state));
    },
  };
  return { options, persisted, reduce, visible: () => visible };
}

describe("native application-state recovery lifecycle", () => {
  it("restores only causally encountered states, without rerunning retained reducers", async () => {
    const first = fixture();
    const cursor = createHarnessRecoveryLifecycle(first.options, scope);
    await cursor.initialize();
    await cursor.settle(model("decision"));
    await cursor.settle(batch);
    await cursor.finish();
    expect(first.visible()).toEqual({ models: 1, tools: ["A", "B"] });
    const saved = first.persisted.at(-1);
    expect(saved).toBeDefined();
    const resumed = fixture(saved);
    const replay = createHarnessRecoveryLifecycle(resumed.options, scope);
    await replay.initialize();
    expect(resumed.visible()).toEqual({ models: 0, tools: [] });
    await replay.settle(model("decision"));
    expect(resumed.visible()).toEqual({ models: 1, tools: [] });
    await replay.settle(batch);
    expect(resumed.visible()).toEqual({ models: 1, tools: ["A", "B"] });
    await replay.finish();
    expect(resumed.reduce).not.toHaveBeenCalled();
    expect(resumed.persisted).toEqual([]);
  });

  it("pins adapter, configuration, scope and every retained transition", async () => {
    const first = fixture();
    const cursor = createHarnessRecoveryLifecycle(first.options, scope);
    await cursor.initialize();
    await cursor.settle(batch);
    const saved = first.persisted.at(-1);
    if (!saved) throw new Error("Missing saved state");
    expect(() =>
      createHarnessRecoveryLifecycle(
        { ...fixture(saved).options, adapter: { ...first.options.adapter, version: "2" } },
        scope,
      ),
    ).toThrow("differs");
    expect(() =>
      createHarnessRecoveryLifecycle(
        { ...fixture(saved).options, adapter: { ...first.options.adapter, configuration: { tools: "changed" } } },
        scope,
      ),
    ).toThrow("differs");
    expect(() => createHarnessRecoveryLifecycle(fixture(saved).options, { ...scope, tenantId: "tenant-b" })).toThrow(
      "differs",
    );
    const corrupt = structuredClone(saved);
    corrupt.records[0].state = { models: 999, tools: [] };
    expect(() => createHarnessRecoveryLifecycle(fixture(corrupt).options, scope)).toThrow("chain");
    const other = createHarnessRecoveryLifecycle(fixture(saved).options, scope);
    await other.initialize();
    await expect(other.settle(model("wrong causal position"))).rejects.toThrow("causal sequence");
  });

  it("awaits persistence before restoration and serializes overlapping settlement callbacks", async () => {
    const host = fixture();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writes: number[] = [];
    host.options.persist = async (state) => {
      writes.push(state.records.length);
      if (state.records.length === 1) await gate;
    };
    const cursor = createHarnessRecoveryLifecycle(host.options, scope);
    await cursor.initialize();
    const first = cursor.settle(model("decision"));
    const second = cursor.settle(batch);
    await vi.waitFor(() => expect(writes).toEqual([0, 1]));
    expect(host.visible()).toEqual({ models: 0, tools: [] });
    expect(host.reduce).toHaveBeenCalledTimes(1);
    release?.();
    await Promise.all([first, second]);
    expect(writes).toEqual([0, 1, 2]);
    expect(host.visible()).toEqual({ models: 1, tools: ["A", "B"] });
  });

  it("freezes reducer inputs and checkpoint writes, and fails closed after write failure", async () => {
    const host = fixture();
    host.options.adapter.reduce = (state, boundary) => {
      expect(Object.isFrozen(state)).toBe(true);
      expect(Object.isFrozen(boundary)).toBe(true);
      if (boundary.type === "tools.settled") expect(Object.isFrozen(boundary.results[0])).toBe(true);
      return state;
    };
    host.options.persist = async (state) => {
      expect(Object.isFrozen(state.records)).toBe(true);
      if (state.records.length) throw new Error("fence lost");
    };
    const cursor = createHarnessRecoveryLifecycle(host.options, scope);
    await cursor.initialize();
    await expect(cursor.settle(batch)).rejects.toThrow("fence lost");
    await expect(cursor.settle(model("too late"))).rejects.toThrow("stopped");
    expect(host.visible()).toEqual({ models: 0, tools: [] });
  });

  it("rejects unsupported state, retention overflow and a truncated replay", async () => {
    const host = fixture();
    const cursor = createHarnessRecoveryLifecycle({ ...host.options, maxRecords: 1 }, scope);
    await cursor.initialize();
    await cursor.settle(batch);
    await expect(cursor.settle(model("overflow"))).rejects.toThrow("retention limit");
    expect(host.persisted).toHaveLength(2);
    const saved = host.persisted.at(-1);
    const replay = createHarnessRecoveryLifecycle(fixture(saved).options, scope);
    await replay.initialize();
    await expect(replay.finish()).rejects.toThrow("before replaying");
    const invalid = fixture();
    // The untyped host is still rejected at the runtime boundary.
    invalid.options.adapter.captureInitialState = () => Number.NaN;
    await expect(createHarnessRecoveryLifecycle(invalid.options, scope).initialize()).rejects.toThrow("finite JSON");
    const tooSmall = fixture();
    await expect(
      createHarnessRecoveryLifecycle({ ...tooSmall.options, maxBytes: 10 }, scope).initialize(),
    ).rejects.toThrow("retention limit");
    expect(tooSmall.persisted).toEqual([]);
  });
});

it("commits the native complete batch in declaration order before the next model sees application state", async () => {
  const host = fixture();
  const completionOrder: string[] = [];
  let completeFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    completeFirst = resolve;
  });
  const tools = [
    defineTool({
      name: "a",
      description: "first",
      parameters: z.object({}),
      execute: async () => {
        await firstGate;
        completionOrder.push("a");
        return "A";
      },
    }),
    defineTool({
      name: "b",
      description: "second",
      parameters: z.object({}),
      execute: async () => {
        completionOrder.push("b");
        completeFirst?.();
        return "B";
      },
    }),
  ];
  let calls = 0;
  let releaseWrite: (() => void) | undefined;
  const writeGate = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  let batchWriteStarted = false;
  host.options.persist = async (state) => {
    host.persisted.push(structuredClone(state));
    if (state.records.at(-1)?.boundary.type === "tools.settled") {
      batchWriteStarted = true;
      await writeGate;
    }
  };
  const provider: ModelProvider = {
    providerId: "offline",
    modelId: "native-recovery",
    async generate() {
      calls++;
      if (calls === 2) expect(host.visible()).toEqual({ models: 1, tools: ["A", "B"] });
      return {
        message:
          calls === 1
            ? {
                role: "assistant",
                content: null,
                toolCalls: [
                  { id: "first", name: "a", arguments: {} },
                  { id: "second", name: "b", arguments: {} },
                ],
              }
            : { role: "assistant", content: "done" },
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: calls === 1 ? "tool_calls" : "stop",
        raw: { secret: "never retained" },
      };
    },
    // biome-ignore lint/correctness/useYield: non-streaming fixture.
    async *stream() {
      throw new Error("Unused");
    },
  };
  const runtime = new HarnessRuntime({
    driver: agentDriver({ name: "native", model: provider, tools, maxTokens: 20 }),
    grants: { toolIds: ["a", "b"], modelRoles: ["main"] },
    budgets: { maxModelCalls: 2, maxToolCalls: 2, maxTokens: 1_000 },
  });
  const running = runtime.run("original", {
    identity: { tenantId: "tenant-a", userId: "actor-a" },
    sessionId: "causal",
    recovery: { persistBudget: async () => {}, lifecycle: host.options },
  });
  await vi.waitFor(() => expect(batchWriteStarted).toBe(true));
  expect(completionOrder).toEqual(["b", "a"]);
  expect(calls).toBe(1);
  expect(host.visible()).toEqual({ models: 1, tools: [] });
  releaseWrite?.();
  expect((await running).status).toBe("completed");
  expect(host.visible()).toEqual({ models: 2, tools: ["A", "B"] });
  expect(host.persisted.at(-1)?.records.map((record) => record.boundary.type)).toEqual([
    "model.settled",
    "tools.settled",
    "model.settled",
  ]);
  expect(JSON.stringify(host.persisted)).not.toContain("never retained");
});

it("does not capture, persist or restore lifecycle state for a conflicting session writer", async () => {
  const host = fixture();
  host.options.adapter.captureInitialState = vi.fn(host.options.adapter.captureInitialState);
  host.options.adapter.restoreState = vi.fn(host.options.adapter.restoreState);
  const persist = vi.fn(host.options.persist);
  host.options.persist = persist;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = vi.fn();
  const driver: ExecutionDriver = {
    id: "exclusive",
    version: 1,
    capabilities: { controlledExecution: true, policyCoverage: "local", controls: [], durable: false },
    async start() {
      entered();
      await gate;
      return { text: "done" };
    },
  };
  const runtime = new HarnessRuntime({ driver, grants: { toolIds: [], modelRoles: [] } });
  const identity = { tenantId: "tenant-a", userId: "actor-a" };
  const first = runtime.run("original", { identity, sessionId: "shared" });
  await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
  const conflicting = await runtime.run("original", {
    identity,
    sessionId: "shared",
    recovery: { persistBudget: async () => {}, lifecycle: host.options },
  });
  expect(conflicting.reason?.code).toBe("session_conflict");
  expect(host.options.adapter.captureInitialState).not.toHaveBeenCalled();
  expect(host.options.adapter.restoreState).not.toHaveBeenCalled();
  expect(persist).not.toHaveBeenCalled();
  release?.();
  expect((await first).status).toBe("completed");
});

it("deduplicates direct dispatch and repeated observation of the same settled result", async () => {
  const host = fixture();
  const tool = defineTool({ name: "a", description: "first", parameters: z.object({}), execute: async () => "A" });
  const driver: ExecutionDriver = {
    id: "dispatch",
    version: 1,
    capabilities: { controlledExecution: true, policyCoverage: "local", controls: [], durable: false },
    async start(_request, services) {
      const result = await services.dispatch({ id: "first", name: "a", arguments: {} });
      await Promise.all([services.observeToolSettlements([result]), services.observeToolSettlements([result])]);
      return { text: "done" };
    },
  };
  const runtime = new HarnessRuntime({ driver, tools: [tool], grants: { toolIds: ["a"], modelRoles: [] } });
  expect(
    (
      await runtime.run("original", {
        identity: { tenantId: "tenant-a", userId: "actor-a" },
        sessionId: "dispatch",
        recovery: { persistBudget: async () => {}, lifecycle: host.options },
      })
    ).status,
  ).toBe("completed");
  expect(host.visible()).toEqual({ models: 0, tools: ["A"] });
  expect(host.persisted.at(-1)?.records).toHaveLength(1);
});

it("rejects nested native model work before invoking its provider", async () => {
  const host = fixture();
  const generate = vi.fn(async () => {
    throw new Error("must not run");
  });
  const provider: ModelProvider = {
    providerId: "offline",
    modelId: "child",
    generate,
    // biome-ignore lint/correctness/useYield: fixture rejects streaming.
    async *stream() {
      throw new Error("must not run");
    },
  };
  const driver: ExecutionDriver = {
    id: "nested",
    version: 1,
    capabilities: { controlledExecution: true, policyCoverage: "local", controls: [], durable: false },
    async start(request, services) {
      await services.model(
        provider,
        [{ role: "user", content: "nested" }],
        {},
        new RunContext({ runId: "child", sessionId: request.sessionId, eventBus: services.ctx.eventBus }),
      );
      return { text: "unreachable" };
    },
  };
  const runtime = new HarnessRuntime({ driver, grants: { toolIds: [], modelRoles: ["main"] } });
  const result = await runtime.run("original", {
    identity: { tenantId: "tenant-a", userId: "actor-a" },
    sessionId: "nested",
    recovery: { persistBudget: async () => {}, lifecycle: host.options },
  });
  expect(result.status).toBe("failed");
  expect(result.reason?.message).toContain("nested native recovery lifecycle");
  expect(generate).not.toHaveBeenCalled();
  expect(host.persisted.at(-1)?.records).toEqual([]);
});

it("does not commit an ordinary session snapshot after an application-state restore fails", async () => {
  const host = fixture();
  let restores = 0;
  host.options.adapter.restoreState = () => {
    restores++;
    if (restores === 2) throw new Error("partial application restore");
  };
  const commit = vi.fn();
  const release = vi.fn();
  const driver: ExecutionDriver = {
    id: "failed-restore",
    version: 1,
    capabilities: { controlledExecution: true, policyCoverage: "local", controls: [], durable: false },
    async start(_request, services) {
      await services.dispatch({ id: "first", name: "a", arguments: {} });
      return { text: "unreachable" };
    },
  };
  const runtime = new HarnessRuntime({
    driver,
    tools: [defineTool({ name: "a", description: "first", parameters: z.object({}), execute: async () => "A" })],
    grants: { toolIds: ["a"], modelRoles: [] },
    sessionStore: {
      guarantees: { durable: false, compareAndSwap: false, singleWriter: "process" },
      acquire: async () => ({
        read: () => ({ history: [], state: {}, revision: 0, replayable: true }),
        commit,
        release,
      }),
    },
  });
  const result = await runtime.run("original", {
    identity: { tenantId: "tenant-a", userId: "actor-a" },
    sessionId: "failed-restore",
    recovery: { persistBudget: async () => {}, lifecycle: host.options },
  });
  expect(result.reason?.message).toContain("partial application restore");
  expect(commit).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
  expect(host.persisted.at(-1)?.records).toHaveLength(1);
});
