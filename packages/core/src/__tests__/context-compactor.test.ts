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

  it("keeps system messages even when trimming aggressively", async () => {
    const compactor = new ContextCompactor({
      maxContextTokens: 50,
      strategy: "trim",
    });
    const messages = makeMessages(10, 100);
    const result = await compactor.compact(messages);
    expect(result.some((m) => m.role === "system")).toBe(true);
  });
});
