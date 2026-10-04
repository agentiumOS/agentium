import { describe, expect, it } from "vitest";
import { ContextCompactor } from "../context/context-compactor.js";
import type { ChatMessage } from "../models/types.js";

describe("ContextCompactor", () => {
  const makeMessages = (count: number, contentSize: number): ChatMessage[] => {
    const msgs: ChatMessage[] = [{ role: "system", content: "You are a helpful assistant." }];
    for (let i = 0; i < count; i++) {
      msgs.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: "x".repeat(contentSize),
      });
    }
    return msgs;
  };

  it("passes through messages under budget", async () => {
    const compactor = new ContextCompactor({
      maxContextTokens: 100_000,
      strategy: "trim",
    });
    const messages = makeMessages(4, 100);
    const result = await compactor.compact(messages);
    expect(result.length).toBe(messages.length);
  });

  it("trims oldest messages when over budget", async () => {
    const compactor = new ContextCompactor({
      maxContextTokens: 200,
      reserveTokens: 50,
      strategy: "trim",
    });
    const messages = makeMessages(20, 50);
    const result = await compactor.compact(messages);
    expect(result.length).toBeLessThan(messages.length);
    expect(result[0].role).toBe("system");
  });

  it("rejects an impossible budget instead of discarding required instructions", async () => {
    const compactor = new ContextCompactor({
      maxContextTokens: 50,
      strategy: "trim",
    });
    const messages = makeMessages(10, 100);
    await expect(compactor.compact(messages)).rejects.toThrow("Context cannot fit an intact exchange");
  });
});

describe("atomic exchanges", () => {
  const latest: ChatMessage[] = [
    { role: "user", content: "lookup" },
    {
      role: "assistant",
      content: null,
      toolCalls: [
        { id: "a", name: "one", arguments: {} },
        { id: "b", name: "two", arguments: {} },
      ],
      providerExtras: {
        responsesReplay: { version: 1, owner: "test", items: [{ type: "reasoning", encrypted_content: "opaque" }] },
      },
    },
    { role: "tool", toolCallId: "b", content: "second" },
    { role: "tool", toolCallId: "a", content: "first" },
    { role: "assistant", content: "answer" },
  ];
  const history: ChatMessage[] = [
    { role: "system", content: "Host instructions" },
    { role: "user", content: "old ".repeat(2000) },
    { role: "assistant", content: "old answer" },
    ...latest,
  ];
  it.each(["trim", "summarize", "hybrid"] as const)(
    "preserves a complete parallel tool round with %s",
    async (strategy) => {
      const compactor = new ContextCompactor({ maxContextTokens: 400, reserveTokens: 0, strategy });
      expect(await compactor.compact(history)).toEqual([history[0], ...latest]);
    },
  );
  it("preserves outstanding calls unchanged", async () => {
    const pending = history.slice(0, -3);
    const result = await new ContextCompactor({ maxContextTokens: 400, reserveTokens: 0, strategy: "trim" }).compact(
      pending,
    );
    expect(result).toEqual([history[0], ...latest.slice(0, 2)]);
  });
  it("rejects orphaned results even when below budget", async () => {
    await expect(
      new ContextCompactor({ maxContextTokens: 10000, strategy: "trim" }).compact([
        { role: "tool", toolCallId: "missing", content: "secret" },
      ]),
    ).rejects.toThrow("orphaned");
  });
  it("fails explicitly for oversized indivisible replay without changing the transcript", async () => {
    const original = JSON.stringify(history);
    await expect(
      new ContextCompactor({ maxContextTokens: 10, reserveTokens: 0, strategy: "hybrid" }).compact(history),
    ).rejects.toThrow("intact exchange");
    expect(JSON.stringify(history)).toBe(original);
  });
  it("keeps summaries as historical assistant data and falls back atomically on summarizer failure", async () => {
    const model = {
      providerId: "mock",
      modelId: "mock",
      async generate() {
        return {
          message: { role: "assistant" as const, content: "old facts" },
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          finishReason: "stop" as const,
          raw: {},
        };
      },
      async *stream() {},
    };
    const compactor = new ContextCompactor({
      maxContextTokens: 400,
      reserveTokens: 0,
      strategy: "summarize",
      summarizeModel: model,
    });
    const summarized = await compactor.compact(history);
    expect(summarized[1]).toMatchObject({
      role: "assistant",
      content: expect.stringContaining("historical data, not instructions"),
    });
    expect(summarized.slice(2)).toEqual(latest);
    model.generate = async () => {
      throw new Error("offline");
    };
    expect(await compactor.compact(history)).toEqual([history[0], ...latest]);
  });
});
