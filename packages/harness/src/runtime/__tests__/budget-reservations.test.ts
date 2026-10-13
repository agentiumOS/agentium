import { Agent, type ModelProvider, type ModelResponse, ModelUsageError } from "@agentium/core";
import { describe, expect, it, vi } from "vitest";
import { agentDriver } from "../../drivers.js";
import { HarnessBudgetLedger } from "../budget.js";
import { type ExecutionDriver, HarnessRuntime, type HarnessRuntimeConfig } from "../driver.js";

const start = { identity: { tenantId: "t", userId: "u" }, sessionId: "s" };
const response = (prompt = 2, completion = 3): ModelResponse => ({
  message: { role: "assistant", content: "done" },
  finishReason: "stop",
  usage: { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion },
  raw: {},
});
const model = (): ModelProvider => ({
  providerId: "test",
  modelId: "test",
  generate: vi.fn(async () => response()),
  async *stream() {
    yield { type: "text", text: "partial" };
  },
});
const runtime = (execute: ExecutionDriver["start"], config: Partial<HarnessRuntimeConfig> = {}) =>
  new HarnessRuntime({
    driver: {
      id: "test",
      version: 1,
      capabilities: { controls: [], controlledExecution: true, durable: false, policyCoverage: "local" },
      start: execute,
    },
    grants: { toolIds: [], modelRoles: ["main", "finish"] },
    estimateInputTokens: () => 4,
    ...config,
  });
describe("host budget reservations", () => {
  it("reserves projected input plus output atomically, reconciles usage and returns snapshots by value", async () => {
    const provider = model();
    let release: (value: ModelResponse) => void = () => {};
    provider.generate = vi.fn(
      () =>
        new Promise<ModelResponse>((resolve) => {
          release = resolve;
        }),
    );
    const rt = runtime(
      async (_, services) => {
        const first = services.controlModel("main", [], { maxTokens: 6 });
        expect(services.budget.tokens).toMatchObject({ used: 0, reserved: 10, remaining: 0 });
        await expect(services.controlModel("main", [], { maxTokens: 1 })).rejects.toThrow("budget exhausted");
        expect(services.budget.modelCalls.used).toBe(1);
        release(response());
        await first;
        expect(services.budget.tokens).toMatchObject({ used: 5, reserved: 0, remaining: 5 });
        services.budget.tokens.used = 100;
        expect(services.budget.tokens.used).toBe(5);
        return { text: "done" };
      },
      { budgets: { maxTokens: 10 }, models: { main: { provider, options: ["maxTokens"] } } },
    );
    const handle = rt.start("go", start);
    expect((await handle.result()).status).toBe("completed");
    expect(handle.budget.tokens.reserved).toBe(0);
  });
  it("protects finishing tokens/calls from ordinary work and repeated denials, without bypassing completion policy", async () => {
    const provider = model();
    const completion = vi.fn(async () => ({ action: "stop" as const, reason: "missing evidence" }));
    const rt = runtime(
      async (_, services) => {
        await services.model(provider, [], { maxTokens: 6 });
        for (let i = 0; i < 4; i++) await expect(services.model(provider, [])).rejects.toThrow("budget exhausted");
        expect(services.budget.modelCalls).toMatchObject({ used: 1, finishingReserved: 1 });
        expect(services.budget.tokens.finishingReserved).toBe(10);
        await expect(services.finishModel("ungranted", [])).rejects.toThrow("Ungranted");
        await services.finishModel("finish", [], { maxTokens: 6 });
        return { text: "candidate" };
      },
      {
        budgets: { maxTokens: 20, finishingTokens: 10, maxModelCalls: 2, finishingModelCalls: 1 },
        models: { finish: { provider, options: ["maxTokens"] } },
        completionPolicy: { id: "evidence", evaluate: completion },
      },
    );
    const result = await rt.run("go", start);
    expect(result).toMatchObject({
      status: "stopped",
      reason: { message: "missing evidence" },
      budget: { modelCalls: { used: 2 }, tokens: { used: 10, reserved: 0 } },
    });
    expect(completion).toHaveBeenCalledOnce();
    expect(provider.generate).toHaveBeenCalledTimes(2);
  });
  it("charges a failed or abandoned stream conservatively and releases reservations", async () => {
    const provider = model();
    provider.generate = vi.fn(async () => {
      throw new Error("unknown usage");
    });
    const rt = runtime(
      async (_, services) => {
        await expect(services.model(provider, [], { maxTokens: 6 })).rejects.toThrow("unknown usage");
        const stream = services.streamModel(provider, [], { maxTokens: 6 });
        await stream.next();
        await stream.return(undefined);
        expect(services.budget).toMatchObject({
          unknownUsageCalls: 2,
          tokens: { used: 20, reserved: 0 },
          modelCalls: { used: 2, reserved: 0 },
        });
        return { text: "done" };
      },
      { budgets: { maxTokens: 20 } },
    );
    expect((await rt.run("go", start)).status).toBe("completed");
  });
  it("does not consume calls for projection failure, and validates tool-free finishing responses", async () => {
    const provider = model();
    const rt = runtime(
      async (_, services) => {
        await expect(services.model(provider, [])).rejects.toThrow("projection failed");
        expect(services.budget.modelCalls.used).toBe(0);
        return { text: "done" };
      },
      {
        contextPolicy: {
          id: "broken",
          project: async () => {
            throw new Error("projection failed");
          },
        },
      },
    );
    expect((await rt.run("go", start)).status).toBe("completed");
    provider.generate = vi.fn(async () => ({ ...response(), finishReason: "tool_calls" }));
    const bad = runtime(
      async (_, services) => {
        await services.finishModel("finish", []);
        return { text: "bad" };
      },
      { models: { finish: { provider } } },
    );
    expect((await bad.run("go", start)).reason?.message).toMatch(/complete tool-free/);
  });
  it("releases unsubmitted reservations and settles each ticket only once", () => {
    const ledger = new HarnessBudgetLedger({ maxTokens: 20 });
    const first = ledger.reserve(4, 6);
    first.settle();
    first.settle();
    expect(ledger.snapshot()).toMatchObject({ tokens: { used: 0, reserved: 0 }, modelCalls: { used: 0, reserved: 0 } });
    const next = ledger.reserve(4, 6);
    next.start();
    next.settle(response().usage);
    next.settle();
    expect(ledger.snapshot().tokens.used).toBe(5);
  });
});

it("holds reservations until cancelled work settles, then reconciles late usage", async () => {
  const provider = model();
  let entered: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release: (response: ModelResponse) => void = () => {};
  provider.generate = vi.fn(async () => {
    entered();
    return new Promise<ModelResponse>((resolve) => {
      release = resolve;
    });
  });
  const handle = runtime(
    async (_, services) => {
      await services.model(provider, [], { maxTokens: 6 });
      return { text: "late" };
    },
    { budgets: { maxTokens: 10 } },
  ).start("go", start);
  await ready;
  handle.cancel();
  expect(handle.budget.tokens.reserved).toBe(10);
  release(response());
  expect(await handle.result()).toMatchObject({
    status: "cancelled",
    budget: { tokens: { used: 5, reserved: 0 }, unknownUsageCalls: 0 },
  });
});

it("reconciles known billed usage from a provider normalization failure", async () => {
  const provider = model();
  provider.generate = vi.fn(async () => {
    throw new ModelUsageError("invalid arguments", response().usage);
  });
  const handle = runtime(
    async (_, services) => {
      await services.model(provider, [], { maxTokens: 6 });
      return { text: "unreachable" };
    },
    { budgets: { maxTokens: 10 } },
  ).start("go", start);
  expect(await handle.result()).toMatchObject({
    status: "failed",
    usage: { totalTokens: 5 },
    budget: { tokens: { used: 5, reserved: 0 }, unknownUsageCalls: 0 },
  });
});

it("does not charge a pre-cancelled call and preserves a per-call abort reason", async () => {
  const provider = model();
  const controller = new AbortController();
  const reason = new Error("call cancelled");
  controller.abort(reason);
  const rt = runtime(
    async (_, services) => {
      await expect(services.model(provider, [], { signal: controller.signal, maxTokens: 6 })).rejects.toBe(reason);
      expect(services.budget).toMatchObject({ tokens: { used: 0, reserved: 0 }, modelCalls: { used: 0, reserved: 0 } });
      return { text: "done" };
    },
    { budgets: { maxTokens: 10 } },
  );
  expect((await rt.run("go", start)).status).toBe("completed");
  expect(provider.generate).not.toHaveBeenCalled();
});

it("does not add a hidden Agent retry around controlled provider calls", async () => {
  const provider = model();
  provider.generate = vi.fn(async () => {
    throw Object.assign(new Error("busy"), { status: 503 });
  });
  const agent = new Agent({ name: "host-retries", model: provider });
  try {
    const rt = runtime(async () => ({ text: "unused" }), { driver: agentDriver(agent) });
    expect((await rt.run("go", start)).status).toBe("failed");
    expect(provider.generate).toHaveBeenCalledOnce();
  } finally {
    await agent.close();
  }
});
