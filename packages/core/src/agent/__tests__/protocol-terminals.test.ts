import { describe, expect, it } from "vitest";
import { EventBus } from "../../events/event-bus.js";
import type { ModelProvider } from "../../models/provider.js";
import { Agent } from "../agent.js";
import { LLMLoop } from "../llm-loop.js";
import { RunContext } from "../run-context.js";

describe("empty terminal tool batches", () => {
  it.each([false, true])("rejects tool_calls without a complete tool call, stream=%s", async (stream) => {
    const usage = { promptTokens: 2, completionTokens: 1, totalTokens: 3 };
    const provider: ModelProvider = {
      providerId: "fixture",
      modelId: "fixture",
      async generate() {
        return { message: { role: "assistant", content: "Observed text" }, finishReason: "tool_calls", usage, raw: {} };
      },
      async *stream() {
        yield { type: "text", text: "Observed text" };
        yield { type: "finish", finishReason: "tool_calls", usage };
      },
    };
    const agent = new Agent({ name: "empty-batch", model: provider, register: false });
    const execute = async () => {
      if (!stream) return agent.run("Work");
      for await (const _chunk of agent.stream("Work")) {
        /* Consume the entire provider response. */
      }
    };
    await expect(execute()).rejects.toMatchObject({
      code: "invalid_model_response",
      output: { text: "Observed text", status: "error", usage, partial: true },
    });
    await agent.close();
  });

  it("preserves usage once for an invalid direct loop stream", async () => {
    const usage = { promptTokens: 2, completionTokens: 1, totalTokens: 3 };
    const provider: ModelProvider = {
      providerId: "fixture",
      modelId: "fixture",
      async generate() {
        throw new Error("Stream fixture");
      },
      async *stream() {
        yield { type: "text", text: "Observed text" };
        yield { type: "finish", finishReason: "tool_calls", usage };
      },
    };
    const loop = new LLMLoop(provider, null, { maxToolRoundtrips: 1 });
    const ctx = new RunContext({ sessionId: "direct", eventBus: new EventBus() });
    const consume = async () => {
      for await (const _chunk of loop.stream([{ role: "user", content: "Work" }], ctx)) {
        // Inspect the terminal error after the partial text.
      }
    };
    await expect(consume()).rejects.toMatchObject({ code: "invalid_model_response", usage, output: { usage } });
  });
});
