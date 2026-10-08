import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";
import { Agent } from "../../agent/agent.js";
import type { RunContext } from "../../agent/run-context.js";
import type { RunOutput } from "../../agent/types.js";
import { CostTracker } from "../../cost/cost-tracker.js";
import type { ModelProvider } from "../../models/provider.js";
import type { ChatMessage, ModelResponse, StreamChunk, ToolCall } from "../../models/types.js";
import type { ToolDef } from "../../tools/types.js";
import { HandoffSignal } from "../types.js";

const usage = { promptTokens: 2, completionTokens: 1, totalTokens: 3, cachedTokens: 1 };
const scopes = { sessionId: "conversation", userId: "actor", tenantId: "tenant" };
const transfer = (name: string, id = "transfer"): ToolCall => ({
  id,
  name: "transfer_to_agent",
  arguments: { agent: name, reason: "specialist" },
});
const call = (id = "effect"): ToolCall => ({ id, name: "effect", arguments: {} });
const response = (content: string | null, calls?: ToolCall[]): ModelResponse => ({
  message: {
    role: "assistant",
    content,
    ...(calls ? { toolCalls: calls } : {}),
    providerExtras: { opaque: "private-envelope" },
  },
  usage,
  finishReason: calls ? "tool_calls" : "stop",
  raw: {},
});
const wait = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function model(...replies: ModelResponse[]): ModelProvider {
  let index = 0;
  const generated = vi.fn<ModelProvider["generate"]>(async () => replies[index++] ?? response("done"));
  return {
    providerId: "fixture",
    modelId: "fixture",
    generate: generated,
    async *stream(messages, options) {
      const output = await generated(messages, options);
      if (typeof output.message.content === "string") yield { type: "text", text: output.message.content };
      for (const toolCall of output.message.toolCalls ?? []) {
        yield { type: "tool_call_start", toolCall: { id: toolCall.id, name: toolCall.name } };
        yield { type: "tool_call_delta", toolCallId: toolCall.id, argumentsDelta: JSON.stringify(toolCall.arguments) };
      }
      yield {
        type: "finish",
        finishReason: output.finishReason,
        usage: output.usage,
        providerExtras: output.message.providerExtras,
      };
    },
  };
}
function closed(messages: readonly ChatMessage[]) {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool") expect(pending.size).toBe(0);
    for (const toolCall of message.toolCalls ?? []) pending.add(toolCall.id);
    if (message.role === "tool") expect(pending.delete(message.toolCallId ?? "")).toBe(true);
  }
  expect(pending.size).toBe(0);
}
const tool = (execute: ToolDef["execute"]): ToolDef => ({
  name: "effect",
  description: "fixture effect",
  parameters: z.object({}),
  execute,
});
const agents: Agent[] = [];
const agent = (config: ConstructorParameters<typeof Agent>[0]) => {
  const value = new Agent({ ...config, register: false });
  agents.push(value);
  return value;
};
afterEach(async () => {
  await Promise.all(agents.splice(0).map((value) => value.close()));
});
async function consume(source: Agent, options: Parameters<Agent["stream"]>[1] = scopes) {
  const text: string[] = [];
  for await (const chunk of source.stream("help", options)) if (chunk.type === "text") text.push(chunk.text);
  return text.join("");
}

describe("streaming handoff", () => {
  it("keeps target chunks live, canonical source/target batches and per-model costs", async () => {
    const entered = wait(),
      release = wait();
    const costs = new CostTracker();
    const targetModel = model(response(null, [call("target-effect")]), response("target answer"));
    const targetMessages: ChatMessage[][] = [];
    const target = agent({
      name: "target",
      instructions: "target authority",
      model: {
        ...targetModel,
        async *stream(messages, options) {
          targetMessages.push(structuredClone(messages));
          for await (const chunk of targetModel.stream(messages, options)) {
            yield chunk;
            if (chunk.type === "text") {
              entered.resolve();
              await release.promise;
            }
          }
        },
      },
      costTracker: costs,
      tools: [tool(async () => "target result")],
    });
    const sourceModel = model(
      response("source preface", [transfer("target"), call("source-effect")]),
      response("next"),
    );
    const source = agent({
      name: "source",
      instructions: "source authority",
      model: sourceModel,
      costTracker: costs,
      tools: [tool(async () => "source result")],
      handoff: { targets: [{ agent: target, description: "target" }] },
    });
    const outputs: RunOutput[] = [];
    source.eventBus.on("run.complete", (event) => {
      outputs.push(event.output);
    });
    const iterator = source.stream("help", { ...scopes, apiKey: "source-only-fixture" });
    const chunks: StreamChunk[] = [];
    while (true) {
      const next = await iterator.next();
      if (next.done) throw new Error("Expected live target text");
      chunks.push(next.value);
      if (next.value.type === "text" && next.value.text === "target answer") break;
    }
    expect(outputs).toHaveLength(0);
    const next = iterator.next();
    await entered.promise;
    release.resolve();
    await next;
    expect(chunks.filter((chunk) => chunk.type === "text").map((chunk) => chunk.text)).toEqual([
      "source preface",
      "target answer",
    ]);
    while (!(await iterator.next()).done) {
      /* finish */
    }
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({
      text: "source prefacetarget answer",
      handoffChain: ["source", "target"],
      finalAgent: "target",
      usage: { totalTokens: 9, cachedTokens: 3 },
    });
    closed(outputs[0].newMessages ?? []);
    expect(
      outputs[0].newMessages?.filter((message) => message.role === "tool").map((message) => message.toolCallId),
    ).toEqual(["transfer", "source-effect", "target-effect"]);
    expect(targetMessages[0].filter((message) => message.role === "system").map((message) => message.content)).toEqual([
      "target authority",
    ]);
    expect(targetMessages[0].filter((message) => message.role === "user")).toHaveLength(1);
    expect(targetMessages[0].some((message) => message.toolCallId === "transfer")).toBe(true);
    expect(targetMessages[0].some((message) => message.providerExtras)).toBe(false);
    closed(targetMessages[0]);
    expect(vi.mocked(targetModel.generate).mock.calls[0][1]?.apiKey).toBeUndefined();
    const charged = (await costs.queryUsage({ tenantId: "tenant" })).items.filter(
      (entry) => entry.executionStatus === "succeeded",
    );
    expect(
      charged
        .map((entry) => [entry.agentName, entry.usage.tokens?.total])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ["source", 3],
      ["target", 3],
      ["target", 3],
    ]);
    expect((await costs.queryCosts({ tenantId: "tenant" })).total).toBeNull(); // Bare mock usage has no billing contract.
    await source.run("continue", scopes);
    const replay = vi.mocked(sourceModel.generate).mock.calls[1][0];
    closed(replay);
    expect(replay.filter((message) => message.toolCallId === "target-effect")).toHaveLength(1);
  });

  it.each(["policy", "approval", "plan"])("denied %s transfer never starts a target", async (reason) => {
    const targetModel = model();
    const target = agent({ name: "target", model: targetModel });
    const source = agent({
      name: "source",
      model: model(response(null, [transfer("target")]), response("denied")),
      ...(reason === "policy" ? { executionPolicy: { decide: () => ({ action: "deny" as const }) } } : {}),
      ...(reason === "approval"
        ? { approval: { policy: "all" as const, onApproval: async () => ({ approved: false }) } }
        : {}),
      handoff: { targets: [{ agent: target, description: "target" }] },
    });
    expect(await consume(source, { ...scopes, runMode: reason === "plan" ? "plan" : "execute" })).toBe("denied");
    expect(targetModel.generate).not.toHaveBeenCalled();
  });

  it("retains target and inherited authority, state, identities and scoped approvals", async () => {
    const contexts: RunContext[] = [];
    const execute = vi.fn(async () => "unexpected");
    const approvals = vi.fn(async (request: { agentName: string }) => ({ approved: request.agentName === "source" }));
    const targetApproval = vi.fn(async () => ({ approved: true }));
    const target = agent({
      name: "target",
      model: model(response(null, [call()]), response("denied")),
      tools: [tool(execute)],
      approval: { policy: "none", onApproval: targetApproval },
      hooks: {
        beforeRun: async (ctx) => {
          contexts.push(ctx);
        },
      },
    });
    const controller = new AbortController();
    const source = agent({
      name: "source",
      model: model(response(null, [transfer("target"), call("sibling")])),
      tools: [
        tool(async (_args, ctx) => {
          ctx.setState("fact", "carried");
          return "ok";
        }),
      ],
      executionPolicy: { decide: () => ({ action: "ask" }) },
      approval: { policy: "none", onApproval: approvals },
      handoff: { targets: [{ agent: target, description: "target" }] },
    });
    const start = vi.fn();
    source.eventBus.on("run.start", start);
    await consume(source, { ...scopes, signal: controller.signal });
    expect(execute).not.toHaveBeenCalled();
    expect(targetApproval).toHaveBeenCalledOnce();
    expect(approvals).toHaveBeenCalledTimes(3);
    expect(contexts[0]).toMatchObject({
      sessionId: "conversation:handoff:target",
      userId: "actor",
      tenantId: "tenant",
      signal: controller.signal,
      sessionState: { fact: "carried" },
      metadata: { parentRunId: start.mock.calls[0][0].runId, rootRunId: start.mock.calls[0][0].runId },
    });
    expect(source.approvalManager?.listPending()).toEqual([]);
  });

  it("settles pending sibling effects before cancellation or transfer and persists closed history", async () => {
    const entered = wait(),
      release = wait(),
      abort = new AbortController();
    const targetModel = model();
    const target = agent({ name: "target", model: targetModel });
    const sourceModel = model(response(null, [transfer("target"), call()]), response("recovered"));
    const source = agent({
      name: "source",
      model: sourceModel,
      tools: [
        tool(async () => {
          entered.resolve();
          await release.promise;
          return "done";
        }),
      ],
      handoff: { targets: [{ agent: target, description: "target" }] },
    });
    let settled = false;
    const running = consume(source, { ...scopes, signal: abort.signal }).finally(() => {
      settled = true;
    });
    const failure = expect(running).rejects.toThrow();
    await entered.promise;
    abort.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release.resolve();
    await failure;
    expect(targetModel.generate).not.toHaveBeenCalled();
    await source.run("continue", scopes);
    const history = vi.mocked(sourceModel.generate).mock.calls[1][0];
    closed(history);
    expect(history.filter((message) => message.role === "tool")).toHaveLength(2);
  });

  it("consumer return closes target iterator, preserves source batch, and avoids success events", async () => {
    let targetClosed = 0;
    const target = agent({
      name: "target",
      model: {
        providerId: "fixture",
        modelId: "fixture",
        generate: vi.fn(),
        async *stream() {
          try {
            yield { type: "text", text: "partial" };
            yield { type: "text", text: "unread" };
          } finally {
            targetClosed++;
          }
        },
      },
    });
    const sourceModel = model(response(null, [transfer("target")]), response("recovered"));
    const source = agent({
      name: "source",
      model: sourceModel,
      handoff: { targets: [{ agent: target, description: "target" }] },
    });
    const completed = vi.fn(),
      cancelled = vi.fn();
    source.eventBus.on("run.complete", completed);
    source.eventBus.on("run.cancelled", cancelled);
    const iterator = source.stream("help", scopes);
    while (true) {
      const next = await iterator.next();
      if (next.done) throw new Error("No target chunk");
      if (next.value.type === "text") break;
    }
    await iterator.return(undefined);
    expect(targetClosed).toBe(1);
    expect(completed).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledOnce();
    await source.run("continue", scopes);
    const history = vi.mocked(sourceModel.generate).mock.calls[1][0];
    closed(history);
    expect(history.some((message) => message.content === "partial")).toBe(false);
  });

  it.each([1, 2])("enforces inherited hop budget %s", async (maxHandoffs) => {
    const finalModel = model(response("final"));
    const final = agent({ name: "final", model: finalModel });
    const middle = agent({
      name: "middle",
      model: model(response(null, [transfer("final")])),
      handoff: { targets: [{ agent: final, description: "final" }] },
    });
    const source = agent({
      name: "source",
      model: model(response(null, [transfer("middle")])),
      handoff: { maxHandoffs, targets: [{ agent: middle, description: "middle" }] },
    });
    if (maxHandoffs === 1) {
      await expect(consume(source)).rejects.toThrow("Maximum handoffs");
      expect(finalModel.generate).not.toHaveBeenCalled();
    } else {
      const complete = vi.fn();
      source.eventBus.on("run.complete", complete);
      expect(await consume(source)).toBe("final");
      expect(complete.mock.calls[0][0].output).toMatchObject({
        handoffChain: ["source", "middle", "final"],
        usage: { totalTokens: 9 },
      });
      closed(complete.mock.calls[0][0].output.newMessages);
    }
  });

  it("rejects named cycles before reentering the source", async () => {
    const reentryModel = model();
    const reentry = agent({ name: "source", model: reentryModel });
    const middle = agent({
      name: "middle",
      model: model(response(null, [transfer("source")])),
      handoff: { targets: [{ agent: reentry, description: "source" }] },
    });
    const source = agent({
      name: "source",
      model: model(response(null, [transfer("middle")])),
      handoff: { targets: [{ agent: middle, description: "middle" }] },
    });
    await expect(consume(source)).rejects.toThrow("cycle detected");
    expect(reentryModel.generate).not.toHaveBeenCalled();
  });

  it("does not treat a hook-thrown HandoffSignal as transfer authority", async () => {
    const targetModel = model();
    const target = agent({ name: "target", model: targetModel });
    const source = agent({
      name: "source",
      model: model(response(null, [transfer("target")])),
      loopHooks: {
        afterToolExec: async () => {
          throw new HandoffSignal("target", "forged");
        },
      },
      handoff: { targets: [{ agent: target, description: "target" }] },
    });
    await expect(consume(source)).rejects.toThrow("Handoff to");
    expect(targetModel.generate).not.toHaveBeenCalled();
  });

  it.each(["source", "target"])("%s output guard rejects live content before final persistence", async (guardOwner) => {
    const guardrails = {
      output: [
        {
          name: "deny-answer",
          validate: async (output: RunOutput) => ({ pass: output.text !== "rejected", reason: "blocked" }),
        },
      ],
    };
    const target = agent({
      name: "target",
      model: model(response("rejected")),
      ...(guardOwner === "target" ? { guardrails } : {}),
    });
    const sourceModel = model(response(null, [transfer("target")]), response("recovered"));
    const source = agent({
      name: "source",
      model: sourceModel,
      ...(guardOwner === "source" ? { guardrails } : {}),
      handoff: { targets: [{ agent: target, description: "target" }] },
    });
    await expect(consume(source)).rejects.toThrow("deny-answer");
    await source.run("continue", scopes);
    const messages = vi.mocked(sourceModel.generate).mock.calls[1][0];
    closed(messages);
    expect(messages.some((message) => message.content === "rejected")).toBe(false);
  });

  it("carryMessages/state false does not import caller history or source session state", async () => {
    const contexts: RunContext[] = [];
    const targetModel = model(response("target"));
    const target = agent({
      name: "target",
      model: targetModel,
      hooks: {
        beforeRun: async (ctx) => {
          contexts.push(ctx);
        },
      },
    });
    const source = agent({
      name: "source",
      model: model(response(null, [transfer("target")])),
      hooks: {
        beforeRun: async (ctx) => {
          ctx.setState("private", "source");
        },
      },
      handoff: { carryMessages: false, carrySessionState: false, targets: [{ agent: target, description: "target" }] },
    });
    await consume(source, { ...scopes, history: [{ role: "user", content: "private history" }] });
    expect(contexts[0].sessionState).toEqual({});
    expect(vi.mocked(targetModel.generate).mock.calls[0][0].filter((message) => message.role !== "assistant")).toEqual([
      { role: "user", content: "help" },
    ]);
  });
});

it("target cancellation waits for its sibling effect and carries the closed target batch back", async () => {
  const entered = wait(),
    release = wait(),
    abort = new AbortController();
  const target = agent({
    name: "target",
    model: model(response(null, [call("target-work")])),
    tools: [
      tool(async () => {
        entered.resolve();
        await release.promise;
        return "settled";
      }),
    ],
  });
  const sourceModel = model(response(null, [transfer("target")]), response("recovered"));
  const source = agent({
    name: "source",
    model: sourceModel,
    handoff: { targets: [{ agent: target, description: "target" }] },
  });
  let settled = false;
  const running = consume(source, { ...scopes, signal: abort.signal }).finally(() => {
    settled = true;
  });
  const failure = expect(running).rejects.toThrow();
  await entered.promise;
  abort.abort(new Error("cancel target"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  release.resolve();
  await failure;
  await source.run("continue", scopes);
  const history = vi.mocked(sourceModel.generate).mock.calls[1][0];
  closed(history);
  expect(history.filter((message) => message.role === "tool").map((message) => message.toolCallId)).toEqual([
    "transfer",
    "target-work",
  ]);
});

it("aborting a target's inherited approval removes only that run's pending request", async () => {
  const entered = wait(),
    abort = new AbortController();
  const effect = vi.fn(async () => "unexpected");
  const target = agent({
    name: "target",
    model: model(response(null, [call()]), response("blocked")),
    tools: [tool(effect)],
  });
  const source = agent({
    name: "source",
    model: model(response(null, [transfer("target")])),
    approval: { policy: ["effect"] },
    handoff: { targets: [{ agent: target, description: "target" }] },
  });
  source.eventBus.on("tool.approval.request", (request) => {
    expect(request.tenantId).toBe("tenant");
    entered.resolve();
  });
  const running = consume(source, { ...scopes, signal: abort.signal });
  const failure = expect(running).rejects.toThrow();
  await entered.promise;
  expect(source.approvalManager?.listPending()).toHaveLength(1);
  abort.abort();
  await failure;
  expect(source.approvalManager?.listPending()).toEqual([]);
  expect(effect).not.toHaveBeenCalled();
});

it("preserves signed provider envelopes only for the exact shared model instance", async () => {
  const shared = model(response(null, [transfer("target")]), response("target"));
  const target = agent({ name: "target", model: shared });
  const source = agent({
    name: "source",
    model: shared,
    handoff: { targets: [{ agent: target, description: "target" }] },
  });
  await consume(source);
  const targetHistory = vi.mocked(shared.generate).mock.calls[1][0];
  expect(
    targetHistory.find((message) => message.toolCalls?.some((call) => call.name === "transfer_to_agent"))
      ?.providerExtras,
  ).toEqual({ opaque: "private-envelope" });
});

it("onHandoff abort prevents any target invocation", async () => {
  const abort = new AbortController();
  const targetModel = model();
  const target = agent({ name: "target", model: targetModel });
  const source = agent({
    name: "source",
    model: model(response(null, [transfer("target")])),
    handoff: {
      targets: [
        {
          agent: target,
          description: "target",
          onHandoff: async () => {
            abort.abort();
          },
        },
      ],
    },
  });
  await expect(consume(source, { ...scopes, signal: abort.signal })).rejects.toThrow();
  expect(targetModel.generate).not.toHaveBeenCalled();
});

it("a stopped target produces a stopped source lifecycle", async () => {
  const target = agent({
    name: "target",
    model: model(response(null, [call()])),
    tools: [tool(async () => "done")],
    loopHooks: { onRoundtripComplete: async () => ({ stop: true }) },
  });
  const source = agent({
    name: "source",
    model: model(response(null, [transfer("target")])),
    handoff: { targets: [{ agent: target, description: "target" }] },
  });
  const complete = vi.fn();
  source.eventBus.on("run.complete", complete);
  await consume(source);
  expect(complete.mock.calls[0][0].output.status).toBe("stopped");
  closed(complete.mock.calls[0][0].output.newMessages);
});

it("does not substitute the target's default actor for an unidentified source", async () => {
  const contexts: RunContext[] = [];
  const target = agent({
    name: "target",
    userId: "target-default-account",
    model: model(response("done")),
    hooks: {
      beforeRun: async (ctx) => {
        contexts.push(ctx);
      },
    },
  });
  const source = agent({
    name: "source",
    model: model(response(null, [transfer("target")])),
    handoff: { targets: [{ agent: target, description: "target" }] },
  });
  await consume(source, { sessionId: "anonymous" });
  expect(contexts[0].userId).toBeUndefined();
});
