import { describe, expect, it, vi } from "vitest";
import { SemanticCache } from "../../cache/semantic-cache.js";
import { EventBus } from "../../events/event-bus.js";
import type { ModelProvider } from "../../models/provider.js";
import { InMemoryVectorStore } from "../../vector/in-memory.js";
import { Agent } from "../agent.js";

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const scopes = { sessionId: "cache-session" };
function fixture() {
  const config = {
    vectorStore: new InMemoryVectorStore(),
    embedding: { dimensions: 2, embed: async () => [1, 0], embedBatch: async () => [[1, 0]] },
  };
  const generate = vi.fn<ModelProvider["generate"]>(async () => ({
    message: { role: "assistant", content: "Fresh answer" },
    usage,
    finishReason: "stop",
    raw: {},
  }));
  const model: ModelProvider = {
    providerId: "fixture",
    modelId: "fixture",
    generate,
    async *stream() {
      yield { type: "text", text: "Fresh answer" };
      yield { type: "finish", finishReason: "stop", usage };
    },
  };
  return { config, generate, model, seed: new SemanticCache(config) };
}

describe("cached candidate outcomes", () => {
  it.each([false, true])(
    "does not turn an incomplete historical cache record into success, stream=%s",
    async (stream) => {
      const f = fixture();
      await f.seed.store("Work", {
        text: "Truncated",
        toolCalls: [],
        usage,
        status: "stopped",
        partial: true,
        providerFinishReason: "length",
      });
      const agent = new Agent({ name: "cache-outcome", model: f.model, semanticCache: f.config, register: false });
      if (stream) {
        const chunks = [];
        for await (const chunk of agent.stream("Work", scopes)) chunks.push(chunk);
        expect(
          chunks
            .filter((chunk) => chunk.type === "text")
            .map((chunk) => chunk.text)
            .join(""),
        ).toBe("Fresh answer");
      } else expect((await agent.run("Work", scopes)).text).toBe("Fresh answer");
      await agent.close();
    },
  );

  it.each([false, true])("cancellation blocks a cached result before publication, stream=%s", async (stream) => {
    const f = fixture();
    await f.seed.store("Work", {
      text: "Cached",
      toolCalls: [],
      usage,
      status: "completed",
      providerFinishReason: "stop",
    });
    const agent = new Agent({ name: "cache-cancel", model: f.model, semanticCache: f.config, register: false });
    const signal = AbortSignal.abort(new Error("Cancelled before cache"));
    if (stream) await expect(agent.stream("Work", { ...scopes, signal }).next()).rejects.toThrow();
    else await expect(agent.run("Work", { ...scopes, signal })).rejects.toThrow();
    expect(f.generate).not.toHaveBeenCalled();
    await agent.close();
  });

  it("does not store a new incomplete candidate", async () => {
    const f = fixture();
    f.generate.mockResolvedValue({
      message: { role: "assistant", content: "Truncated" },
      usage,
      finishReason: "length",
      raw: {},
    });
    const upsert = vi.spyOn(f.config.vectorStore, "upsert");
    const agent = new Agent({ name: "cache-store", model: f.model, semanticCache: f.config, register: false });
    expect((await agent.run("Work", scopes)).status).toBe("stopped");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(upsert).not.toHaveBeenCalled();
    await agent.close();
  });

  it("does not publish cached text when a cache observer cancels", async () => {
    const f = fixture();
    await f.seed.store("Work", {
      text: "Cached",
      toolCalls: [],
      usage,
      status: "completed",
      providerFinishReason: "stop",
    });
    const controller = new AbortController();
    const events = new EventBus();
    events.on("cache.hit", () => controller.abort(new Error("Cancelled at cache hit")));
    const agent = new Agent({
      name: "cache-observer-cancel",
      model: f.model,
      semanticCache: f.config,
      events,
      register: false,
    });
    await expect(agent.stream("Work", { ...scopes, signal: controller.signal }).next()).rejects.toThrow(
      "Cancelled at cache hit",
    );
    expect(f.generate).not.toHaveBeenCalled();
    await agent.close();
  });
});
