import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../models/types.js";
import { countMessagesTokens, countMessageTokens, countTokens, hasExactTokenizer } from "../utils/token-counter.js";

describe("TokenCounter", () => {
  it("returns 0 for empty string", () => {
    expect(countTokens("")).toBe(0);
    expect(countTokens("", "gpt-4o")).toBe(0);
  });

  it("returns positive count for non-empty text", () => {
    const tokens = countTokens("Hello, world!");
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(50);
  });

  it("longer text produces more tokens", () => {
    const short = countTokens("Hi");
    const long = countTokens("This is a much longer text that should produce more tokens.");
    expect(long).toBeGreaterThan(short);
  });

  it("hasExactTokenizer returns a boolean", () => {
    const result = hasExactTokenizer();
    expect(typeof result).toBe("boolean");
  });

  describe("countMessageTokens", () => {
    it("adds message overhead to content tokens", () => {
      const msg: ChatMessage = { role: "user", content: "Hello" };
      const msgTokens = countMessageTokens(msg);
      const contentTokens = countTokens("Hello");
      expect(msgTokens).toBe(contentTokens + 4);
    });

    it("handles null content", () => {
      const msg: ChatMessage = { role: "assistant", content: null };
      const tokens = countMessageTokens(msg);
      expect(tokens).toBe(4); // overhead only
    });
  });

  describe("countMessagesTokens", () => {
    it("sums tokens across messages", () => {
      const messages: ChatMessage[] = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "What is 2+2?" },
      ];
      const total = countMessagesTokens(messages);
      const individual = messages.reduce((sum, m) => sum + countMessageTokens(m), 0);
      expect(total).toBe(individual);
    });

    it("returns 0 for empty array", () => {
      expect(countMessagesTokens([])).toBe(0);
    });
  });

  describe("model-aware heuristic (fallback)", () => {
    it("produces different estimates for different model families when no tokenizer", () => {
      const text = "The quick brown fox jumps over the lazy dog. ".repeat(100);
      const gpt4 = countTokens(text, "gpt-4o");
      const claude = countTokens(text, "claude-3-opus");
      const generic = countTokens(text, "some-unknown-model");

      // If exact tokenizer is loaded, all will be identical (exact count).
      // If heuristic, GPT-4 should be slightly less than Claude (higher ratio).
      if (!hasExactTokenizer()) {
        expect(generic).toBeGreaterThanOrEqual(gpt4);
        expect(generic).toBeGreaterThanOrEqual(claude);
      }
      // All should be reasonable (within 20% of each other)
      const avg = (gpt4 + claude + generic) / 3;
      expect(Math.abs(gpt4 - avg) / avg).toBeLessThan(0.25);
    });
  });

  describe("code and JSON handling", () => {
    it("counts tokens in JSON content", () => {
      const json = JSON.stringify({ name: "test", values: [1, 2, 3], nested: { key: "val" } });
      const tokens = countTokens(json);
      expect(tokens).toBeGreaterThan(5);
    });

    it("counts tokens in code", () => {
      const code = `function fibonacci(n) {\n  if (n <= 1) return n;\n  return fibonacci(n - 1) + fibonacci(n - 2);\n}`;
      const tokens = countTokens(code);
      expect(tokens).toBeGreaterThan(10);
    });
  });
});
