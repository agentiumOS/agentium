import type { ChatMessage, ModelProvider, ModelResponse } from "@agentium/core";
import { describe, expect, it, vi } from "vitest";
import { type ExecutionDriver, HarnessRuntime, type HarnessRuntimeConfig } from "../driver.js";

const start = { identity: { userId: "actor", tenantId: "tenant" }, sessionId: "session" };
const response = (): ModelResponse => ({
  message: { role: "assistant", content: "decision" },
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  finishReason: "stop",
  raw: {},
});
const provider = (): ModelProvider => ({
  providerId: "fixture",
  modelId: "fixture",
  generate: vi.fn<ModelProvider["generate"]>(async () => response()),
  async *stream() {},
});
const runtime = (
  execute: ExecutionDriver["start"],
  critic: ModelProvider,
  config: Partial<HarnessRuntimeConfig> = {},
) =>
  new HarnessRuntime({
    driver: {
      id: "fixture",
      version: 1,
      capabilities: { durable: false, controlledExecution: true, controls: [], policyCoverage: "local" },
      start: execute,
    },
    grants: { modelRoles: ["main", "critic"], toolIds: [] },
    models: { critic: { provider: critic, options: ["maxTokens", "temperature"] } },
    ...config,
  });

describe("controlled policy model calls", () => {
  it("shares call and token budgets without invoking task projection/controller or changing continuation role", async () => {
    const task = provider();
    const critic = provider();
    const projection = vi.fn(async ({ history }: { history: readonly ChatMessage[] }) => ({
      messages: [...history],
      provenance: [],
    }));
    const controller = vi.fn(async () => undefined);
    const rt = runtime(
      async (_request, services) => {
        await services.model(task, [{ role: "user", content: "task" }]);
        await services.controlModel("critic", [{ role: "user", content: "critic" }], { maxTokens: 1000 });
        await services.model(task, [{ role: "assistant", content: "task", providerExtras: { opaque: true } }]);
        return { text: "done" };
      },
      critic,
      {
        budgets: { maxTokens: 10, maxModelCalls: 3 },
        contextPolicy: { id: "projection", project: projection },
        controller: { id: "task", prepareStep: controller },
      },
    );
    expect(await rt.run("hello", start)).toMatchObject({ status: "completed", usage: { totalTokens: 6 } });
    expect(projection).toHaveBeenCalledTimes(2);
    expect(controller).toHaveBeenCalledTimes(2);
    expect(vi.mocked(critic.generate).mock.calls[0][1]).toMatchObject({ maxTokens: 8 });
    expect(vi.mocked(critic.generate).mock.calls[0][1]?.tools).toBeUndefined();
  });

  it("prevents policy recursion even when called during context projection", async () => {
    const task = provider();
    const critic = provider();
    const project = vi.fn(
      async ({ history }: { history: readonly ChatMessage[] }, ctx: import("@agentium/core").RunContext) => {
        await (ctx.executionServices as import("../driver.js").HarnessExecutionServices).controlModel(
          "critic",
          [{ role: "user", content: "summarize" }],
          {
            maxTokens: 10,
          },
        );
        return { messages: [...history], provenance: [] };
      },
    );
    const result = await runtime(
      async (_request, services) => {
        await services.model(task, [{ role: "user", content: "task" }]);
        return { text: "done" };
      },
      critic,
      { contextPolicy: { id: "recursive", project }, budgets: { maxModelCalls: 2 } },
    ).run("hello", start);
    expect(result.status).toBe("completed");
    expect(project).toHaveBeenCalledOnce();
    expect(critic.generate).toHaveBeenCalledOnce();
    expect(task.generate).toHaveBeenCalledOnce();
  });

  it.each([-1, 0, NaN, Infinity, 1.5])("rejects invalid token options %s before paid work", async (maxTokens) => {
    const critic = provider();
    const result = await runtime(async (_request, services) => {
      await services.controlModel("critic", [], { maxTokens });
      return { text: "unexpected" };
    }, critic).run("hello", start);
    expect(result.status).toBe("failed");
    expect(critic.generate).not.toHaveBeenCalled();
  });

  it.each(["ungranted", "unbound", "option", "continuation"])("fails closed for %s", async (failure) => {
    const critic = provider();
    const result = await runtime(
      async (_request, services) => {
        await services.controlModel(
          failure === "ungranted" ? "other" : failure === "unbound" ? "main" : "critic",
          failure === "continuation" ? [{ role: "assistant", content: "old", providerExtras: { opaque: true } }] : [],
          failure === "option" ? { maxTokens: 5 } : undefined,
        );
        return { text: "unexpected" };
      },
      critic,
      failure === "option" ? { models: { critic: { provider: critic } } } : {},
    ).run("hello", start);
    expect(result.status).toBe("failed");
    expect(critic.generate).not.toHaveBeenCalled();
  });

  it("waits cancelled policy work, retains late usage, and holds the session lease", async () => {
    let release!: (value: ModelResponse) => void;
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const pending = new Promise<ModelResponse>((resolve) => {
      release = resolve;
    });
    const critic = provider();
    critic.generate = vi.fn(async () => {
      enter();
      return pending;
    });
    const rt = runtime(async (_request, services) => {
      await services.controlModel("critic", []);
      return { text: "late" };
    }, critic);
    const handle = rt.start("hello", start);
    await entered;
    handle.cancel();
    expect((await rt.run("conflict", start)).reason?.code).toBe("session_conflict");
    expect(vi.mocked(critic.generate).mock.calls[0][1]?.signal?.aborted).toBe(true);
    release(response());
    expect(await handle.result()).toMatchObject({ status: "cancelled", usage: { totalTokens: 2 } });
  });

  it("reserves shared capacity across concurrent task and policy calls", async () => {
    let release!: (value: ModelResponse) => void;
    const critic = provider();
    critic.generate = vi.fn(
      () =>
        new Promise<ModelResponse>((resolve) => {
          release = resolve;
        }),
    );
    const rt = runtime(
      async (_request, services) => {
        const first = services.controlModel("critic", [], { maxTokens: 10 });
        await expect(services.controlModel("critic", [], { maxTokens: 10 })).rejects.toThrow("budget exhausted");
        release(response());
        await first;
        return { text: "done" };
      },
      critic,
      { budgets: { maxTokens: 10 } },
    );
    expect((await rt.run("hello", start)).status).toBe("completed");
    expect(critic.generate).toHaveBeenCalledOnce();
  });

  it("rejects tool requests and truncated policy output without dispatching anything", async () => {
    const critic = provider();
    critic.generate = vi.fn(async () => ({
      ...response(),
      finishReason: "tool_calls" as const,
      message: {
        role: "assistant" as const,
        content: null,
        toolCalls: [{ id: "effect", name: "effect", arguments: {} }],
      },
    }));
    const result = await runtime(async (_request, services) => {
      await services.controlModel("critic", []);
      return { text: "unexpected" };
    }, critic).run("hello", start);
    expect(result.status).toBe("failed");
    expect(result.usage.totalTokens).toBe(2);
  });
});
