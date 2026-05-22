import type { Reranker } from "../rerank/types.js";
import { reciprocalRankFusion } from "../vector/rrf.js";
import type { VectorSearchResult, VectorStore } from "../vector/types.js";
import type { GraphRAGRetriever } from "./retriever.js";

export interface HybridRetrieverConfig {
  /** Vector backend (for semantic search). */
  vector?: { store: VectorStore; collection: string; topK?: number };
  /** Graph backend (for structured reasoning). */
  graph?: { retriever: GraphRAGRetriever };
  /** Optional reranker for the fused result set. */
  rerank?: Reranker;
  /** Max results returned from the fused pipeline. */
  topK?: number;
}

export interface HybridResult {
  /** Source label (which sub-retriever produced the row). */
  source: "vector" | "graph";
  /** Stable identifier. */
  id: string;
  /** Text rendering. */
  content: string;
  /** RRF / rerank score. */
  score: number;
}

/**
 * Compose vector retrieval + graph retrieval into a single pipeline:
 *
 *   1. Run both sub-retrievers in parallel.
 *   2. Fuse with reciprocal rank fusion (default k=60).
 *   3. Optionally rerank the top fused set.
 */
export class HybridRetriever {
  private cfg: HybridRetrieverConfig;

  constructor(config: HybridRetrieverConfig) {
    this.cfg = config;
  }

  async retrieve(query: string): Promise<HybridResult[]> {
    const topK = this.cfg.topK ?? 10;

    const [vectorRows, graphRows] = await Promise.all([
      this.cfg.vector
        ? this.cfg.vector.store.search(this.cfg.vector.collection, query, { topK: this.cfg.vector.topK ?? topK })
        : Promise.resolve<VectorSearchResult[]>([]),
      this.cfg.graph ? this.cfg.graph.retriever.retrieve(query).then((r) => r.records) : Promise.resolve([]),
    ]);

    const vectorRanked = vectorRows.map((r, i) => ({
      id: `v:${r.id}`,
      content: r.content,
      score: r.score,
      rank: i + 1,
    }));

    // For graph, synthesize an id+content from each record row.
    const graphRanked = graphRows.map((r, i) => {
      const idCandidate = Object.values(r.values)
        .find((v) => v && typeof v === "object" && "identity" in (v as any))
        ?.toString();
      const content = Object.entries(r.values)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(", ");
      return {
        id: `g:${idCandidate ?? `row-${i}`}`,
        content,
        score: 1 - i / Math.max(graphRows.length, 1),
        rank: i + 1,
      };
    });

    const fused = reciprocalRankFusion([vectorRanked, graphRanked], { k: 60 });

    // Combine + cap, mapping back to HybridResult shape.
    const fusedRows: HybridResult[] = fused.slice(0, topK * 3).map((row) => {
      const fromVector = vectorRanked.find((v) => v.id === row.id);
      const fromGraph = graphRanked.find((g) => g.id === row.id);
      const source: "vector" | "graph" = fromVector ? "vector" : "graph";
      const content = fromVector?.content ?? fromGraph?.content ?? "";
      return { source, id: row.id, content, score: row.score };
    });

    if (!this.cfg.rerank) return fusedRows.slice(0, topK);

    const reranked = await this.cfg.rerank.rerank(
      query,
      fusedRows.map((r) => ({ id: r.id, content: r.content })),
      { topK },
    );
    const byId = new Map(fusedRows.map((r) => [r.id, r]));
    return reranked
      .map((r) => {
        const base = byId.get(r.id ?? "");
        return base ? { ...base, score: r.score } : undefined;
      })
      .filter((r): r is HybridResult => !!r);
  }
}
