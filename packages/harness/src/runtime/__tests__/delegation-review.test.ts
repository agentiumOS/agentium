import type { ModelProvider, RunOutput, ToolDef } from "@agentium/core";
import { Agent, Team, TeamMode } from "@agentium/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";
import {
  type ExecutionDriver,
  type HarnessDriverOutput,
  HarnessRuntime,
  type HarnessRuntimeConfig,
} from "../driver.js";

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const identity = { tenantId: "tenant", userId: "actor" };
const options = { identity, sessionId: "session" };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const model = (): ModelProvider => ({
  providerId: "test",
  modelId: "test",
  generate: vi.fn<ModelProvider["generate"]>(async (messages, config) =>
    config?.tools?.some((tool) => tool.name === "effect") && !messages.some((message) => message.role === "tool")
      ? {
          message: { role: "assistant", content: null, toolCalls: [{ id: "call", name: "effect", arguments: {} }] },
          finishReason: "tool_calls",
          usage,
          raw: {},
        }
      : { message: { role: "assistant", content: "done" }, finishReason: "stop", usage, raw: {} },
  ),
  stream: async function* () {
    yield { type: "finish", finishReason: "stop", usage };
  },
});
const effect = (execute: ToolDef["execute"] = vi.fn(async () => "effect")): ToolDef => ({
  name: "effect",
  description: "effect",
  parameters: z.object({}),
  execute,
});
const runtime = (
  start: (...args: Parameters<ExecutionDriver["start"]>) => Promise<HarnessDriverOutput | RunOutput>,
  config: Partial<HarnessRuntimeConfig> = {},
) =>
  new HarnessRuntime({
    driver: {
      id: "review",
      version: 1,
      capabilities: { controls: [], controlledExecution: true, policyCoverage: "local", durable: false },
      start: async (...args) => {
        const result = await start(...args);
        return { ...result, status: result.status === "error" ? "failed" : result.status };
      },
    },
    grants: { toolIds: ["effect"], modelRoles: ["main"] },
    ...config,
  });

it("ordinary subagents inherit mandatory policy and borrowed approval/sandbox without H1", async () => {
  const tool = effect();
  const parent = new Agent({
    name: "parent",
    model: model(),
    subagents: true,
    executionPolicy: { decide: () => ({ action: "deny" }) },
    approval: { policy: "none" },
    sandbox: { enabled: true },
    register: false,
  });
  const child = parent.getSubagentConfig({ tools: [tool], maxToolRoundtrips: 100 });
  expect(child.approvalManager).toBe(parent.approvalManager);
  expect(child.sandbox).toEqual({ enabled: true });
  expect(child.maxToolRoundtrips).toBe(10);
  await parent.spawnSubagent("do work", { tools: [tool] });
  expect(tool.execute).not.toHaveBeenCalled();
  await parent.close();
});

it("runtime-dispatched tool contexts expose the same controlled services", async () => {
  const provider = model();
  const rt = runtime(
    async (_request, services) => {
      const result = await services.dispatch({ id: "call", name: "effect", arguments: {} });
      return { text: result.error ?? "unexpected" };
    },
    {
      budgets: { maxModelCalls: 0 },
      tools: [
        effect(async (_args, ctx) => {
          expect(ctx.executionServices).toBeDefined();
          await ctx.executionServices!.model(provider, []);
          return "unexpected";
        }),
      ],
    },
  );
  expect((await rt.start("hello", options).result()).text).toMatch(/budget exhausted/);
  expect(provider.generate).not.toHaveBeenCalled();
});

it("delegated per-run policy cannot relax runtime grants or Agent policy", async () => {
  const tool = effect();
  const agent = new Agent({ name: "agent", model: model(), tools: [tool], register: false });
  const rt = runtime(
    async (request, services) =>
      agent.run(request.input, {
        runId: request.runId,
        executionServices: services,
        executionPolicy: { decide: () => ({ action: "allow" }) },
        tenantId: identity.tenantId,
        userId: identity.userId,
      }),
    { executionPolicy: { decide: () => ({ action: "deny" }) } },
  );
  expect((await rt.start("hello", options).result()).status).toBe("completed");
  expect(tool.execute).not.toHaveBeenCalled();
  await agent.close();
});

it("expired deadlines never enter a driver; long deadlines do not overflow the timer", async () => {
  const execute = vi.fn(async () => ({ text: "done" }));
  const rt = runtime(execute);
  expect((await rt.start("expired", { ...options, deadline: Date.now() - 1 }).result()).status).toBe("cancelled");
  expect(execute).not.toHaveBeenCalled();
  expect((await rt.start("future", { ...options, deadline: Date.now() + 3_000_000_000 }).result()).status).toBe(
    "completed",
  );
  expect(execute).toHaveBeenCalledOnce();
});

it("Agent root session state is persisted by the runtime across turns", async () => {
  const agent = new Agent({
    name: "stateful",
    model: model(),
    register: false,
    hooks: {
      beforeRun: async (ctx) => {
        ctx.setState("count", (ctx.getState<number>("count") ?? 0) + 1);
      },
    },
  });
  const rt = runtime(async (request, services) =>
    agent.run(request.input, { runId: request.runId, executionServices: services, history: services.history }),
  );
  await rt.start("one", options).result();
  await rt.start("two", options).result();
  const lease = await rt.sessions.acquire(identity, "session");
  expect(lease.read().state.count).toBe(2);
  lease.release();
  await agent.close();
});

it.each([TeamMode.Broadcast, TeamMode.Collaborate])(
  "Team %s failure waits for sibling tools and binding cleanup before releasing the writer",
  async (mode) => {
    const entered = deferred();
    const release = deferred();
    const cleanupEntered = deferred();
    const cleanupReleased = deferred();
    const failureObserved = deferred();
    const order: string[] = [];
    const dispose = vi.fn(async () => {});
    const disposeBinding = vi.fn(async () => {
      cleanupEntered.resolve();
      await cleanupReleased.promise;
      order.push("binding disposed");
    });
    const fastFailure = model();
    fastFailure.generate = async () => {
      await entered.promise;
      throw new Error("member failure");
    };
    const failing = new Agent({ name: "failing", model: fastFailure, register: false });
    failing.eventBus.on("run.error", () => failureObserved.resolve());
    const sibling = new Agent({
      name: "sibling",
      model: model(),
      tools: [
        effect(async () => {
          entered.resolve();
          await release.promise;
          return "done";
        }),
      ],
      register: false,
    });
    const coordinator = model();
    const team = new Team({
      name: "team",
      model: coordinator,
      mode,
      members: [failing, sibling],
      register: false,
    });
    const teamError = vi.fn(() => order.push("team failed"));
    team.eventBus.on("run.error", teamError);
    const rt = runtime(
      async (request, services) => {
        await services.resource("owned", "run", async () => ({ value: {}, ownership: "runtime", dispose }));
        return team.run(String(request.input), {
          runId: request.runId,
          executionServices: services,
          signal: request.signal,
          tenantId: identity.tenantId,
          userId: identity.userId,
        });
      },
      {
        definition: {
          kind: "local",
          id: "team-cleanup",
          abilities: [
            {
              instanceId: "binding",
              validate() {},
              describe: () => ({ toolNames: [], requirements: [] }),
              bind: async () => ({ tools: [], dispose: disposeBinding }),
            },
          ],
        },
      },
    );
    const handle = rt.start("hello", options);
    let settled = false;
    const result = handle.result().then((value) => {
      settled = true;
      return value;
    });
    try {
      await entered.promise;
      expect((await rt.start("conflict", options).result()).reason?.code).toBe("session_conflict");
      expect(dispose).not.toHaveBeenCalled();
      await failureObserved.promise;
      expect(teamError).not.toHaveBeenCalled();
      release.resolve();
      await cleanupEntered.promise;
      // Flush continuations after the failure while the sibling's actual binding disposal remains blocked.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(teamError).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
      await expect(rt.sessions.acquire(identity, "session")).rejects.toMatchObject({ code: "session_conflict" });
      cleanupReleased.resolve();
      expect(await result).toMatchObject({ status: "failed", reason: { message: "member failure" } });
      expect(order).toEqual(["team failed", "binding disposed"]);
      expect(disposeBinding).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
      expect(coordinator.generate).not.toHaveBeenCalled();
      const lease = await rt.sessions.acquire(identity, "session");
      lease.release();
    } finally {
      release.resolve();
      cleanupReleased.resolve();
      await result;
      await failing.close();
      await sibling.close();
    }
  },
);

describe("explicit H2 migration diagnostics", () => {
  for (const config of [
    { reflection: { enabled: true } },
    { compressToolResults: true },
    { contextCompactor: { maxContextTokens: 100, strategy: "summarize" as const, summarizeModel: model() } },
  ]) {
    it(`rejects uncontrolled built-in model work before calls: ${Object.keys(config)[0]}`, async () => {
      const provider = model();
      const agent = new Agent({ name: "legacy", model: provider, register: false, ...config });
      const rt = runtime(async (request, services) => agent.run(request.input, { executionServices: services }));
      expect((await rt.start("hello", options).result()).reason?.message).toMatch(/supplied execution boundary/);
      expect(provider.generate).not.toHaveBeenCalled();
      await agent.close();
    });
  }
});
