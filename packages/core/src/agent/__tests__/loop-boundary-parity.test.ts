import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";
import { CostTracker } from "../../cost/cost-tracker.js";
import { EventBus } from "../../events/event-bus.js";
import type { ModelProvider } from "../../models/provider.js";
import type { ModelResponse, StreamChunk } from "../../models/types.js";
import { defineTool } from "../../tools/define-tool.js";
import { ToolExecutor } from "../../tools/tool-executor.js";
import { Agent } from "../agent.js";
import { LLMLoop } from "../llm-loop.js";
import { RunContext } from "../run-context.js";
import type { RunOutput } from "../types.js";

const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
function model(response: () => ModelResponse): ModelProvider {
  return {
    providerId: "fixture",
    modelId: "fixture",
    generate: vi.fn(async () => response()),
    async *stream() {
      const result = response();
      if (typeof result.message.content === "string") yield { type: "text", text: result.message.content };
      for (const call of result.message.toolCalls ?? []) {
        yield { type: "tool_call_start", toolCall: { id: call.id, name: call.name } };
        yield { type: "tool_call_delta", toolCallId: call.id, argumentsDelta: JSON.stringify(call.arguments) };
      }
      yield { type: "finish", finishReason: result.finishReason, usage: result.usage };
    },
  };
}
function answer(finishReason: ModelResponse["finishReason"] = "stop"): ModelResponse {
  return { message: { role: "assistant", content: "answer" }, usage, finishReason, raw: {} };
}
function toolAnswer(): ModelResponse {
  return {
    message: { role: "assistant", content: null, toolCalls: [{ id: "call", name: "effect", arguments: {} }] },
    usage,
    finishReason: "tool_calls",
    raw: {},
  };
}
async function invoke(
  loop: LLMLoop,
  mode: "run" | "stream",
  ctx = new RunContext({ sessionId: "session", eventBus: new EventBus() }),
) {
  const messages = [{ role: "user" as const, content: "question" }];
  if (mode === "run") return loop.run(messages, ctx);
  const outcome: { status: "completed" | "stopped" } & Partial<RunOutput> = { status: "completed" };
  const chunks: StreamChunk[] = [];
  for await (const chunk of loop.stream(messages, ctx, undefined, undefined, undefined, outcome)) chunks.push(chunk);
  return {
    ...outcome,
    text: chunks
      .filter((chunk) => chunk.type === "text")
      .map((chunk) => chunk.text)
      .join(""),
  };
}

describe("loop execution boundaries", () => {
  for (const controlledExecution of [false, true]) {
    for (const mode of ["run", "stream"] as const) {
      it(`admits exactly zero or one tool batches (${controlledExecution ? "controlled" : "ordinary"} ${mode})`, async () => {
        const execute = vi.fn(async () => "effect result");
        const executor = new ToolExecutor([
          defineTool({ name: "effect", description: "effect", parameters: z.object({}), execute }),
        ]);
        const toolModel = model(toolAnswer);
        await expect(
          invoke(new LLMLoop(toolModel, executor, { maxToolRoundtrips: 0, controlledExecution }), mode),
        ).rejects.toThrow(/budget exhausted/);
        expect(execute).not.toHaveBeenCalled();
        let call = 0;
        const finalModel = model(() => (++call === 1 ? toolAnswer() : answer()));
        const output = await invoke(
          new LLMLoop(finalModel, executor, { maxToolRoundtrips: 1, controlledExecution }),
          mode,
        );
        expect(output.text).toBe("answer");
        expect(execute).toHaveBeenCalledOnce();
        expect(call).toBe(2);
        await expect(
          invoke(new LLMLoop(toolModel, executor, { maxToolRoundtrips: 1, controlledExecution }), mode),
        ).rejects.toThrow(/budget exhausted/);
        expect(execute).toHaveBeenCalledTimes(2);
        expect(
          (await invoke(new LLMLoop(model(answer), executor, { maxToolRoundtrips: 0, controlledExecution }), mode))
            .text,
        ).toBe("answer");
      });
    }
  }
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid cap %s before requests",
    (maxToolRoundtrips) => {
      const provider = model(answer);
      expect(() => new LLMLoop(provider, null, { maxToolRoundtrips })).toThrow(/nonnegative safe integer/);
      expect(provider.generate).not.toHaveBeenCalled();
    },
  );
  it.each(["run", "stream"] as const)("stops after length/filter while preserving metadata in %s", async (mode) => {
    for (const finishReason of ["length", "content_filter"] as const) {
      const output = await invoke(
        new LLMLoop(
          model(() => answer(finishReason)),
          null,
          { maxToolRoundtrips: 0 },
        ),
        mode,
      );
      expect(output).toMatchObject({
        text: "answer",
        status: "stopped",
        providerFinishReason: finishReason,
        partial: true,
        reason: { code: `provider_${finishReason}` },
      });
    }
  });
  it.each([false, true])("rejects a missing finish with partial evidence (text=%s)", async (withText) => {
    const provider: ModelProvider = {
      ...model(answer),
      async *stream() {
        if (withText) yield { type: "text", text: "partial" };
      },
    };
    await expect(invoke(new LLMLoop(provider, null, { maxToolRoundtrips: 0 }), "stream")).rejects.toMatchObject({
      code: "incomplete_stream",
      partial: true,
      text: withText ? "partial" : "",
      reason: { code: "incomplete_stream" },
      usage: { totalTokens: 0 },
    });
  });
  it("never dispatches unfinished tool fragments", async () => {
    const execute = vi.fn(async () => "done");
    const provider: ModelProvider = {
      ...model(answer),
      async *stream() {
        yield { type: "text", text: "partial" };
        yield { type: "tool_call_start", toolCall: { id: "call", name: "effect" } };
      },
    };
    const executor = new ToolExecutor([
      defineTool({ name: "effect", description: "effect", parameters: z.object({}), execute }),
    ]);
    await expect(invoke(new LLMLoop(provider, executor, { maxToolRoundtrips: 1 }), "stream")).rejects.toMatchObject({
      code: "incomplete_stream",
      text: "partial",
    });
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(["provider", "afterLLMCall", "outputGuard", "afterRun"] as const)(
    "cancels a late final answer aborted by %s and retains known usage",
    async (abortAt) => {
      const controller = new AbortController();
      const provider = model(() => {
        if (abortAt === "provider") controller.abort();
        return answer();
      });
      const tracker = new CostTracker();
      const agent = new Agent({
        name: "cancel",
        model: provider,
        register: false,
        costTracker: tracker,
        loopHooks: {
          afterLLMCall: async () => {
            if (abortAt === "afterLLMCall") controller.abort();
          },
        },
        guardrails: {
          output: [
            {
              name: "output",
              validate: async () => {
                if (abortAt === "outputGuard") controller.abort();
                return { pass: true };
              },
            },
          ],
        },
        hooks: {
          afterRun: async () => {
            if (abortAt === "afterRun") controller.abort();
          },
        },
      });
      const complete = vi.fn();
      agent.eventBus.on("run.complete", complete);
      const output = await agent.run("question", { signal: controller.signal, ephemeral: true });
      expect(output.status).toBe("cancelled");
      expect(output.usage).toMatchObject(usage);
      expect(complete).not.toHaveBeenCalled();
      expect(provider.generate).toHaveBeenCalledOnce();
    },
  );
  it.each(["beforeLLMCall", "beforeToolExec"] as const)("does not start an effect after %s aborts", async (abortAt) => {
    const controller = new AbortController();
    const execute = vi.fn(async () => "done");
    const provider = model(toolAnswer);
    const executor = new ToolExecutor([
      defineTool({ name: "effect", description: "effect", parameters: z.object({}), execute }),
    ]);
    const loop = new LLMLoop(provider, executor, {
      maxToolRoundtrips: 1,
      loopHooks: {
        beforeLLMCall: async () => {
          if (abortAt === "beforeLLMCall") controller.abort();
        },
        beforeToolExec: async () => {
          if (abortAt === "beforeToolExec") controller.abort();
        },
      },
    });
    await expect(
      invoke(
        loop,
        "run",
        new RunContext({ sessionId: "session", eventBus: new EventBus(), signal: controller.signal }),
      ),
    ).rejects.toThrow(/cancelled/);
    expect(execute).not.toHaveBeenCalled();
    expect(provider.generate).toHaveBeenCalledTimes(abortAt === "beforeLLMCall" ? 0 : 1);
  });
  it.each(["provider", "afterLLMCall", "outputGuard", "afterRun"] as const)(
    "retains late usage without a ledger after %s cancellation",
    async (abortAt) => {
      const controller = new AbortController();
      const provider = model(() => {
        if (abortAt === "provider") controller.abort();
        return answer();
      });
      const agent = new Agent({
        name: "uncosted",
        register: false,
        model: provider,
        loopHooks: {
          afterLLMCall: async () => {
            if (abortAt === "afterLLMCall") controller.abort();
          },
        },
        guardrails: {
          output: [
            {
              name: "output",
              validate: async () => {
                if (abortAt === "outputGuard") controller.abort();
                return { pass: true };
              },
            },
          ],
        },
        hooks: {
          afterRun: async () => {
            if (abortAt === "afterRun") controller.abort();
          },
        },
      });
      expect(await agent.run("question", { signal: controller.signal, ephemeral: true })).toMatchObject({
        status: "cancelled",
        usage,
      });
    },
  );
  it.each(["run", "stream"] as const)("preserves stopped metadata through Agent %s", async (mode) => {
    const provider = model(() => answer("length"));
    const agent = new Agent({ name: "partial", register: false, model: provider });
    const outputs: RunOutput[] = [];
    agent.eventBus.on("run.complete", ({ output }) => {
      outputs.push(output);
    });
    if (mode === "run") await agent.run("question", { ephemeral: true });
    else
      for await (const _chunk of agent.stream("question", { ephemeral: true })) {
      }
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({
      text: "answer",
      usage,
      status: "stopped",
      partial: true,
      providerFinishReason: "length",
      reason: { code: "provider_length" },
    });
  });
  it("closes the provider iterator without accepting the next text after streaming abort", async () => {
    const controller = new AbortController();
    const closed = vi.fn();
    const provider: ModelProvider = {
      ...model(answer),
      async *stream() {
        try {
          yield { type: "text", text: "accepted" };
          controller.abort();
          yield { type: "text", text: "late" };
        } finally {
          closed();
        }
      },
    };
    const agent = new Agent({ name: "stream-cancel", register: false, model: provider });
    const text: string[] = [];
    const complete = vi.fn();
    agent.eventBus.on("run.complete", complete);
    const consume = async () => {
      for await (const chunk of agent.stream("question", { signal: controller.signal, ephemeral: true }))
        if (chunk.type === "text") text.push(chunk.text);
    };
    await expect(consume()).rejects.toThrow();
    expect(text).toEqual(["accepted"]);
    expect(closed).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
  });
  it.each(["afterLLMCall", "outputGuard", "afterRun"] as const)(
    "rejects streamed completion after %s aborts",
    async (abortAt) => {
      const controller = new AbortController();
      const tracker = new CostTracker();
      const agent = new Agent({
        name: "stream-hooks",
        register: false,
        model: model(answer),
        costTracker: tracker,
        loopHooks: {
          afterLLMCall: async () => {
            if (abortAt === "afterLLMCall") controller.abort();
          },
        },
        guardrails: {
          output: [
            {
              name: "output",
              validate: async () => {
                if (abortAt === "outputGuard") controller.abort();
                return { pass: true };
              },
            },
          ],
        },
        hooks: {
          afterRun: async () => {
            if (abortAt === "afterRun") controller.abort();
          },
        },
      });
      const complete = vi.fn();
      agent.eventBus.on("run.complete", complete);
      const consume = async () => {
        for await (const _chunk of agent.stream("question", {
          runId: "stream-run",
          signal: controller.signal,
          ephemeral: true,
        })) {
        }
      };
      await expect(consume()).rejects.toThrow();
      expect(complete).not.toHaveBeenCalled();
      expect(await tracker.queryRunUsage({ runId: "stream-run" })).toMatchObject(usage);
    },
  );
  it("attaches text and known prior-round usage to an Agent missing-finish error", async () => {
    const execute = vi.fn(async () => "done");
    let request = 0;
    const provider: ModelProvider = {
      ...model(answer),
      async *stream() {
        if (++request === 1) {
          yield { type: "tool_call_start", toolCall: { id: "call", name: "effect" } };
          yield { type: "tool_call_delta", toolCallId: "call", argumentsDelta: "{}" };
          yield { type: "finish", finishReason: "tool_calls", usage };
        } else yield { type: "text", text: "partial final" };
      },
    };
    const agent = new Agent({
      name: "protocol",
      register: false,
      model: provider,
      tools: [defineTool({ name: "effect", description: "effect", parameters: z.object({}), execute })],
    });
    const consume = async () => {
      for await (const _chunk of agent.stream("question", { ephemeral: true })) {
      }
    };
    await expect(consume()).rejects.toMatchObject({
      code: "incomplete_stream",
      partial: true,
      text: "partial final",
      usage,
      output: { status: "error", text: "partial final", usage, reason: { code: "incomplete_stream" } },
    });
    expect(execute).toHaveBeenCalledOnce();
  });
  it.each(["run", "stream"] as const)(
    "never requests automatic continuation for truncated commentary in %s",
    async (mode) => {
      let calls = 0;
      const provider = model(() => {
        calls++;
        return { ...answer("length"), message: { role: "assistant", content: "partial", phase: "commentary" } };
      });
      await invoke(new LLMLoop(provider, null, { maxToolRoundtrips: 2 }), mode);
      expect(calls).toBe(1);
    },
  );
  it.each(["run", "stream"] as const)(
    "retains a settled tool batch as canonical evidence when cancelled during %s",
    async (mode) => {
      const controller = new AbortController();
      const execute = vi.fn(async () => {
        controller.abort();
        return "settled";
      });
      const provider = model(toolAnswer);
      const executor = new ToolExecutor([
        defineTool({ name: "effect", description: "effect", parameters: z.object({}), execute }),
      ]);
      const loop = new LLMLoop(provider, executor, { maxToolRoundtrips: 1 });
      const ctx = new RunContext({ sessionId: "session", eventBus: new EventBus(), signal: controller.signal });
      const transcript: import("../../models/types.js").ChatMessage[] = [];
      const messages = [{ role: "user" as const, content: "question" }];
      const consume = async () => {
        if (mode === "run") await loop.run(messages, ctx, undefined, transcript);
        else
          for await (const _chunk of loop.stream(messages, ctx, undefined, transcript)) {
          }
      };
      await expect(consume()).rejects.toThrow();
      expect(transcript.map((message) => message.role)).toEqual(["assistant", "tool"]);
      expect(transcript[1]).toMatchObject({ toolCallId: "call", content: "[DENIED] Run cancelled" });
      expect(execute).toHaveBeenCalledOnce();
    },
  );
});
