import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";
import { Agent } from "../../agent/agent.js";
import type { RunContext } from "../../agent/run-context.js";
import { CostTracker } from "../../cost/cost-tracker.js";
import type { ModelProvider } from "../../models/provider.js";
import type { ChatMessage, ModelResponse, ToolCall } from "../../models/types.js";
import { InMemoryStorage } from "../../storage/in-memory.js";
import type { ToolDef } from "../../tools/types.js";
import { type HandoffResult, HandoffSignal } from "../types.js";

const usage = { promptTokens: 2, completionTokens: 1, totalTokens: 3 };
const options = { sessionId: "conversation", tenantId: "tenant", userId: "actor" };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const transfer = (agent: string, id = "transfer"): ToolCall => ({
  id,
  name: "transfer_to_agent",
  arguments: { agent, reason: "needs a specialist" },
});
const answer = (text = "done"): ModelResponse => ({
  message: { role: "assistant", content: text },
  usage,
  finishReason: "stop",
  raw: {},
});
const tools = (...calls: ToolCall[]): ModelResponse => ({
  message: { role: "assistant", content: null, toolCalls: calls, providerExtras: { opaque: "source-only" } },
  usage,
  finishReason: "tool_calls",
  raw: {},
});
function model(...responses: ModelResponse[]): ModelProvider {
  let index = 0;
  const generate = vi.fn<ModelProvider["generate"]>(async () => responses[index++] ?? answer());
  return {
    providerId: "fixture",
    modelId: "fixture",
    generate,
    async *stream(messages, config) {
      const response = await generate(messages, config);
      for (const call of response.message.toolCalls ?? []) {
        yield { type: "tool_call_start", toolCall: { id: call.id, name: call.name } };
        yield { type: "tool_call_delta", toolCallId: call.id, argumentsDelta: JSON.stringify(call.arguments) };
      }
      if (typeof response.message.content === "string") yield { type: "text", text: response.message.content };
      yield {
        type: "finish",
        finishReason: response.finishReason,
        usage,
        providerExtras: response.message.providerExtras,
      };
    },
  };
}
function complete(messages: readonly ChatMessage[]) {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant" || message.role === "user") expect(pending.size).toBe(0);
    for (const call of message.toolCalls ?? []) pending.add(call.id);
    if (message.role === "tool") expect(pending.delete(message.toolCallId!)).toBe(true);
  }
  expect(pending.size).toBe(0);
}
const effect = (execute: ToolDef["execute"]): ToolDef => ({
  name: "effect",
  description: "fixture",
  parameters: z.object({}),
  execute,
});

describe("public Agent handoff", () => {
  it.each([false, true])(
    "persists full source batches with memory=%s and emits one source lifecycle",
    async (memory) => {
      const targetModel = model(answer("specialist answer"));
      const costs = new CostTracker();
      const target = new Agent({ name: "specialist", model: targetModel, costTracker: costs, register: false });
      const sourceModel = model(tools(transfer(target.name)), answer("second turn"));
      const source = new Agent({
        name: "source",
        model: sourceModel,
        register: false,
        costTracker: costs,
        ...(memory ? { memory: { storage: new InMemoryStorage(), summaries: false } } : {}),
        handoff: { targets: [{ agent: target, description: "specialist" }] },
      });
      const completed = vi.fn();
      source.eventBus.on("run.complete", completed);
      const result = (await source.run("help", options)) as HandoffResult;
      expect(result.text).toBe("specialist answer");
      expect(result.handoffChain).toEqual(["source", "specialist"]);
      expect(result.finalAgent).toBe("specialist");
      expect(result.usage.totalTokens).toBe(6);
      expect(result.costs).toMatchObject({ status: "available", total: null, attemptCount: 2 });
      expect(
        (await costs.queryUsage({ tenantId: "tenant" })).items
          .filter((entry) => entry.executionStatus === "succeeded")
          .map((entry) => [entry.agentName, entry.usage.tokens?.total])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ).toEqual([
        ["source", 3],
        ["specialist", 3],
      ]);
      expect(completed).toHaveBeenCalledOnce();
      expect(targetModel.generate).toHaveBeenCalledOnce();
      complete(result.newMessages!);
      expect(result.newMessages?.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
      expect(result.newMessages?.[1].providerExtras).toEqual({ opaque: "source-only" });
      expect(vi.mocked(targetModel.generate).mock.calls[0][0].some((message) => message.providerExtras?.opaque)).toBe(
        false,
      );
      await source.run("continue", options);
      const replay = vi.mocked(sourceModel.generate).mock.calls[1][0];
      complete(replay);
      expect(replay.filter((message) => message.toolCallId === "transfer")).toHaveLength(1);
      await source.close();
      await target.close();
    },
  );

  it("waits all sibling tools, carries state/identity and combines source and target restrictions", async () => {
    const entered = deferred();
    const release = deferred();
    const contexts: RunContext[] = [];
    const targetEffect = vi.fn(async () => "unexpected");
    const targetModel = model(tools({ id: "target-effect", name: "effect", arguments: {} }), answer("restricted"));
    const target = new Agent({
      name: "target",
      model: targetModel,
      tools: [effect(targetEffect)],
      register: false,
      executionPolicy: { decide: () => ({ action: "allow" }) },
      hooks: {
        beforeRun: async (ctx) => {
          contexts.push(ctx);
        },
      },
    });
    const sourceModel = model(tools(transfer("target"), { id: "sibling", name: "effect", arguments: {} }));
    const source = new Agent({
      name: "source",
      model: sourceModel,
      register: false,
      tools: [
        effect(async (_args, ctx) => {
          ctx.setState("fact", "carried");
          entered.resolve();
          await release.promise;
          return "sibling settled";
        }),
      ],
      executionPolicy: { decide: (_call, ctx) => ({ action: ctx.metadata.agentName === "target" ? "deny" : "allow" }) },
      handoff: { targets: [{ agent: target, description: "target" }] },
    });
    const controller = new AbortController();
    const result = source.run("help", { ...options, signal: controller.signal });
    await entered.promise;
    expect(targetModel.generate).not.toHaveBeenCalled();
    release.resolve();
    const output = await result;
    complete(output.newMessages!);
    expect(targetEffect).not.toHaveBeenCalled();
    expect(contexts[0]).toMatchObject({
      userId: "actor",
      tenantId: "tenant",
      sessionId: "conversation:handoff:target",
      signal: controller.signal,
      sessionState: { fact: "carried" },
      metadata: { parentRunId: output.runId, rootRunId: output.runId },
    });
    expect(contexts[0].runId).not.toBe(output.runId);
    await source.close();
    await target.close();
  });

  it.each(["policy", "approval", "plan"])("denied transfer (%s) never enters the target", async (denial) => {
    const targetModel = model(answer());
    const target = new Agent({ name: "target", model: targetModel, register: false });
    const source = new Agent({
      name: "source",
      model: model(tools(transfer("target")), answer("denied")),
      register: false,
      ...(denial === "policy" ? { executionPolicy: { decide: () => ({ action: "deny" as const }) } } : {}),
      ...(denial === "approval"
        ? { approval: { policy: "all" as const, onApproval: async () => ({ approved: false }) } }
        : {}),
      handoff: { targets: [{ agent: target, description: "target" }] },
    });
    const output = await source.run("help", { ...options, runMode: denial === "plan" ? "plan" : "execute" });
    expect(targetModel.generate).not.toHaveBeenCalled();
    expect(output.toolCalls[0].denial).toBeDefined();
    complete(output.newMessages!);
    await source.close();
    await target.close();
  });

  it("preserves both target and inherited approval dispatchers", async () => {
    const inherited = vi.fn(async () => ({ approved: true }));
    const local = vi.fn(async () => ({ approved: false }));
    const execute = vi.fn(async () => "unexpected");
    const target = new Agent({
      name: "target",
      model: model(tools({ id: "effect", name: "effect", arguments: {} }), answer("denied")),
      tools: [effect(execute)],
      approval: { policy: "all", onApproval: local },
      register: false,
    });
    const source = new Agent({
      name: "source",
      model: model(tools(transfer("target"))),
      register: false,
      approval: { policy: "all", onApproval: inherited },
      handoff: { targets: [{ agent: target, description: "target" }] },
    });
    await source.run("help", options);
    expect(inherited).toHaveBeenCalledOnce();
    expect(local).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(local).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant", userId: "actor", agentName: "target" }),
    );
    await source.close();
    await target.close();
  });

  it("source approval dispatcher reaches target tools without a target dispatcher", async () => {
    const execute = vi.fn(async () => "unexpected");
    const approval = vi.fn(async (request: { agentName: string }) => ({ approved: request.agentName === "source" }));
    const target = new Agent({
      name: "target",
      model: model(tools({ id: "effect", name: "effect", arguments: {} }), answer("denied")),
      tools: [effect(execute)],
      register: false,
    });
    const source = new Agent({
      name: "source",
      model: model(tools(transfer("target"))),
      register: false,
      approval: { policy: "all", onApproval: approval },
      handoff: { targets: [{ agent: target, description: "target" }] },
    });
    await source.run("help", options);
    expect(approval).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
    await source.close();
    await target.close();
  });

  it.each(["sibling failure", "multiple transfers"])("settles ambiguous/failed batches: %s", async (scenario) => {
    const targetModel = model(answer());
    const target = new Agent({ name: "target", model: targetModel, register: false });
    const second =
      scenario === "multiple transfers"
        ? transfer("target", "transfer2")
        : { id: "effect", name: "effect", arguments: {} };
    const source = new Agent({
      name: "source",
      model: model(tools(transfer("target"), second), answer("blocked")),
      register: false,
      tools: [
        effect(async () => {
          throw new Error("sibling failed");
        }),
      ],
      handoff: { targets: [{ agent: target, description: "target" }] },
    });
    const output = await source.run("help", options);
    expect(targetModel.generate).not.toHaveBeenCalled();
    expect(output.toolCalls[0].error).toMatch(/Multiple handoffs|another tool/);
    complete(output.newMessages!);
    await source.close();
    await target.close();
  });

  it.each([false, true])(
    "cancellation with input hooks=%s settles siblings and preserves closed source history",
    async (hooks) => {
      const entered = deferred();
      const release = deferred();
      const abort = new AbortController();
      const targetModel = model(answer());
      const target = new Agent({ name: "target", model: targetModel, register: false });
      const sourceModel = model(
        tools(transfer("target"), { id: "effect", name: "effect", arguments: {} }),
        answer("next"),
      );
      const source = new Agent({
        name: "source",
        model: sourceModel,
        register: false,
        ...(hooks
          ? { loopHooks: { beforeLLMCall: async (messages: ChatMessage[]) => structuredClone(messages) } }
          : {}),
        tools: [
          effect(async () => {
            entered.resolve();
            await release.promise;
            return "settled";
          }),
        ],
        handoff: { targets: [{ agent: target, description: "target" }] },
      });
      let settled = false;
      const result = source.run("help", { ...options, signal: abort.signal }).then((output) => {
        settled = true;
        return output;
      });
      await entered.promise;
      abort.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(targetModel.generate).not.toHaveBeenCalled();
      release.resolve();
      expect((await result).status).toBe("cancelled");
      await source.run("continue", options);
      const history = vi.mocked(sourceModel.generate).mock.calls[1][0];
      complete(history);
      expect(history.filter((message) => message.role === "tool")).toHaveLength(2);
      expect(targetModel.generate).not.toHaveBeenCalled();
      await source.close();
      await target.close();
    },
  );

  it("mandatory ask cannot be satisfied solely by a target's permissive dispatcher", async () => {
    const parentApproval = vi.fn(async (request: { agentName: string }) => ({
      approved: request.agentName === "source",
    }));
    const targetApproval = vi.fn(async () => ({ approved: true }));
    const execute = vi.fn(async () => "unexpected");
    const target = new Agent({
      name: "target",
      model: model(tools({ id: "effect", name: "effect", arguments: {} }), answer()),
      tools: [effect(execute)],
      register: false,
      approval: { policy: "none", onApproval: targetApproval },
    });
    const source = new Agent({
      name: "source",
      model: model(tools(transfer("target"))),
      register: false,
      executionPolicy: { decide: () => ({ action: "ask" }) },
      approval: { policy: "none", onApproval: parentApproval },
      handoff: { targets: [{ agent: target, description: "target" }] },
    });
    await source.run("help", options);
    expect(targetApproval).toHaveBeenCalledOnce();
    expect(parentApproval).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
    await source.close();
    await target.close();
  });

  it("rejects cycles across independently configured real Agents", async () => {
    const returned = vi.fn();
    const sourceReference = { name: "source", run: returned } as unknown as Agent;
    const middle = new Agent({
      name: "middle",
      model: model(tools(transfer("source"))),
      register: false,
      handoff: { targets: [{ agent: sourceReference, description: "source" }] },
    });
    const source = new Agent({
      name: "source",
      model: model(tools(transfer("middle"))),
      register: false,
      handoff: { targets: [{ agent: middle, description: "middle" }] },
    });
    await expect(source.run("help", options)).rejects.toThrow("Handoff cycle detected");
    expect(returned).not.toHaveBeenCalled();
    await source.close();
    await middle.close();
  });

  it("retains a closed source turn when the target fails", async () => {
    const costs = new CostTracker();
    const targetModel = model();
    targetModel.generate = async () => {
      throw new Error("target failed");
    };
    const target = new Agent({ name: "target", model: targetModel, register: false });
    const sourceModel = model(tools(transfer("target")), answer("recovery"));
    const source = new Agent({
      name: "source",
      model: sourceModel,
      register: false,
      costTracker: costs,
      handoff: { targets: [{ agent: target, description: "target" }] },
    });
    await expect(source.run("help", options)).rejects.toThrow("target failed");
    const failedUsage = (await costs.queryUsage({ tenantId: "tenant" })).items;
    expect(
      failedUsage.filter((entry) => entry.executionStatus === "succeeded").map((entry) => entry.usage.tokens?.total),
    ).toEqual([3]);
    expect(failedUsage.some((entry) => entry.executionStatus === "failed" && entry.agentName === "target")).toBe(true);
    await source.run("continue", options);
    const messages = vi.mocked(sourceModel.generate).mock.calls[1][0];
    complete(messages);
    expect(messages.filter((message) => message.toolCallId === "transfer")).toHaveLength(1);
    await source.close();
    await target.close();
  });

  it.each(["", "transfer"])("rejects invalid batch correlation %s before effects", async (id) => {
    const targetModel = model();
    const target = new Agent({ name: "target", model: targetModel, register: false });
    const execute = vi.fn(async () => "unexpected");
    const source = new Agent({
      name: "source",
      model: model(tools(transfer("target"), { id, name: "effect", arguments: {} })),
      register: false,
      tools: [effect(execute)],
      handoff: { targets: [{ agent: target, description: "target" }] },
    });
    await expect(source.run("help", options)).rejects.toThrow("nonempty unique call IDs");
    expect(execute).not.toHaveBeenCalled();
    expect(targetModel.generate).not.toHaveBeenCalled();
    await source.close();
    await target.close();
  });

  it("concurrent tenant handoffs use the source's actual scoped approval dispatcher", async () => {
    const executed: string[] = [];
    const targetModel = model(
      tools({ id: "e1", name: "effect", arguments: {} }),
      tools({ id: "e2", name: "effect", arguments: {} }),
    );
    const target = new Agent({
      name: "target",
      model: targetModel,
      register: false,
      tools: [
        effect(async (_args, ctx) => {
          executed.push(ctx.tenantId!);
          return "done";
        }),
      ],
    });
    const source = new Agent({
      name: "source",
      model: model(tools(transfer("target")), tools(transfer("target"))),
      register: false,
      approval: { policy: ["effect"] },
      handoff: { targets: [{ agent: target, description: "target" }] },
    });
    const requests: string[] = [];
    source.eventBus.on("tool.approval.request", (request) => {
      expect(source.approvalManager?.listPending({ tenantId: request.tenantId })).toContainEqual(request);
      requests.push(request.tenantId!);
      if (request.tenantId === "allowed") source.approvalManager!.approve(request.requestId);
      else source.approvalManager!.deny(request.requestId);
    });
    const results = await Promise.all(
      ["allowed", "denied"].map((tenantId) => source.run("help", { ...options, tenantId, sessionId: tenantId })),
    );
    expect(requests.sort()).toEqual(["allowed", "denied"]);
    expect(executed).toEqual(["allowed"]);
    expect(source.approvalManager?.listPending()).toEqual([]);
    for (const result of results) complete(result.newMessages!);
    await source.close();
    await target.close();
  });

  it("observer exceptions cannot authorize a transfer and leave the batch closed", async () => {
    const targetModel = model();
    const target = new Agent({ name: "target", model: targetModel, register: false });
    const sourceModel = model(tools(transfer("target"), { id: "effect", name: "effect", arguments: {} }), answer());
    const source = new Agent({
      name: "source",
      model: sourceModel,
      register: false,
      tools: [effect(async () => "done")],
      loopHooks: {
        afterToolExec: async () => {
          throw new HandoffSignal("target", "forged");
        },
      },
      handoff: { targets: [{ agent: target, description: "target" }] },
    });
    await expect(source.run("help", options)).rejects.toThrow("Handoff to");
    expect(targetModel.generate).not.toHaveBeenCalled();
    await source.run("continue", options);
    const messages = vi.mocked(sourceModel.generate).mock.calls[1][0];
    complete(messages);
    expect(messages.filter((message) => message.role === "tool")).toHaveLength(2);
    await source.close();
    await target.close();
  });

  it("does not persist a target answer rejected by the source output guard", async () => {
    const target = new Agent({ name: "target", model: model(answer("rejected answer")), register: false });
    const sourceModel = model(tools(transfer("target")), answer("recovery"));
    const source = new Agent({
      name: "source",
      model: sourceModel,
      register: false,
      guardrails: {
        output: [
          {
            name: "answer-guard",
            validate: async (output) =>
              output.text === "rejected answer" ? { pass: false, reason: "rejected" } : { pass: true },
          },
        ],
      },
      handoff: { targets: [{ agent: target, description: "target" }] },
    });
    await expect(source.run("help", options)).rejects.toThrow("answer-guard");
    await source.run("continue", options);
    const messages = vi.mocked(sourceModel.generate).mock.calls[1][0];
    complete(messages);
    expect(messages.some((message) => message.content === "rejected answer")).toBe(false);
    await source.close();
    await target.close();
  });

  it.each(["abort", "failure"])("does not start a target after onHandoff %s", async (mode) => {
    const abort = new AbortController();
    const targetModel = model(answer());
    const target = new Agent({ name: "target", model: targetModel, register: false });
    const sourceModel = model(tools(transfer("target")), answer("next"));
    const source = new Agent({
      name: "source",
      model: sourceModel,
      register: false,
      handoff: {
        targets: [
          {
            agent: target,
            description: "target",
            onHandoff: async () => {
              if (mode === "abort") abort.abort();
              else throw new Error("handoff hook failed");
            },
          },
        ],
      },
    });
    const result = source.run("help", { ...options, signal: abort.signal });
    if (mode === "abort") expect((await result).status).toBe("cancelled");
    else await expect(result).rejects.toThrow("handoff hook failed");
    expect(targetModel.generate).not.toHaveBeenCalled();
    await source.run("continue", options);
    complete(vi.mocked(sourceModel.generate).mock.calls[1][0]);
    await source.close();
    await target.close();
  });

  it.each([1, 2])("chains real Agents within the inherited hop limit %s", async (maxHandoffs) => {
    const finalModel = model(answer("final"));
    const final = new Agent({ name: "final", model: finalModel, register: false });
    const middle = new Agent({
      name: "middle",
      model: model(tools(transfer("final"))),
      register: false,
      handoff: { targets: [{ agent: final, description: "final" }] },
    });
    const source = new Agent({
      name: "source",
      model: model(tools(transfer("middle"))),
      register: false,
      handoff: { maxHandoffs, targets: [{ agent: middle, description: "middle" }] },
    });
    if (maxHandoffs === 1) {
      await expect(source.run("help", options)).rejects.toThrow("Maximum handoffs");
      expect(finalModel.generate).not.toHaveBeenCalled();
    } else {
      const output = (await source.run("help", options)) as HandoffResult;
      expect(output.handoffChain).toEqual(["source", "middle", "final"]);
      expect(output.usage.totalTokens).toBe(9);
      expect(output.finalAgent).toBe("final");
      complete(output.newMessages!);
    }
    await source.close();
    await middle.close();
    await final.close();
  });

  it("streams the target after settling its complete batch", async () => {
    const targetModel = model(answer());
    const target = new Agent({ name: "target", model: targetModel, register: false });
    const execute = vi.fn(async () => "sibling done");
    const source = new Agent({
      name: "source",
      model: model(tools(transfer("target"), { id: "effect", name: "effect", arguments: {} })),
      tools: [effect(execute)],
      register: false,
      handoff: { targets: [{ agent: target, description: "target" }] },
    });
    const text: string[] = [];
    for await (const chunk of source.stream("help", options)) if (chunk.type === "text") text.push(chunk.text);
    expect(text).toEqual(["done"]);
    expect(execute).toHaveBeenCalledOnce();
    expect(targetModel.generate).toHaveBeenCalledOnce();
    await source.close();
    await target.close();
  });
});
