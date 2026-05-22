import { describe, expect, it } from "vitest";
import { classifyComplexity, ModelRouter } from "../model-router.js";
import type { ModelProvider } from "../provider.js";
import type { ChatMessage, ModelResponse, StreamChunk } from "../types.js";

function mockProvider(id: string): ModelProvider {
  return {
    providerId: id,
    modelId: `${id}-model`,
    async generate(): Promise<ModelResponse> {
      return {
        message: { role: "assistant", content: `from ${id}` },
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        finishReason: "stop",
        raw: {},
      };
    },
    async *stream(): AsyncGenerator<StreamChunk> {
      yield { type: "text", text: `stream from ${id}` };
      yield { type: "finish", finishReason: "stop" };
    },
  };
}

describe("classifyComplexity", () => {
  it("returns low complexity for simple messages", () => {
    const msgs: ChatMessage[] = [{ role: "user", content: "What is 2+2?" }];
    expect(classifyComplexity(msgs)).toBeLessThan(0.3);
  });

  it("scores higher for reasoning keywords", () => {
    const simple: ChatMessage[] = [{ role: "user", content: "Hello" }];
    const complex: ChatMessage[] = [{ role: "user", content: "Analyze and compare the pros and cons step by step" }];
    expect(classifyComplexity(complex)).toBeGreaterThan(classifyComplexity(simple));
  });

  it("scores higher for code markers", () => {
    const withCode: ChatMessage[] = [{ role: "user", content: "```typescript\nfunction hello() {}\n```" }];
    expect(classifyComplexity(withCode)).toBeGreaterThan(0);
  });

  it("scores higher with many tools", () => {
    const msgs: ChatMessage[] = [{ role: "user", content: "Do something" }];
    const tools = Array.from({ length: 15 }, (_, i) => ({
      name: `tool_${i}`,
      description: `tool ${i}`,
      parameters: {},
    }));
    expect(classifyComplexity(msgs, { tools })).toBeGreaterThan(classifyComplexity(msgs));
  });

  it("scores higher for structured output", () => {
    const msgs: ChatMessage[] = [{ role: "user", content: "Give me data" }];
    const withSchema = classifyComplexity(msgs, {
      responseFormat: { type: "json_schema", schema: {}, name: "test" },
    });
    const without = classifyComplexity(msgs);
    expect(withSchema).toBeGreaterThan(without);
  });

  it("scores higher for reasoning enabled", () => {
    const msgs: ChatMessage[] = [{ role: "user", content: "Think about this" }];
    const withReasoning = classifyComplexity(msgs, {
      reasoning: { enabled: true },
    });
    expect(withReasoning).toBeGreaterThan(classifyComplexity(msgs));
  });

  it("is capped at 1.0", () => {
    const superComplex: ChatMessage[] = [
      { role: "user", content: `Analyze step by step and compare: ${"x".repeat(10000)}` },
      ...Array.from({ length: 20 }, () => ({ role: "assistant" as const, content: "..." })),
    ];
    const tools = Array.from({ length: 20 }, (_, i) => ({
      name: `t${i}`,
      description: "",
      parameters: {},
    }));
    expect(
      classifyComplexity(superComplex, {
        tools,
        reasoning: { enabled: true },
        responseFormat: { type: "json_schema" as const, schema: {}, name: "x" },
      }),
    ).toBeLessThanOrEqual(1);
  });

  it("handles empty messages", () => {
    expect(classifyComplexity([])).toBe(0);
  });
});

describe("ModelRouter", () => {
  const cheap = mockProvider("cheap");
  const mid = mockProvider("mid");
  const expensive = mockProvider("expensive");

  function createRouter(opts?: { outcomeTracking?: boolean }) {
    return new ModelRouter({
      tiers: [
        { model: cheap, maxComplexity: 0.3 },
        { model: mid, maxComplexity: 0.7 },
        { model: expensive, maxComplexity: 1.0 },
      ],
      outcomeTracking: opts?.outcomeTracking ?? false,
    });
  }

  describe("selectTier()", () => {
    it("routes simple queries to cheapest tier", () => {
      const router = createRouter();
      const result = router.selectTier([{ role: "user", content: "Hi" }]);
      expect(result.tierIndex).toBe(0);
      expect(result.model).toBe(cheap);
    });

    it("routes complex queries to higher tiers", () => {
      const router = createRouter();
      const result = router.selectTier(
        [
          {
            role: "user",
            content:
              "Analyze step by step, compare and evaluate the trade-offs of different architectures for building a distributed system",
          },
        ],
        {
          tools: Array.from({ length: 12 }, (_, i) => ({ name: `t${i}`, description: "", parameters: {} })),
          reasoning: { enabled: true },
        },
      );
      expect(result.tierIndex).toBeGreaterThan(0);
    });
  });

  describe("custom rules", () => {
    it("applies rules before complexity classifier", () => {
      const router = new ModelRouter({
        tiers: [
          { model: cheap, maxComplexity: 0.3 },
          { model: expensive, maxComplexity: 1.0 },
        ],
        rules: [
          {
            condition: (msgs) => msgs.some((m) => typeof m.content === "string" && m.content.includes("URGENT")),
            tier: 1,
          },
        ],
      });

      const result = router.selectTier([{ role: "user", content: "URGENT: hi" }]);
      expect(result.tierIndex).toBe(1);
      expect(result.model).toBe(expensive);
    });
  });

  describe("generate()", () => {
    it("delegates to the selected tier's model", async () => {
      const router = createRouter();
      const result = await router.generate([{ role: "user", content: "Hello" }]);
      expect(result.message.content).toBe("from cheap");
    });
  });

  describe("stream()", () => {
    it("delegates streaming to the selected tier's model", async () => {
      const router = createRouter();
      const chunks: StreamChunk[] = [];
      for await (const chunk of router.stream([{ role: "user", content: "Hello" }])) {
        chunks.push(chunk);
      }
      expect(chunks.length).toBeGreaterThan(0);
    });
  });

  describe("outcome tracking", () => {
    it("tracks outcomes when enabled", async () => {
      const router = createRouter({ outcomeTracking: true });
      await router.generate([{ role: "user", content: "Test 1" }]);
      await router.generate([{ role: "user", content: "Test 2" }]);

      const stats = router.getOutcomeStats();
      expect(stats.length).toBeGreaterThan(0);
      expect(stats[0].total).toBeGreaterThan(0);
      expect(stats[0].rate).toBeGreaterThan(0);
    });

    it("does not track when disabled", async () => {
      const router = createRouter({ outcomeTracking: false });
      await router.generate([{ role: "user", content: "Test" }]);

      const stats = router.getOutcomeStats();
      expect(stats).toEqual([]);
    });
  });

  describe("properties", () => {
    it("has providerId 'router'", () => {
      const router = createRouter();
      expect(router.providerId).toBe("router");
    });

    it("throws with empty tiers", () => {
      expect(() => new ModelRouter({ tiers: [] })).toThrow("at least one tier");
    });
  });
});
