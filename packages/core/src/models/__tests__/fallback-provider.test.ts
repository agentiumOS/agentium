import { describe, expect, it, vi } from "vitest";
import { FallbackProvider, withFallback } from "../fallback-provider.js";
import type { ModelProvider } from "../provider.js";
import type { ModelResponse, StreamChunk } from "../types.js";

function mockProvider(
  id: string,
  opts?: { failGenerate?: boolean; failStream?: boolean; fatalError?: boolean },
): ModelProvider {
  return {
    providerId: id,
    modelId: `${id}-model`,
    async generate(): Promise<ModelResponse> {
      if (opts?.failGenerate) {
        const err: any = new Error(`${id} failed`);
        if (opts.fatalError) err.message = "content policy violation";
        else err.status = 503;
        throw err;
      }
      return {
        message: { role: "assistant", content: `response from ${id}` },
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        finishReason: "stop",
        raw: {},
      };
    },
    async *stream(): AsyncGenerator<StreamChunk> {
      if (opts?.failStream) {
        const err: any = new Error(`${id} stream failed`);
        err.status = 503;
        throw err;
      }
      yield { type: "text", text: `stream from ${id}` };
      yield { type: "finish", finishReason: "stop", usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 } };
    },
  };
}

describe("FallbackProvider", () => {
  it.each(["generate", "stream"] as const)("does not start a fallback after %s cancellation", async (mode) => {
    const controller = new AbortController();
    const primary = mockProvider("primary");
    const backup = mockProvider("backup");
    const stopped = new Error("caller stopped");
    primary.generate = async () => {
      controller.abort(stopped);
      throw new Error("request interrupted");
    };
    // biome-ignore lint/correctness/useYield: exercises cancellation before the first stream chunk.
    primary.stream = async function* () {
      controller.abort(stopped);
      throw new Error("request interrupted");
    };
    const spy = vi.spyOn(backup, mode);
    const provider = new FallbackProvider({ providers: [primary, backup] });
    const call =
      mode === "generate"
        ? provider.generate([], { signal: controller.signal })
        : provider.stream([], { signal: controller.signal }).next();
    await expect(call).rejects.toBe(stopped);
    expect(spy).not.toHaveBeenCalled();
    await expect(
      mode === "generate"
        ? provider.generate([], { signal: controller.signal })
        : provider.stream([], { signal: controller.signal }).next(),
    ).rejects.toBe(stopped);
  });
  describe("generate()", () => {
    it("uses the primary provider when healthy", async () => {
      const provider = new FallbackProvider({
        providers: [mockProvider("primary"), mockProvider("backup")],
      });

      const result = await provider.generate([{ role: "user", content: "hi" }]);
      expect(result.message.content).toBe("response from primary");
    });

    it("falls back to second provider when primary fails", async () => {
      const provider = new FallbackProvider({
        providers: [mockProvider("primary", { failGenerate: true }), mockProvider("backup")],
      });

      const result = await provider.generate([{ role: "user", content: "hi" }]);
      expect(result.message.content).toBe("response from backup");
    });

    it("falls back through multiple providers", async () => {
      const provider = new FallbackProvider({
        providers: [
          mockProvider("p1", { failGenerate: true }),
          mockProvider("p2", { failGenerate: true }),
          mockProvider("p3"),
        ],
      });

      const result = await provider.generate([{ role: "user", content: "hi" }]);
      expect(result.message.content).toBe("response from p3");
    });

    it("throws when all providers fail", async () => {
      const provider = new FallbackProvider({
        providers: [mockProvider("p1", { failGenerate: true }), mockProvider("p2", { failGenerate: true })],
      });

      await expect(provider.generate([{ role: "user", content: "hi" }])).rejects.toThrow();
    });

    it("throws immediately on fatal error", async () => {
      const provider = new FallbackProvider({
        providers: [mockProvider("p1", { failGenerate: true, fatalError: true }), mockProvider("p2")],
      });

      await expect(provider.generate([{ role: "user", content: "hi" }])).rejects.toThrow("content policy");
    });

    it("calls onFallback callback", async () => {
      const onFallback = vi.fn();
      const provider = new FallbackProvider({
        providers: [mockProvider("p1", { failGenerate: true }), mockProvider("p2")],
        onFallback,
      });

      await provider.generate([{ role: "user", content: "hi" }]);
      expect(onFallback).toHaveBeenCalledOnce();
      expect(onFallback.mock.calls[0][0]).toBe("p1:p1-model");
      expect(onFallback.mock.calls[0][1]).toBe("p2:p2-model");
    });
  });

  describe("stream()", () => {
    it("streams from primary when healthy", async () => {
      const provider = new FallbackProvider({
        providers: [mockProvider("primary"), mockProvider("backup")],
      });

      const chunks: StreamChunk[] = [];
      for await (const chunk of provider.stream([{ role: "user", content: "hi" }])) {
        chunks.push(chunk);
      }
      expect(chunks[0]).toEqual({ type: "text", text: "stream from primary" });
    });

    it("falls back on stream failure", async () => {
      const provider = new FallbackProvider({
        providers: [mockProvider("primary", { failStream: true }), mockProvider("backup")],
      });

      const chunks: StreamChunk[] = [];
      for await (const chunk of provider.stream([{ role: "user", content: "hi" }])) {
        chunks.push(chunk);
      }
      expect(chunks[0]).toEqual({ type: "text", text: "stream from backup" });
    });
  });

  describe("circuit breaker integration", () => {
    it("skips providers with open circuits", async () => {
      const provider = new FallbackProvider({
        providers: [mockProvider("p1", { failGenerate: true }), mockProvider("p2")],
        circuitBreaker: { failureThreshold: 1 },
      });

      // First call: p1 fails → open circuit → p2 succeeds
      await provider.generate([{ role: "user", content: "1" }]);

      // Second call: p1 circuit is open → goes straight to p2
      const result = await provider.generate([{ role: "user", content: "2" }]);
      expect(result.message.content).toBe("response from p2");
    });
  });

  describe("properties", () => {
    it("has providerId 'fallback'", () => {
      const provider = new FallbackProvider({ providers: [mockProvider("p1")] });
      expect(provider.providerId).toBe("fallback");
    });

    it("modelId matches primary provider", () => {
      const provider = new FallbackProvider({ providers: [mockProvider("p1")] });
      expect(provider.modelId).toBe("p1-model");
    });

    it("exposes provider keys", () => {
      const provider = new FallbackProvider({
        providers: [mockProvider("p1"), mockProvider("p2")],
      });
      expect(provider.providerKeys).toEqual(["p1:p1-model", "p2:p2-model"]);
    });

    it("throws when created with empty providers", () => {
      expect(() => new FallbackProvider({ providers: [] })).toThrow("at least one provider");
    });
  });

  describe("resetAll()", () => {
    it("resets all circuit breakers", async () => {
      const provider = new FallbackProvider({
        providers: [mockProvider("p1", { failGenerate: true }), mockProvider("p2")],
        circuitBreaker: { failureThreshold: 1 },
      });

      await provider.generate([{ role: "user", content: "hi" }]);
      const breaker = provider.getBreaker("p1:p1-model");
      expect(breaker?.state).toBe("open");

      provider.resetAll();
      expect(breaker?.state).toBe("closed");
    });
  });
});

describe("withFallback()", () => {
  it("returns a FallbackProvider", () => {
    const result = withFallback([mockProvider("p1"), mockProvider("p2")]);
    expect(result).toBeInstanceOf(FallbackProvider);
    expect(result.providerId).toBe("fallback");
  });
});

describe("committed streams", () => {
  it.each<StreamChunk>([
    { type: "text", text: "partial" },
    { type: "tool_call_start", toolCall: { id: "call", name: "write" } },
    { type: "thinking", text: "summary" },
    { type: "finish", finishReason: "stop" },
  ])("does not retry after a public $type chunk", async (first) => {
    const primary = mockProvider("primary");
    primary.stream = async function* () {
      yield first;
      throw Object.assign(new Error("interrupted"), { status: 503 });
    };
    const backup = mockProvider("backup");
    const spy = vi.spyOn(backup, "stream");
    const fallback = vi.fn();
    const provider = new FallbackProvider({ providers: [primary, backup], onFallback: fallback });
    const chunks: StreamChunk[] = [];
    await expect(async () => {
      for await (const chunk of provider.stream([])) chunks.push(chunk);
    }).rejects.toThrow("interrupted");
    expect(chunks).toEqual([first]);
    expect(spy).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });
});
