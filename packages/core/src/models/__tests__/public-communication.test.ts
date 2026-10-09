import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/agent.js";
import { iterResponsesStream, normalizeResponsesResponse, toResponsesInput } from "../openai-api.js";
import type { ModelProvider } from "../provider.js";
import { getCommunicationCapabilities, type PublicMessageEvent, PublicMessageStream } from "../public-messages.js";
import type { StreamChunk } from "../types.js";

const response = {
  id: "response-1",
  status: "completed",
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  output: [
    {
      type: "reasoning",
      id: "reason-1",
      summary: [{ type: "summary_text", text: "Checking the date range." }],
      content: "RAW PRIVATE CONTENT",
      encrypted_content: "OPAQUE",
    },
    {
      type: "message",
      id: "message-1",
      phase: "commentary",
      content: [{ type: "output_text", text: "I will check the dates." }],
    },
  ],
};
async function* source(events: unknown[]) {
  yield* events;
}

it("exposes only documented summary text and preserves native commentary and opaque replay", () => {
  const normalized = normalizeResponsesResponse(response);
  expect(normalized.publicMessages).toEqual([
    { id: "reason-1:summary", phase: "reasoning_summary", text: "Checking the date range." },
    { id: "message-1", phase: "commentary", text: "I will check the dates." },
  ]);
  expect(normalized.message.phase).toBe("commentary");
  expect(JSON.stringify(normalized.publicMessages)).not.toMatch(/RAW PRIVATE|OPAQUE/);
  expect(toResponsesInput([normalized.message]).input).toEqual(response.output);
  const rawOnly = normalizeResponsesResponse({
    ...response,
    output: [{ type: "reasoning", content: "raw", encrypted_content: "opaque" }],
  });
  expect(rawOnly.publicMessages).toBeUndefined();
});

it("correlates native summary/text streaming items and agrees with nonstreaming normalization", async () => {
  const collector = new PublicMessageStream();
  const events: PublicMessageEvent[] = [];
  const chunks: StreamChunk[] = [];
  for await (const chunk of iterResponsesStream(
    source([
      { type: "response.output_item.added", item: response.output[1] },
      { type: "response.reasoning_text.delta", item_id: "reason-1", delta: "RAW PRIVATE CONTENT" },
      { type: "response.reasoning_summary_text.delta", item_id: "reason-1", delta: "Checking the " },
      { type: "response.reasoning_summary_text.delta", item_id: "reason-1", delta: "date range." },
      { type: "response.output_text.delta", item_id: "message-1", delta: "I will check the dates." },
      { type: "response.completed", response },
    ]),
  )) {
    chunks.push(chunk);
    events.push(...collector.consume(chunk));
  }
  const normalized = normalizeResponsesResponse(response).publicMessages ?? [];
  expect(collector.messages.map(({ phase, text }) => ({ phase, text }))).toEqual(
    normalized.map(({ phase, text }) => ({ phase, text })),
  );
  expect(events.filter((event) => event.type === "message.started")).toHaveLength(2);
  for (const message of collector.messages) {
    expect(events).toContainEqual(expect.objectContaining({ type: "message.started", id: message.id }));
    expect(events).toContainEqual({ type: "message.completed", message });
  }
  expect(JSON.stringify(events)).not.toMatch(/RAW PRIVATE|OPAQUE/);
  expect(chunks.at(-1)).toMatchObject({ type: "finish", phase: "commentary", usage: { totalTokens: 15 } });
});

it("does not label raw thinking as a summary and fails a partial item exactly once", () => {
  const stream = new PublicMessageStream();
  expect(stream.consume({ type: "thinking", text: "raw private reasoning" })).toEqual([]);
  const started = stream.consume({ type: "text", text: "Partial" });
  expect(started[0]).toMatchObject({ type: "message.started", phase: "pending" });
  const failed = stream.fail(true);
  expect(failed).toEqual([
    { type: "message.failed", id: "id" in started[0] ? started[0].id : "", reason: "cancelled" },
  ]);
  expect(stream.fail(true)).toEqual([]);
});

describe.each([false, true])("Agent public stream opt-in=%s", (publicMessageEvents) => {
  it("keeps terminal usage last and gives matching completed result items", async () => {
    const model: ModelProvider = {
      providerId: "fixture",
      modelId: "fixture",
      async generate() {
        throw new Error("Unexpected");
      },
      async *stream() {
        yield { type: "text", text: "Done" };
        yield { type: "finish", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      },
    };
    expect(getCommunicationCapabilities(model)).toEqual({
      messagePhases: "inferred",
      reasoningSummaries: "unsupported",
    });
    const agent = new Agent({ name: "public", model, register: false });
    let completed: import("../../agent/types.js").RunOutput | undefined;
    agent.eventBus.on("run.complete", ({ output }) => {
      completed = output;
    });
    const chunks: StreamChunk[] = [];
    for await (const chunk of agent.stream("hello", { publicMessageEvents })) chunks.push(chunk);
    expect(chunks.at(-1)).toMatchObject({ type: "finish", usage: { totalTokens: 2 } });
    expect(chunks.filter((chunk) => chunk.type === "public_message")).toHaveLength(publicMessageEvents ? 3 : 0);
    expect(completed?.publicMessages).toEqual([expect.objectContaining({ phase: "final", text: "Done" })]);
    await agent.close();
  });
});

it("preserves explicit assistant phases when serializing messages without replay envelopes", () => {
  expect(toResponsesInput([{ role: "assistant", content: "Checking", phase: "commentary" }]).input).toEqual([
    { role: "assistant", content: "Checking", phase: "commentary" },
  ]);
});
