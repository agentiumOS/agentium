import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";
import type { ModelProvider } from "../../models/provider.js";
import type { ChatMessage, StreamChunk } from "../../models/types.js";
import type { ToolDef } from "../../tools/types.js";
import { Agent } from "../agent.js";
import type { RunContext } from "../run-context.js";
import type { AgentConfig, RunOpts } from "../types.js";

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const toolCall = { id: "effect-call", name: "effect", arguments: { value: "valid" } };
function model(): ModelProvider {
  return {
    providerId: "test",
    modelId: "test-model",
    generate: vi.fn(async (messages: ChatMessage[]) => {
      const done = messages.some((message) => message.role === "tool");
      return {
        message: {
          role: "assistant" as const,
          content: done ? "finished" : null,
          ...(done ? {} : { toolCalls: [toolCall] }),
        },
        finishReason: done ? ("stop" as const) : ("tool_calls" as const),
        usage,
        raw: {},
      };
    }),
    async *stream(messages: ChatMessage[]): AsyncGenerator<StreamChunk> {
      if (messages.some((message) => message.role === "tool")) {
        yield { type: "text", text: "finished" };
        yield { type: "finish", finishReason: "stop", usage };
      } else {
        yield { type: "tool_call_start", toolCall: { id: toolCall.id, name: toolCall.name } };
        yield { type: "tool_call_delta", toolCallId: toolCall.id, argumentsDelta: JSON.stringify(toolCall.arguments) };
        yield { type: "tool_call_end", toolCallId: toolCall.id };
        yield { type: "finish", finishReason: "tool_calls", usage };
      }
    },
  };
}

const agents: Agent[] = [];
function setup(config: Partial<AgentConfig> = {}, dynamic = false) {
  const execute = vi.fn(async (_args: Record<string, unknown>, _ctx: RunContext) => "effect happened");
  const tool: ToolDef = {
    name: "effect",
    description: "test effect",
    parameters: z.object({ value: z.string() }),
    execute,
    requiresApproval: true,
  };
  const agent = new Agent({
    name: "boundary-test",
    register: false,
    model: model(),
    approval: { policy: "all", timeout: 1000 },
    ...(dynamic ? { toolResolver: async () => [tool] } : { tools: [tool] }),
    ...config,
  });
  agents.push(agent);
  return { agent, execute };
}
async function consume(agent: Agent, mode: "run" | "stream", opts?: RunOpts) {
  if (mode === "run") return (await agent.run("perform effect", opts)).text;
  let text = "";
  for await (const chunk of agent.stream("perform effect", opts)) if (chunk.type === "text") text += chunk.text;
  return text;
}

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
});

describe("Agent execution boundaries", () => {
  it.each(["run", "stream"] as const)(
    "routes synchronous approval for a dynamic tool through the public facade in %s",
    async (mode) => {
      const { agent, execute } = setup({}, true);
      const manager = agent.approvalManager;
      expect(manager).not.toBeNull();
      agent.eventBus.on("tool.approval.request", (request) => {
        expect(agent.approvalManager).toBe(manager);
        expect(manager!.listPending({ tenantId: "tenant" })).toHaveLength(1);
        expect(request).toMatchObject({ userId: "user", tenantId: "tenant", sessionId: "session" });
        manager!.approve(request.requestId);
      });
      expect(await consume(agent, mode, { sessionId: "session", userId: "user", tenantId: "tenant" })).toBe("finished");
      expect(execute).toHaveBeenCalledTimes(1);
      expect(manager!.listPending()).toEqual([]);
    },
  );

  it("routes concurrent requests separately by run and tenant", async () => {
    const { agent, execute } = setup();
    let bothPending!: () => void;
    const pending = new Promise<void>((resolve) => {
      bothPending = resolve;
    });
    agent.eventBus.on("tool.approval.request", () => {
      if (agent.approvalManager!.listPending().length === 2) bothPending();
    });
    const first = agent.run("first", { sessionId: "first", tenantId: "a" });
    const second = agent.run("second", { sessionId: "second", tenantId: "b" });
    await pending;
    const [a] = agent.approvalManager!.listPending({ tenantId: "a" });
    const [b] = agent.approvalManager!.listPending({ tenantId: "b" });
    expect(a.runId).not.toBe(b.runId);
    agent.approvalManager!.approve("unknown-id");
    expect(agent.approvalManager!.listPending()).toHaveLength(2);
    agent.approvalManager!.approve(a.requestId);
    agent.approvalManager!.deny(b.requestId, "Tenant B denied");
    const [allowed, denied] = await Promise.all([first, second]);
    expect(allowed.toolCalls[0].error).toBeUndefined();
    expect(denied.toolCalls[0].denial).toBe("approval_denied");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][1].tenantId).toBe("a");
    expect(agent.approvalManager!.listPending()).toEqual([]);
  });

  it.each(["run", "stream"] as const)("aborts pending approval without executing in %s", async (mode) => {
    const { agent, execute } = setup();
    const controller = new AbortController();
    agent.eventBus.on("tool.approval.request", ({ requestId }) => {
      controller.abort();
      agent.approvalManager!.approve(requestId);
    });
    if (mode === "run") {
      expect((await agent.run("perform effect", { signal: controller.signal })).status).toBe("cancelled");
    } else {
      await expect(consume(agent, mode, { signal: controller.signal })).rejects.toThrow(/cancelled/i);
    }
    expect(execute).not.toHaveBeenCalled();
    expect(agent.approvalManager!.listPending()).toEqual([]);
  });

  it.each(["run", "stream"] as const)(
    "inherits immutable plan mode and denies declared effects in %s",
    async (mode) => {
      const { agent, execute } = setup({
        executionPolicy: {
          decide: (_call, ctx) => {
            expect(ctx.runMode).toBe("plan");
            return { action: "allow" };
          },
          resolveEffect: () => "write",
        },
      });
      const requests = vi.fn();
      agent.eventBus.on("tool.approval.request", requests);
      await consume(agent, mode, { runMode: "plan" });
      expect(execute).not.toHaveBeenCalled();
      expect(requests).not.toHaveBeenCalled();
    },
  );
});
