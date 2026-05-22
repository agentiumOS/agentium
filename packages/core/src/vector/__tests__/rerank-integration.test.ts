import { describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "../../index.js";
import type { RerankDocument, Reranker, RerankResult } from "../../rerank/types.js";
import { InMemoryVectorStore } from "../in-memory.js";

function makeMockReranker(scoreMap: Record<string, number>): Reranker & { rerank: ReturnType<typeof vi.fn> } {
  return {
    providerId: "mock",
    rerank: vi.fn(async (_query: string, docs: RerankDocument[], options?) => {
      let ranked: RerankResult[] = docs.map((d, i) => {
        const content = typeof d === "string" ? d : d.content;
        const id = typeof d === "string" ? undefined : d.id;
        return {
          index: i,
          score: scoreMap[content] ?? 0,
          content,
          id,
          metadata: typeof d === "string" ? undefined : d.metadata,
        };
      });
      ranked.sort((a, b) => b.score - a.score);
      if (options?.minScore != null) ranked = ranked.filter((r) => r.score >= options.minScore!);
      if (options?.topK != null) ranked = ranked.slice(0, options.topK);
      return ranked;
    }),
  };
}

/** Trivial text-to-vector embedder for tests: maps text to a fixed unit vector along the first axis. */
function makeTextEmbedder(): EmbeddingProvider {
  return {
    dimensions: 3,
    supportsMultimodal: false,
    embed: async () => [1, 0, 0],
    embedBatch: async (texts) => texts.map(() => [1, 0, 0]),
  };
}

describe("BaseVectorStore rerank integration (via InMemoryVectorStore)", () => {
  const docs = [
    { id: "1", content: "apple", embedding: [1, 0, 0], metadata: {} },
    { id: "2", content: "banana", embedding: [0.9, 0.1, 0], metadata: {} },
    { id: "3", content: "cherry", embedding: [0.8, 0.2, 0], metadata: {} },
    { id: "4", content: "date", embedding: [0.7, 0.3, 0], metadata: {} },
    { id: "5", content: "elderberry", embedding: [0.6, 0.4, 0], metadata: {} },
  ];

  async function seed() {
    const store = new InMemoryVectorStore(makeTextEmbedder());
    for (const d of docs) await store.upsert("fruits", d);
    return store;
  }

  it("returns vector-ordered results when no reranker is configured", async () => {
    const store = await seed();
    const results = await store.search("fruits", [1, 0, 0], { topK: 3 });
    expect(results.map((r) => r.id)).toEqual(["1", "2", "3"]);
  });

  it("fetches topK*multiplier candidates when reranker is configured (text query)", async () => {
    const store = await seed();
    const reranker = makeMockReranker({ apple: 0.1, banana: 0.2, cherry: 0.3, date: 0.95, elderberry: 0.4 });
    const results = await store.search("fruits", "find tasty fruit", {
      topK: 2,
      rerank: reranker,
      rerankMultiplier: 3,
    });

    expect(reranker.rerank).toHaveBeenCalledOnce();
    const docsPassedToReranker = reranker.rerank.mock.calls[0][1] as RerankDocument[];
    expect(docsPassedToReranker.length).toBe(5);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("4");
    expect(results[1].id).toBe("5");
  });

  it("uses default rerank multiplier of 3", async () => {
    const store = await seed();
    const reranker = makeMockReranker({});
    await store.search("fruits", "query", { topK: 1, rerank: reranker });
    const docsPassedToReranker = reranker.rerank.mock.calls[0][1] as RerankDocument[];
    expect(docsPassedToReranker.length).toBe(3);
  });

  it("uses query text directly for rerank when query is a string", async () => {
    const store = await seed();
    const reranker = makeMockReranker({});
    await store.search("fruits", "find tasty fruit", { topK: 2, rerank: reranker });
    const queryPassed = reranker.rerank.mock.calls[0][0];
    expect(queryPassed).toBe("find tasty fruit");
  });

  it("skips reranker for pure-vector queries (no original text)", async () => {
    const store = await seed();
    const reranker = makeMockReranker({});
    const results = await store.search("fruits", [1, 0, 0], { topK: 2, rerank: reranker });
    expect(reranker.rerank).not.toHaveBeenCalled();
    expect(results).toHaveLength(2);
  });

  it("propagates minScore through to reranker filter", async () => {
    const store = await seed();
    const reranker = makeMockReranker({});
    await store.search("fruits", "query", { topK: 2, minScore: 0.7, rerank: reranker });
    const opts = reranker.rerank.mock.calls[0][2];
    expect(opts.minScore).toBe(0.7);
  });

  it("does not apply minScore filter to initial fetch when reranker is set (rerank decides)", async () => {
    const store = await seed();
    const reranker = makeMockReranker({ apple: 0.95, banana: 0.9 });
    const results = await store.search("fruits", "query", {
      topK: 2,
      minScore: 0.99, // would filter everything out if applied to initial fetch
      rerank: reranker,
    });
    expect(reranker.rerank).toHaveBeenCalledOnce();
    // ranker returns scores 0.95 and 0.9 — both below 0.99 so filtered by reranker minScore
    expect(results).toHaveLength(0);
  });
});
