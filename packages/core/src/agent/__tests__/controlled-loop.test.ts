import { expect, it, vi } from "vitest";
import { z } from "zod/v3";
import { EventBus } from "../../events/event-bus.js";
import type { ModelProvider } from "../../models/provider.js";
import type { StreamChunk } from "../../models/types.js";
import { defineTool } from "../../tools/define-tool.js";
import { ToolExecutor } from "../../tools/tool-executor.js";
import { LLMLoop } from "../llm-loop.js";
import { RunContext } from "../run-context.js";

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
it.each(["run", "stream"] as const)("enforces controlled tool-roundtrip caps during %s", async (mode) => {
  const execute = vi.fn(async () => "done");
  const provider: ModelProvider = {
    providerId: "fixture",
    modelId: "fixture",
    async generate(messages) {
      const done = messages.some((message) => message.role === "tool");
      return {
        message: {
          role: "assistant",
          content: done ? "done" : null,
          ...(done ? {} : { toolCalls: [{ id: "call", name: "effect", arguments: {} }] }),
        },
        usage,
        finishReason: done ? "stop" : "tool_calls",
        raw: {},
      };
    },
    async *stream(messages): AsyncGenerator<StreamChunk> {
      if (messages.some((message) => message.role === "tool")) {
        yield { type: "text", text: "done" };
        yield { type: "finish", finishReason: "stop", usage };
      } else {
        yield { type: "tool_call_start", toolCall: { id: "call", name: "effect" } };
        yield { type: "tool_call_delta", toolCallId: "call", argumentsDelta: "{}" };
        yield { type: "finish", finishReason: "tool_calls", usage };
      }
    },
  };
  const executor = new ToolExecutor([
    defineTool({ name: "effect", description: "effect", parameters: z.object({}), execute }),
  ]);
  const context = new RunContext({ sessionId: "session", eventBus: new EventBus() });
  const invoke = async (loop: LLMLoop) => {
    const messages = [{ role: "user" as const, content: "question" }];
    if (mode === "run") await loop.run(messages, context);
    else
      for await (const _chunk of loop.stream(messages, context)) {
      }
  };
  await expect(
    invoke(new LLMLoop(provider, executor, { maxToolRoundtrips: 0, controlledExecution: true })),
  ).rejects.toThrow(/budget exhausted/);
  expect(execute).not.toHaveBeenCalled();
  const loop = new LLMLoop(provider, executor, { maxToolRoundtrips: 1, controlledExecution: true });
  await invoke(loop);
  expect(execute).toHaveBeenCalledOnce();
  await expect(invoke(loop)).rejects.toThrow(/budget exhausted/);
  expect(execute).toHaveBeenCalledOnce();
});
