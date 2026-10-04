import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";
import type { ModelProvider } from "../../models/provider.js";
import type { ChatMessage, ModelConfig, StreamChunk, ToolDefinition } from "../../models/types.js";
import { defineTool } from "../../tools/define-tool.js";
import { Agent } from "../agent.js";
import { RunContext } from "../run-context.js";
import { createTaskTool } from "../subagent.js";
import { executionFixture } from "./execution-fixture.js";

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
function model(tools = false): ModelProvider {
  return {
    providerId: "fixture",
    modelId: "fixture",
    generate: vi.fn(async (messages: ChatMessage[], options?: ModelConfig & { tools?: ToolDefinition[] }) => {
      const name = options?.tools?.find((tool) => tool.name === "effect")?.name;
      if (tools && name && !messages.some((message) => message.role === "tool")) {
        return {
          message: {
            role: "assistant" as const,
            content: null,
            toolCalls: [{ id: "effect-call", name, arguments: {} }],
          },
          usage,
          finishReason: "tool_calls" as const,
          raw: {},
        };
      }
      return {
        message: { role: "assistant" as const, content: "done" },
        usage,
        finishReason: "stop" as const,
        raw: {},
      };
    }),
    async *stream(): AsyncGenerator<StreamChunk> {
      yield { type: "finish", finishReason: "stop", usage };
    },
  };
}
function effect(execute = vi.fn(async () => "effect")) {
  return defineTool({ name: "effect", description: "effect", parameters: z.object({}), execute });
}
const parents: Agent[] = [];
function parent(config: ConstructorParameters<typeof Agent>[0]) {
  const agent = new Agent(config);
  parents.push(agent);
  return agent;
}
afterEach(async () => {
  await Promise.all(parents.splice(0).map((agent) => agent.close()));
});

describe("subagent execution boundaries", () => {
  it("retains parent mandatory policy for explicitly supplied child tools", async () => {
    const execute = vi.fn(async () => "effect");
    const decide = vi.fn(() => ({ action: "deny" as const }));
    const agent = parent({
      name: "parent",
      model: model(true),
      executionPolicy: { decide },
      register: false,
    });
    expect(await agent.spawnSubagent("work", { tools: [effect(execute)] }, { tenantId: "tenant" })).toBe("done");
    expect(execute).not.toHaveBeenCalled();
    expect(decide).toHaveBeenCalledOnce();
  });

  it("routes child approval through the parent facade without closing it after a child finishes", async () => {
    const execute = vi.fn(async () => "effect");
    const agent = parent({
      name: "parent",
      model: model(true),
      approval: { policy: "all", timeout: 1000 },
      register: false,
    });
    const requests: string[] = [];
    agent.eventBus.on("tool.approval.request", ({ requestId }) => {
      requests.push(requestId);
      agent.approvalManager!.approve(requestId);
    });
    await agent.spawnSubagent("first", { tools: [effect(execute)] });
    await agent.spawnSubagent("second", { tools: [effect(execute)] });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(new Set(requests).size).toBe(2);
    expect(agent.approvalManager!.listPending()).toEqual([]);
  });

  it("forwards execution services, tenant, signal, mode, dependencies and lineage to fresh children", async () => {
    const contexts: RunContext[] = [];
    const agent = parent({ name: "parent", model: model(), subagents: { maxDepth: 2 }, register: false });
    const controller = new AbortController();
    const services = executionFixture({
      ctx: new RunContext({
        sessionId: "parent-session",
        runId: "parent-run",
        tenantId: "tenant",
        userId: "actor",
        signal: controller.signal,
        runMode: "plan",
        eventBus: agent.eventBus,
      }),
      signal: controller.signal,
      model: async (provider, messages, options, ctx) => {
        contexts.push(ctx!);
        return provider.generate(messages, options);
      },
    });
    const ctx = new RunContext({
      sessionId: "parent-session",
      runId: "parent-run",
      tenantId: "tenant",
      userId: "actor",
      signal: controller.signal,
      runMode: "plan",
      executionServices: services,
      dependencies: { project: "example" },
      eventBus: agent.eventBus,
    });
    const starts: string[] = [];
    agent.eventBus.on("subagent.start", ({ parentRunId }) => starts.push(parentRunId));
    const task = createTaskTool(agent, { maxDepth: 2 });
    await Promise.all([task.execute({ task: "first" }, ctx), task.execute({ task: "second" }, ctx)]);
    expect(contexts).toHaveLength(2);
    for (const child of contexts) {
      expect(child).toMatchObject({
        tenantId: "tenant",
        userId: "actor",
        runMode: "plan",
        executionServices: services,
        signal: controller.signal,
        dependencies: { project: "example" },
      });
      expect(child.runId).not.toBe(ctx.runId);
      expect(child.sessionId).toContain("parent-session");
    }
    expect(contexts[0].sessionId).not.toBe(contexts[1].sessionId);
    expect(starts).toEqual(["parent-run", "parent-run"]);
    expect(contexts.every((context) => context.executionServices === services)).toBe(true);
  });

  it("caps child tool roundtrips and stops task delegation at an explicit zero depth", async () => {
    const provider = model(true);
    const agent = parent({
      name: "parent",
      model: provider,
      maxToolRoundtrips: 1,
      subagents: { maxDepth: 0 },
      register: false,
    });
    const config = agent.getSubagentConfig({ maxToolRoundtrips: 100 });
    expect(config.maxToolRoundtrips).toBe(1);
    expect(config.subagents).toBe(false);
    expect(await agent.spawnSubagent("too deep")).toMatch(/depth limit/i);
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("does not invoke supplied execution services for an already cancelled parent", async () => {
    const dispatch = vi.fn();
    const agent = parent({ name: "parent", model: model(), register: false });
    await agent.spawnSubagent("cancelled", undefined, {
      signal: AbortSignal.abort(),
      executionServices: executionFixture({ model: dispatch }),
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
