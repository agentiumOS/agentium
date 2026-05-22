import { describe, expect, it, vi } from "vitest";
import type {
  EmbeddingProvider,
  VectorDocument,
  VectorSearchOptions,
  VectorSearchResult,
  VectorStore,
} from "../../vector/types.js";
import { SemanticCache } from "../semantic-cache.js";

function createMockVectorStore(): VectorStore {
  const docs = new Map<string, Map<string, VectorDocument>>();

  return {
    initialize: vi.fn(),
    async upsert(collection: string, doc: VectorDocument) {
      if (!docs.has(collection)) docs.set(collection, new Map());
      docs.get(collection)!.set(doc.id, doc);
    },
    async upsertBatch(collection: string, batch: VectorDocument[]) {
      for (const doc of batch) await this.upsert(collection, doc);
    },
    async search(
      collection: string,
      _query: number[] | string,
      options?: VectorSearchOptions,
    ): Promise<VectorSearchResult[]> {
      const col = docs.get(collection);
      if (!col) return [];
      const results: VectorSearchResult[] = [];
      for (const [id, doc] of col) {
        results.push({
          id,
          content: doc.content,
          score: 0.95,
          metadata: doc.metadata,
        });
      }
      if (options?.minScore) {
        return results.filter((r) => r.score >= options.minScore!);
      }
      return results.slice(0, options?.topK ?? 10);
    },
    async delete(collection: string, id: string) {
      docs.get(collection)?.delete(id);
    },
    async get(collection: string, id: string) {
      return docs.get(collection)?.get(id) ?? null;
    },
    async dropCollection(collection: string) {
      docs.delete(collection);
    },
    async close() {
      docs.clear();
    },
  };
}

function createMockEmbedding(): EmbeddingProvider {
  return {
    dimensions: 3,
    embed: vi.fn().mockResolvedValue([1, 0, 0]),
    embedBatch: vi.fn().mockResolvedValue([[1, 0, 0]]),
  };
}

describe("SemanticCache", () => {
  it("returns null on empty cache", async () => {
    const cache = new SemanticCache({
      vectorStore: createMockVectorStore(),
      embedding: createMockEmbedding(),
    });

    const hit = await cache.lookup("test query");
    expect(hit).toBeNull();
  });

  it("stores and retrieves a cached response", async () => {
    const cache = new SemanticCache({
      vectorStore: createMockVectorStore(),
      embedding: createMockEmbedding(),
    });

    const output = {
      text: "The answer is 42",
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };

    await cache.store("What is the answer?", output, "agent1");

    const hit = await cache.lookup("What is the answer?", "agent1");
    expect(hit).not.toBeNull();
    expect(hit!.output.text).toBe("The answer is 42");
    expect(hit!.score).toBeGreaterThan(0.9);
  });

  it("respects TTL expiry", async () => {
    const cache = new SemanticCache({
      vectorStore: createMockVectorStore(),
      embedding: createMockEmbedding(),
      ttl: 1,
    });

    const output = { text: "cached", toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    await cache.store("q", output);

    await new Promise((r) => setTimeout(r, 10));

    const hit = await cache.lookup("q");
    expect(hit).toBeNull();
  });

  it("scopes by agent name", async () => {
    const vs = createMockVectorStore();
    const cache = new SemanticCache({
      vectorStore: vs,
      embedding: createMockEmbedding(),
      scope: "agent",
    });

    const output = { text: "res", toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    await cache.store("q", output, "agent-A");

    const hit = await cache.lookup("q", "agent-B");
    expect(hit).toBeNull();

    const hitSame = await cache.lookup("q", "agent-A");
    expect(hitSame).not.toBeNull();
  });

  it("invalidates a cached entry", async () => {
    const cache = new SemanticCache({
      vectorStore: createMockVectorStore(),
      embedding: createMockEmbedding(),
    });

    const output = { text: "res", toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    await cache.store("q", output);

    const hit = await cache.lookup("q");
    expect(hit).not.toBeNull();

    await cache.invalidate(hit!.id);

    const hitAfter = await cache.lookup("q");
    expect(hitAfter).toBeNull();
  });

  it("clears all cached entries", async () => {
    const cache = new SemanticCache({
      vectorStore: createMockVectorStore(),
      embedding: createMockEmbedding(),
    });

    const output = { text: "res", toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    await cache.store("q1", output);
    await cache.store("q2", output);

    await cache.clear();

    expect(await cache.lookup("q1")).toBeNull();
    expect(await cache.lookup("q2")).toBeNull();
  });
});
