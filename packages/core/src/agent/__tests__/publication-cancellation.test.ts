import { describe, expect, it } from "vitest";
import { EventBus } from "../../events/event-bus.js";
import type { ModelProvider } from "../../models/provider.js";
import type { PublicMessageEvent } from "../../models/public-messages.js";
import { LLMLoop } from "../llm-loop.js";
import { RunContext } from "../run-context.js";

const usage = { promptTokens: 2, completionTokens: 1, totalTokens: 3 };

function fixture() {
  const provider: ModelProvider = {
    providerId: "fixture",
    modelId: "fixture",
    async generate() {
      throw new Error("Stream fixture");
    },
    async *stream() {
      yield { type: "text", text: "Observed text" };
      yield { type: "finish", finishReason: "stop", usage };
    },
  };
  const controller = new AbortController();
  const eventBus = new EventBus();
  const messages: PublicMessageEvent[] = [];
  const modelErrors: Array<string | undefined> = [];
  eventBus.on("run.message", ({ messageEvent }) => messages.push(messageEvent));
  eventBus.on("model.error", ({ status }) => modelErrors.push(status));
  const loop = new LLMLoop(provider, null, { maxToolRoundtrips: 0 });
  const ctx = new RunContext({ sessionId: "publication", eventBus, signal: controller.signal });
  const stream = loop.stream(
    [{ role: "user", content: "Work" }],
    ctx,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
  );
  return { controller, messages, modelErrors, stream };
}

describe("direct loop publication cancellation", () => {
  it("suppresses raw text after cancellation at the last public delta and reports the failed message", async () => {
    const { controller, messages, modelErrors, stream } = fixture();
    expect(await stream.next()).toMatchObject({
      value: { type: "public_message", event: { type: "message.started" } },
    });
    expect(await stream.next()).toMatchObject({
      value: { type: "public_message", event: { type: "message.delta", text: "Observed text" } },
    });

    controller.abort();
    expect(await stream.next()).toMatchObject({
      value: { type: "public_message", event: { type: "message.failed", reason: "cancelled" } },
    });
    await expect(stream.next()).rejects.toMatchObject({
      name: "RunCancelledError",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
    expect(messages.map((event) => event.type)).toEqual(["message.started", "message.delta", "message.failed"]);
    expect(modelErrors).toEqual(["cancelled"]);
  });

  it("suppresses raw finish after cancellation at the last completed message and preserves settled usage", async () => {
    const { controller, messages, stream } = fixture();
    await stream.next();
    await stream.next();
    expect(await stream.next()).toMatchObject({ value: { type: "text", text: "Observed text" } });
    expect(await stream.next()).toMatchObject({
      value: { type: "public_message", event: { type: "message.completed", message: { text: "Observed text" } } },
    });

    controller.abort();
    await expect(stream.next()).rejects.toMatchObject({ name: "RunCancelledError", usage });
    expect(messages.map((event) => event.type)).toEqual(["message.started", "message.delta", "message.completed"]);
  });
});
