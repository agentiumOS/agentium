import { Agent, type ChatMessage, type ModelProvider, type ModelResponse } from "@agentium/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";
import { agentDriver, HarnessRuntime, reflectionPolicy, summaryContextPolicy } from "../index.js";
import type { ExecutionDriver } from "../runtime/index.js";

const start = { identity: { userId: "actor", tenantId: "tenant" }, sessionId: "session" };
const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const answer = (text: string): ModelResponse => ({
  message: { role: "assistant", content: text },
  finishReason: "stop",
  usage,
  raw: {},
});
function model(...answers: ModelResponse[]): ModelProvider {
  let index = 0;
  return {
    providerId: "fixture",
    modelId: "fixture",
    generate: vi.fn<ModelProvider["generate"]>(async () => answers[index++] ?? answer("done")),
    async *stream() {},
  };
}
const custom = (execute: ExecutionDriver["start"]): ExecutionDriver => ({
  id: "fixture",
  version: 1,
  capabilities: { controls: [], durable: false, policyCoverage: "local", controlledExecution: true },
  start: execute,
});
const history = (): ChatMessage[] => [
  { role: "system", content: "Immutable host instructions" },
  { role: "user", content: "older facts ".repeat(2000) },
  {
    role: "assistant",
    content: null,
    toolCalls: [{ id: "old", name: "lookup", arguments: {} }],
    providerExtras: { opaque: "older-provider-state" },
  },
  { role: "tool", toolCallId: "old", name: "lookup", content: "older result" },
  { role: "assistant", content: "older answer" },
  { role: "user", content: "current task" },
  {
    role: "assistant",
    content: null,
    toolCalls: [{ id: "current", name: "lookup", arguments: {} }],
    providerExtras: { opaque: "current-provider-state" },
  },
  { role: "tool", toolCallId: "current", name: "lookup", content: "current result" },
];

describe("reflection policy", () => {
  it("revises through the runtime with aggregate usage and unchanged canonical/provider history", async () => {
    const task = model(
      {
        ...answer("draft"),
        message: { role: "assistant", content: "draft", providerExtras: { opaque: "task-state" } },
      },
      answer("with evidence"),
    );
    const critic = model(
      answer(JSON.stringify({ action: "revise", reason: "missing evidence", instruction: "Include evidence" })),
      answer(JSON.stringify({ action: "accept", reason: "evidence present", evidence: ["source"] })),
    );
    const agent = new Agent({ name: "writer", model: task, register: false });
    const rt = new HarnessRuntime({
      driver: agentDriver(agent),
      grants: { toolIds: [], modelRoles: ["main", "critic"] },
      models: { critic: { provider: critic, options: ["maxTokens"] } },
      completionPolicy: reflectionPolicy({ modelRole: "critic", criteria: "Cite evidence" }),
      budgets: { maxRevisions: 1, maxModelCalls: 4 },
    });
    const result = await rt.run("write", start);
    expect(result).toMatchObject({ status: "completed", text: "with evidence", usage: { totalTokens: 8 } });
    expect(task.generate).toHaveBeenCalledTimes(2);
    expect(critic.generate).toHaveBeenCalledTimes(2);
    const lease = await rt.sessions.acquire(start.identity, start.sessionId);
    expect(lease.read().history.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(lease.read().history[1].providerExtras).toEqual({ opaque: "task-state" });
    lease.release();
    expect(JSON.stringify(vi.mocked(critic.generate).mock.calls)).not.toContain("task-state");
    await agent.close();
  });

  it.each(["model budget", "revision budget", "malformed"])("fails closed at %s", async (failure) => {
    const task = model(answer("draft"));
    const critic = model(
      answer(
        failure === "malformed"
          ? '{"action":"accept","reason":"ok","grant":"all"}'
          : JSON.stringify({ action: "revise", reason: "improve", instruction: "Improve it" }),
      ),
    );
    const agent = new Agent({ name: "writer", model: task, register: false });
    const result = await new HarnessRuntime({
      driver: agentDriver(agent),
      grants: { toolIds: [], modelRoles: ["main", "critic"] },
      models: { critic: { provider: critic, options: ["maxTokens"] } },
      completionPolicy: reflectionPolicy({ modelRole: "critic", criteria: "Improve quality" }),
      budgets: { maxModelCalls: failure === "model budget" ? 1 : 3, maxRevisions: 0 },
    }).run("write", start);
    expect(result.status).toBe(failure === "malformed" ? "failed" : "stopped");
    expect(task.generate).toHaveBeenCalledOnce();
    expect(critic.generate).toHaveBeenCalledTimes(failure === "model budget" ? 0 : 1);
    await agent.close();
  });

  it("does not authorize new tool effects during a reflection revision", async () => {
    const execute = vi.fn(async () => "unexpected");
    const task = model(
      answer("draft"),
      {
        ...answer(""),
        finishReason: "tool_calls",
        message: { role: "assistant", content: null, toolCalls: [{ id: "effect", name: "effect", arguments: {} }] },
      },
      answer("without effects"),
    );
    const critic = model(
      answer(JSON.stringify({ action: "revise", reason: "improve", instruction: "Try the tool" })),
      answer(JSON.stringify({ action: "accept", reason: "done" })),
    );
    const agent = new Agent({
      name: "writer",
      model: task,
      tools: [{ name: "effect", description: "effect", parameters: z.object({}), execute }],
      register: false,
    });
    const rt = new HarnessRuntime({
      driver: agentDriver(agent),
      grants: { toolIds: ["effect"], modelRoles: ["main", "critic"] },
      models: { critic: { provider: critic, options: ["maxTokens"] } },
      completionPolicy: reflectionPolicy({ modelRole: "critic", criteria: "Complete safely" }),
      budgets: { maxRevisions: 1, maxModelCalls: 5 },
    });
    expect((await rt.run("write", start)).status).toBe("completed");
    expect(execute).not.toHaveBeenCalled();
    await agent.close();
  });
});

describe("summary context policy", () => {
  it("summarizes historical whole turns without recursively invoking itself or altering saved history", async () => {
    const original = history();
    const task = model(answer("task answer"));
    const summary = model(answer("Older facts and decisions"));
    const policy = summaryContextPolicy({ modelRole: "summary", maxContextTokens: 300, summaryMaxTokens: 100 });
    const rt = new HarnessRuntime({
      driver: custom(async (_request, services) => {
        services.append(original);
        const response = await services.model(task, [...services.history]);
        services.append([response.message]);
        return { text: String(response.message.content) };
      }),
      grants: { toolIds: [], modelRoles: ["main", "summary"] },
      models: { summary: { provider: summary, options: ["maxTokens"] } },
      contextPolicy: policy,
      budgets: { maxModelCalls: 2 },
    });
    expect(await rt.run("hello", start)).toMatchObject({ status: "completed", usage: { totalTokens: 4 } });
    expect(summary.generate).toHaveBeenCalledOnce();
    expect(task.generate).toHaveBeenCalledOnce();
    const projection = vi.mocked(task.generate).mock.calls[0][0];
    expect(projection[0]).toEqual(original[0]);
    expect(projection.slice(-3)).toEqual(original.slice(-3));
    expect(JSON.parse(String(projection[1].content))).toEqual({
      kind: "historical_summary",
      trust: "source",
      text: "Older facts and decisions",
    });
    expect(JSON.stringify(vi.mocked(summary.generate).mock.calls)).not.toContain("provider-state");
    const lease = await rt.sessions.acquire(start.identity, start.sessionId);
    expect(lease.read().history.slice(0, original.length)).toEqual(original);
    lease.release();
    expect(original).toEqual(history());
  });

  it.each(["current turn", "source bytes", "summary output"])(
    "rejects oversized %s instead of splitting or silently truncating",
    async (failure) => {
      const task = model(answer("unexpected"));
      const summary = model(answer("unbounded ".repeat(500)));
      const original = history();
      if (failure === "current turn") original.at(-1)!.content = "large current result ".repeat(2000);
      const rt = new HarnessRuntime({
        driver: custom(async (_request, services) => {
          await services.model(task, original);
          return { text: "unexpected" };
        }),
        grants: { toolIds: [], modelRoles: ["main", "summary"] },
        models: { summary: { provider: summary, options: ["maxTokens"] } },
        contextPolicy: summaryContextPolicy({
          modelRole: "summary",
          maxContextTokens: 300,
          ...(failure === "source bytes" ? { maxInputBytes: 100 } : {}),
        }),
      });
      expect((await rt.run("hello", start)).status).toBe("failed");
      expect(task.generate).not.toHaveBeenCalled();
      expect(summary.generate).toHaveBeenCalledTimes(failure === "summary output" ? 1 : 0);
    },
  );

  it("makes no policy model call for an already bounded request", async () => {
    const task = model(answer("done"));
    const summary = model();
    const rt = new HarnessRuntime({
      driver: custom(async (_request, services) => {
        await services.model(task, [{ role: "user", content: "short" }]);
        return { text: "done" };
      }),
      grants: { toolIds: [], modelRoles: ["main", "summary"] },
      models: { summary: { provider: summary, options: ["maxTokens"] } },
      contextPolicy: summaryContextPolicy({ modelRole: "summary", maxContextTokens: 300 }),
    });
    expect((await rt.run("hello", start)).status).toBe("completed");
    expect(summary.generate).not.toHaveBeenCalled();
  });
});
