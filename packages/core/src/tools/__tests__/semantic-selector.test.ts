import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { EmbeddingProvider } from "../../vector/types.js";
import { defineTool } from "../define-tool.js";
import { SemanticToolSelector } from "../semantic-selector.js";

/**
 * Deterministic test embedder: maps each pre-set string to a fixed vector.
 * Unknown strings map to a zero vector so cosine is 0.
 */
function makeStaticEmbedder(map: Record<string, number[]>): EmbeddingProvider {
  return {
    dimensions: 3,
    embed: async (text: string) => map[text] ?? [0, 0, 0],
    embedBatch: async (texts: string[]) => texts.map((t) => map[t] ?? [0, 0, 0]),
  };
}

const tools = [
  defineTool({ name: "weather", description: "Get the weather", parameters: z.object({}), execute: async () => "ok" }),
  defineTool({ name: "calc", description: "Math operations", parameters: z.object({}), execute: async () => "ok" }),
  defineTool({ name: "search", description: "Search the web", parameters: z.object({}), execute: async () => "ok" }),
];

describe("SemanticToolSelector", () => {
  it("returns empty when no tools are indexed", async () => {
    const embedder = makeStaticEmbedder({});
    const sel = new SemanticToolSelector({ embedder });
    expect(await sel.select("anything")).toEqual([]);
  });

  it("indexes tools by name+description and selects by cosine similarity", async () => {
    const embedder = makeStaticEmbedder({
      "weather: Get the weather": [1, 0, 0],
      "calc: Math operations": [0, 1, 0],
      "search: Search the web": [0, 0, 1],
      "what is the weather?": [1, 0, 0],
    });
    const sel = new SemanticToolSelector({ embedder, topK: 2 });
    await sel.indexTools(tools);
    expect(sel.size).toBe(3);
    const picked = await sel.select("what is the weather?", { topK: 1 });
    expect(picked.map((t) => t.name)).toEqual(["weather"]);
  });

  it("respects topK", async () => {
    const embedder = makeStaticEmbedder({
      "weather: Get the weather": [1, 0, 0],
      "calc: Math operations": [0.9, 0.1, 0],
      "search: Search the web": [0.8, 0.2, 0],
      query: [1, 0, 0],
    });
    const sel = new SemanticToolSelector({ embedder, topK: 2 });
    await sel.indexTools(tools);
    const picked = await sel.select("query");
    expect(picked).toHaveLength(2);
    expect(picked.map((t) => t.name)).toEqual(["weather", "calc"]);
  });

  it("integrates with a reranker", async () => {
    const embedder = makeStaticEmbedder({
      "weather: Get the weather": [1, 0, 0],
      "calc: Math operations": [0.9, 0.1, 0],
      "search: Search the web": [0.8, 0.2, 0],
      query: [1, 0, 0],
    });
    // Reranker flips order: prefer "search" over "weather".
    const reranker = {
      providerId: "mock",
      rerank: vi.fn(async (_q: string, docs: any[], opts?: any) => {
        const scoreMap: Record<string, number> = { weather: 0.1, calc: 0.5, search: 0.9 };
        const ranked = docs
          .map((d, i) => {
            const id = typeof d === "string" ? "" : (d.id ?? "");
            return { index: i, score: scoreMap[id] ?? 0, content: typeof d === "string" ? d : d.content, id };
          })
          .sort((a, b) => b.score - a.score);
        return opts?.topK ? ranked.slice(0, opts.topK) : ranked;
      }),
    };
    const sel = new SemanticToolSelector({ embedder, reranker, topK: 1, rerankMultiplier: 3 });
    await sel.indexTools(tools);
    const picked = await sel.select("query");
    expect(picked[0]?.name).toBe("search");
    expect(reranker.rerank).toHaveBeenCalledOnce();
  });

  it("returns 0-score tools last", async () => {
    const embedder = makeStaticEmbedder({
      "weather: Get the weather": [1, 0, 0],
      query: [1, 0, 0],
    });
    const sel = new SemanticToolSelector({ embedder, topK: 3 });
    await sel.indexTools(tools);
    const picked = await sel.select("query");
    expect(picked[0]?.name).toBe("weather");
  });
});
