import type { ChatMessage, ModelProvider, ModelResponse, StreamChunk } from "@agentium/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";
import { agentDriver, HarnessRuntime, requestInputTool, summaryContextPolicy } from "../index.js";
import type { ExecutionDriver, HarnessEvent, HarnessRuntimeConfig, RunHandle } from "../runtime/index.js";

const start = { identity: { userId: "user", tenantId: "tenant" }, sessionId: "conversation" };
const usage = { promptTokens: 2, completionTokens: 1, totalTokens: 3 };
const answer = (text: string, phase?: "commentary" | "final"): ModelResponse => ({
  message: { role: "assistant", content: text, ...(phase ? { phase } : {}) },
  usage,
  finishReason: "stop",
  raw: {},
});
const call = (id: string, name: string, args: Record<string, unknown> = {}): ModelResponse => ({
  ...answer(""),
  message: {
    role: "assistant",
    content: null,
    toolCalls: [{ id, name, arguments: args }],
    providerExtras: { opaque: id },
  },
  finishReason: "tool_calls",
});
function scripted(responses: ModelResponse[]) {
  const requests: ChatMessage[][] = [];
  let index = 0;
  const next = (messages: ChatMessage[]) => {
    requests.push(structuredClone(messages));
    const response = responses[index++];
    if (!response) throw new Error("Unexpected model call");
    return response;
  };
  const model: ModelProvider = {
    providerId: "fixture",
    modelId: "fixture",
    generate: async (messages) => next(messages),
    async *stream(messages): AsyncGenerator<StreamChunk> {
      const response = next(messages);
      if (typeof response.message.content === "string" && response.message.content)
        yield { type: "text", text: response.message.content, phase: response.message.phase };
      for (const toolCall of response.message.toolCalls ?? []) {
        yield { type: "tool_call_start", toolCall };
        yield { type: "tool_call_delta", toolCallId: toolCall.id, argumentsDelta: JSON.stringify(toolCall.arguments) };
      }
      yield {
        type: "finish",
        finishReason: response.finishReason,
        usage,
        providerExtras: response.message.providerExtras,
        phase: response.message.phase,
        publicMessages: response.publicMessages,
      };
    },
  };
  return { model, requests };
}
async function events(handle: RunHandle): Promise<HarnessEvent[]> {
  const result: HarnessEvent[] = [];
  for await (const event of handle.events()) result.push(event);
  return result;
}
function custom(execute: ExecutionDriver["start"], config: Partial<HarnessRuntimeConfig> = {}) {
  return new HarnessRuntime({
    driver: {
      id: "custom",
      version: 1,
      capabilities: { controls: ["steer"], durable: false, controlledExecution: true, policyCoverage: "local" },
      start: execute,
    },
    grants: { toolIds: [], modelRoles: ["main"] },
    ...config,
  });
}

describe.each([false, true])("conversational Agent stream=%s", (stream) => {
  it("incorporates steering sent during the final model call without restarting the Agent", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requests: ChatMessage[][] = [];
    const next = async (messages: ChatMessage[]) => {
      requests.push(structuredClone(messages));
      if (requests.length === 1) await held;
      return answer(requests.length === 1 ? "draft" : "updated");
    };
    const provider: ModelProvider = {
      providerId: "fixture",
      modelId: "fixture",
      generate: next,
      async *stream(messages) {
        const response = await next(messages);
        yield { type: "text", text: String(response.message.content) };
        yield { type: "finish", finishReason: "stop", usage };
      },
    };
    const beforeRun = vi.fn();
    const handle = new HarnessRuntime({
      driver: agentDriver({ name: "late-steer", model: provider, hooks: { beforeRun } }, { stream }),
      grants: { toolIds: [], modelRoles: ["main"] },
      budgets: { maxModelCalls: 2 },
    }).start("original", start);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await handle.send("new constraint", { mode: "steer" });
    release();
    expect(await handle.result()).toMatchObject({ status: "completed", text: "updated" });
    expect(requests[1].slice(-2)).toEqual([
      expect.objectContaining({ role: "assistant", content: "draft" }),
      { role: "user", content: "new constraint" },
    ]);
    expect(beforeRun).toHaveBeenCalledOnce();
  });

  it("cancels a built-in Agent while its question tool is waiting", async () => {
    const fixture = scripted([call("ask", "request_input", { question: "Continue?" })]);
    const runtime = new HarnessRuntime({
      driver: agentDriver({ name: "cancel-wait", model: fixture.model }, { stream }),
      tools: [requestInputTool()],
      grants: { toolIds: ["request_input"], modelRoles: ["main"] },
    });
    const handle = runtime.start("start", start);
    await vi.waitFor(() => expect(handle.state).toBe("awaiting_input"));
    handle.cancel();
    expect(await handle.result()).toMatchObject({ status: "cancelled" });
    expect(fixture.requests).toHaveLength(1);
    expect((await events(handle)).filter((event) => event.payload.type === "run.terminal")).toHaveLength(1);
    const lease = await runtime.sessions.acquire(start.identity, start.sessionId);
    lease.release();
  });

  it("resumes the suspended tool in the same run with observations and replay intact", async () => {
    const fixture = scripted([
      call("metadata", "read_metadata"),
      call("question", "request_input", { question: "Which month?" }),
      answer("September report"),
    ]);
    const effect = vi.fn(async () => '{"rows":42}');
    const rt = new HarnessRuntime({
      driver: agentDriver({ name: "conversation", model: fixture.model }, { stream }),
      tools: [
        { name: "read_metadata", description: "Read metadata", parameters: z.object({}), execute: effect },
        requestInputTool(),
      ],
      grants: { toolIds: ["read_metadata", "request_input"], modelRoles: ["main"] },
      budgets: { maxModelCalls: 3, maxToolCalls: 2 },
    });
    const handle = rt.start("Read metadata and ask which month", start);
    const collected = events(handle);
    await vi.waitFor(() => expect(handle.state).toBe("awaiting_input"));
    const pending = handle.pendingInput;
    if (!pending) throw new Error("Expected pending question");
    expect(pending.runId).toBe(handle.runId);
    expect(fixture.requests).toHaveLength(2);
    let terminal = false;
    void handle.result().then(() => {
      terminal = true;
    });
    await Promise.resolve();
    expect(terminal).toBe(false);
    await expect(handle.reply("wrong-run:question", "September")).rejects.toMatchObject({ code: "input_mismatch" });
    expect(fixture.requests).toHaveLength(2);
    await handle.reply(pending.id, "September");
    await expect(handle.reply(pending.id, "again")).rejects.toMatchObject({ code: "input_already_resolved" });
    expect(await handle.result()).toMatchObject({
      status: "completed",
      runId: handle.runId,
      usage: { totalTokens: 9 },
    });
    expect(effect).toHaveBeenCalledOnce();
    const continuation = fixture.requests[2];
    expect(continuation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "tool", toolCallId: "metadata", content: '{"rows":42}' }),
        expect.objectContaining({ role: "assistant", providerExtras: { opaque: "metadata" } }),
        expect.objectContaining({ role: "assistant", providerExtras: { opaque: "question" } }),
        expect.objectContaining({
          role: "tool",
          toolCallId: "question",
          content: expect.stringContaining("September"),
        }),
      ]),
    );
    const emitted = await collected;
    expect(emitted.filter((event) => event.payload.type === "run.terminal")).toHaveLength(1);
    expect(
      emitted
        .filter((event) => ["input.requested", "input.resolved", "run.resumed"].includes(event.payload.type))
        .map((event) => event.payload.type),
    ).toEqual(["input.requested", "input.resolved", "run.resumed"]);
    expect(handle.state).toBe("finished");
    await expect(handle.send("late", { mode: "steer" })).rejects.toMatchObject({ code: "run_finished" });
  });

  it("applies FIFO steering after the entire tool batch and executes effects once", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const effect = vi.fn(async () => {
      await held;
      return "observed";
    });
    const fixture = scripted([
      {
        ...call("one", "lookup"),
        message: {
          ...call("one", "lookup").message,
          toolCalls: [
            { id: "one", name: "lookup", arguments: {} },
            { id: "two", name: "lookup", arguments: {} },
          ],
        },
      },
      answer("filtered report"),
    ]);
    const rt = new HarnessRuntime({
      driver: agentDriver({ name: "steered", model: fixture.model }, { stream }),
      tools: [{ name: "lookup", description: "lookup", parameters: z.object({}), execute: effect }],
      grants: { toolIds: ["lookup"], modelRoles: ["main"] },
    });
    const handle = rt.start("report", start);
    await vi.waitFor(() => expect(effect).toHaveBeenCalledTimes(2));
    await handle.send("only last month", { mode: "steer" });
    await handle.send("include totals", { mode: "steer" });
    expect(fixture.requests).toHaveLength(1);
    release();
    expect((await handle.result()).status).toBe("completed");
    expect(fixture.requests[1].slice(-4).map((message) => [message.role, message.content])).toEqual([
      ["tool", "observed"],
      ["tool", "observed"],
      ["user", "only last month"],
      ["user", "include totals"],
    ]);
    expect(effect).toHaveBeenCalledTimes(2);
    const emitted = await events(handle);
    const received = emitted.flatMap(({ payload }) => (payload.type === "input.received" ? [payload.inputId] : []));
    const applied = emitted.flatMap(({ payload }) => (payload.type === "input.applied" ? [payload.inputId] : []));
    expect(applied).toEqual(received);
    expect(applied).toHaveLength(2);
  });

  it("keeps voluntary standalone commentary nonterminal and exposes public item lifecycles", async () => {
    const fixture = scripted([answer("I will check the data.", "commentary"), answer("The report is ready.", "final")]);
    const rt = new HarnessRuntime({
      driver: agentDriver({ name: "communicator", model: fixture.model }, { stream }),
      grants: { toolIds: [], modelRoles: ["main"] },
      budgets: { maxModelCalls: 2 },
    });
    const handle = rt.start("report", start);
    expect((await handle.result()).status).toBe("completed");
    const payloads = (await events(handle)).map((event) => event.payload);
    const completed = payloads.flatMap((payload) => (payload.type === "message.completed" ? [payload.message] : []));
    expect(completed.map((item) => item.phase)).toEqual(["commentary", "final"]);
    for (const item of completed) {
      expect(payloads).toContainEqual(expect.objectContaining({ type: "message.started", id: item.id }));
      expect(payloads).toContainEqual({ type: "message.delta", id: item.id, text: item.text });
    }
    expect(fixture.requests).toHaveLength(2);
  });
});

describe("input clocks and cleanup", () => {
  it("uses remaining active time after a wait rather than resetting the timeout", async () => {
    vi.useFakeTimers();
    try {
      const handle = custom(
        async (_request, services) => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          await services.requestInput({ question: "Continue?" });
          await new Promise((resolve) => setTimeout(resolve, 70));
          return { text: "too late" };
        },
        { activeTimeoutMs: 100 },
      ).start("start", start);
      await vi.advanceTimersByTimeAsync(40);
      expect(handle.state).toBe("awaiting_input");
      await vi.advanceTimersByTimeAsync(500);
      await handle.reply(handle.pendingInput?.id ?? "", "yes");
      await vi.advanceTimersByTimeAsync(70);
      expect(await handle.result()).toMatchObject({ status: "cancelled", reason: { code: "active_timeout" } });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid, duplicate, and stale replies while leaving the current question pending", async () => {
    const handle = custom(async (_request, services) => {
      await services.requestInput({ question: "First?" });
      const reply = await services.requestInput({ question: "Second?" });
      return { text: String(reply.input) };
    }).start("start", start);
    await vi.waitFor(() => expect(handle.pendingInput).toBeDefined());
    const first = handle.pendingInput?.id ?? "";
    await expect(handle.reply(first, "x".repeat(65537))).rejects.toMatchObject({ code: "invalid_input" });
    expect(handle.pendingInput?.id).toBe(first);
    await handle.reply(first, "first");
    await vi.waitFor(() => expect(handle.pendingInput?.question).toBe("Second?"));
    const second = handle.pendingInput?.id ?? "";
    expect(second).not.toBe(first);
    await expect(handle.reply(first, "stale")).rejects.toMatchObject({ code: "input_already_resolved" });
    expect(handle.pendingInput?.id).toBe(second);
    await handle.reply(second, "second");
    expect(await handle.result()).toMatchObject({ text: "second", status: "completed" });
  });

  it("excludes waiting from active timeout and keeps an independent input timeout", async () => {
    vi.useFakeTimers();
    try {
      const handle = custom(
        async (_request, services) => {
          const reply = await services.requestInput({ question: "Continue?" });
          return { text: String(reply.input) };
        },
        { activeTimeoutMs: 100, inputTimeoutMs: 1000 },
      ).start("start", start);
      await vi.advanceTimersByTimeAsync(0);
      expect(handle.state).toBe("awaiting_input");
      await vi.advanceTimersByTimeAsync(500);
      expect(handle.state).toBe("awaiting_input");
      const id = handle.pendingInput?.id;
      if (!id) throw new Error("Expected question");
      await handle.reply(id, "yes");
      expect((await handle.result()).status).toBe("completed");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["cancel", "input_timeout", "deadline_exceeded"] as const)("settles once while waiting: %s", async (mode) => {
    vi.useFakeTimers();
    try {
      const handle = custom(
        async (_request, services) => {
          await services.requestInput({ question: "Continue?" });
          return { text: "should not run" };
        },
        { inputTimeoutMs: 100 },
      ).start("start", { ...start, ...(mode === "deadline_exceeded" ? { deadline: Date.now() + 50 } : {}) });
      await vi.advanceTimersByTimeAsync(0);
      expect(handle.state).toBe("awaiting_input");
      const id = handle.pendingInput?.id ?? "";
      if (mode === "cancel") handle.cancel();
      else await vi.advanceTimersByTimeAsync(100);
      expect(await handle.result()).toMatchObject({
        status: "cancelled",
        reason: { code: mode === "cancel" ? "cancelled" : mode },
      });
      await expect(handle.reply(id, "late")).rejects.toMatchObject({ code: "run_finished" });
      expect((await events(handle)).filter((event) => event.payload.type === "run.terminal")).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reset the remaining model budget after input", async () => {
    const fixture = scripted([call("ask", "request_input", { question: "Which month?" }), answer("unreachable")]);
    const handle = new HarnessRuntime({
      driver: agentDriver({ name: "budget", model: fixture.model }),
      tools: [requestInputTool()],
      grants: { toolIds: ["request_input"], modelRoles: ["main"] },
      budgets: { maxModelCalls: 1 },
    }).start("report", start);
    await vi.waitFor(() => expect(handle.pendingInput).toBeDefined());
    await handle.reply(handle.pendingInput?.id ?? "", "September");
    expect((await handle.result()).status).toBe("stopped");
    expect(fixture.requests).toHaveLength(1);
  });
});

it("rejects steering while the completion policy finalizes an already closed Agent loop", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const evaluate = vi.fn(async () => {
    await held;
    return { action: "accept" as const, reason: "done" };
  });
  const fixture = scripted([answer("done")]);
  const handle = new HarnessRuntime({
    driver: agentDriver({ name: "complete", model: fixture.model }),
    grants: { toolIds: [], modelRoles: ["main"] },
    completionPolicy: { id: "held", evaluate },
  }).start("start", start);
  await vi.waitFor(() => expect(evaluate).toHaveBeenCalledOnce());
  await expect(handle.send("too late", { mode: "steer" })).rejects.toMatchObject({ code: "run_finished" });
  release();
  expect((await handle.result()).status).toBe("completed");
});

it("emits a correlated compaction failure when the shared model budget is exhausted", async () => {
  const task = scripted([answer("unreachable")]);
  const summary = scripted([answer("unreachable")]);
  const history: ChatMessage[] = [
    { role: "user", content: "old ".repeat(2000) },
    { role: "assistant", content: "old" },
    { role: "user", content: "current" },
  ];
  const handle = custom(
    async (_request, services) => {
      await services.model(task.model, history);
      return { text: "unreachable" };
    },
    {
      grants: { toolIds: [], modelRoles: ["main", "summary"] },
      models: { summary: { provider: summary.model, options: ["maxTokens"] } },
      contextPolicy: summaryContextPolicy({ modelRole: "summary", maxContextTokens: 400 }),
      budgets: { maxModelCalls: 1 },
    },
  ).start("start", start);
  expect(await handle.result()).toMatchObject({ status: "stopped" });
  expect(task.requests).toHaveLength(0);
  expect(summary.requests).toHaveLength(0);
  const payloads = (await events(handle)).map((event) => event.payload);
  const began = payloads.find((event) => event.type === "compaction.started");
  if (began?.type !== "compaction.started") throw new Error("Missing compaction event");
  expect(payloads).toContainEqual(
    expect.objectContaining({ type: "compaction.failed", compactionId: began.compactionId }),
  );
  expect(payloads.some((event) => event.type === "compaction.completed")).toBe(false);
});

it("compacts completed rounds of one task while preserving the task and newest opaque group", async () => {
  const history: ChatMessage[] = [
    { role: "system", content: "Host instructions" },
    { role: "user", content: "Produce the original report" },
    call("old", "lookup").message,
    { role: "tool", toolCallId: "old", content: "old observations ".repeat(1500) },
    call("new", "lookup").message,
    { role: "tool", toolCallId: "new", content: "new observations" },
  ];
  const task = scripted([answer("done")]);
  const summarizer = scripted([answer("Earlier lookup found the required rows.")]);
  const rt = custom(
    async (_request, services) => {
      await services.model(task.model, history);
      return { text: "done" };
    },
    {
      grants: { toolIds: [], modelRoles: ["main", "summary"] },
      models: { summary: { provider: summarizer.model, options: ["maxTokens"] } },
      contextPolicy: summaryContextPolicy({ modelRole: "summary", maxContextTokens: 400, grouping: "tool_roundtrip" }),
      budgets: { maxModelCalls: 2 },
    },
  );
  const handle = rt.start("report", start);
  expect(await handle.result()).toMatchObject({ status: "completed", usage: { totalTokens: 6 } });
  expect(task.requests[0]).toContainEqual(history[1]);
  expect(task.requests[0]).toContainEqual(history[4]);
  expect(task.requests[0]).toContainEqual(history[5]);
  expect(task.requests[0]).not.toContainEqual(history[2]);
  expect(JSON.stringify(summarizer.requests)).not.toContain('"opaque"');
  const payloads = (await events(handle)).map((event) => event.payload);
  const started = payloads.find((event) => event.type === "compaction.started");
  if (started?.type !== "compaction.started") throw new Error("Expected compaction");
  expect(payloads).toContainEqual(
    expect.objectContaining({ type: "compaction.completed", compactionId: started.compactionId }),
  );
});
