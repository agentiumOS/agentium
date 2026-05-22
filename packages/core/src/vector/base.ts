import type { ContentPart } from "../models/types.js";
import type {
  EmbeddingProvider,
  VectorDocument,
  VectorSearchOptions,
  VectorSearchResult,
  VectorStore,
} from "./types.js";

export abstract class BaseVectorStore implements VectorStore {
  constructor(protected embedder?: EmbeddingProvider) {}

  protected async ensureEmbedding(doc: VectorDocument): Promise<number[]> {
    if (doc.embedding) return doc.embedding;
    if (!this.embedder) {
      throw new Error("No embedding provided on document and no EmbeddingProvider configured");
    }
    if (doc.parts && doc.parts.length > 0) {
      if (!this.embedder.embedMultimodal) {
        throw new Error(
          `Document has multimodal parts but ${this.embedder.constructor.name} is text-only. ` +
            'Use GoogleEmbedding with model "gemini-embedding-2" for multimodal support.',
        );
      }
      return this.embedder.embedMultimodal(doc.parts);
    }
    return this.embedder.embed(doc.content);
  }

  protected async ensureQueryVector(query: number[] | string | ContentPart[]): Promise<number[]> {
    if (isNumberArray(query)) return query;
    if (!this.embedder) {
      throw new Error("Non-vector query requires an EmbeddingProvider to be configured");
    }
    if (typeof query === "string") {
      return this.embedder.embed(query);
    }
    // ContentPart[] query
    if (!this.embedder.embedMultimodal) {
      throw new Error(
        `Multimodal query requires an embedder with embedMultimodal support. ` +
          `${this.embedder.constructor.name} is text-only.`,
      );
    }
    return this.embedder.embedMultimodal(query);
  }

  /**
   * If a reranker is configured in `options`, returns the candidate `topK` for the
   * initial fetch (effectively `topK * rerankMultiplier`). Otherwise returns `topK`
   * (defaulting to 10).
   *
   * Backends call this to size the initial vector search.
   */
  protected effectiveFetchK(options?: VectorSearchOptions): number {
    const topK = options?.topK ?? 10;
    if (!options?.rerank) return topK;
    const mult = options.rerankMultiplier ?? 3;
    return Math.max(topK, topK * mult);
  }

  /**
   * Applies the configured reranker (if any) to the initial vector results.
   * Returns the original results untouched when no reranker is configured.
   *
   * For text or multimodal queries, the original input is reused as the reranker
   * query. For pure numeric vector queries (no original text), reranking is
   * skipped because rerankers require a textual query.
   */
  protected async applyRerank(
    originalQuery: number[] | string | ContentPart[],
    results: VectorSearchResult[],
    options?: VectorSearchOptions,
  ): Promise<VectorSearchResult[]> {
    if (!options?.rerank || results.length === 0) return results;

    let queryText: string | null = null;
    if (typeof originalQuery === "string") {
      queryText = originalQuery;
    } else if (Array.isArray(originalQuery) && originalQuery.length > 0 && typeof originalQuery[0] === "object") {
      // ContentPart[]: extract text parts
      const parts = originalQuery as ContentPart[];
      queryText = parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join(" ")
        .trim();
      if (!queryText) queryText = null;
    }

    if (!queryText) {
      // Pure-vector query (or multimodal query with no text parts) cannot be reranked.
      return results.slice(0, options?.topK ?? 10);
    }

    const topK = options?.topK ?? 10;
    const reranked = await options.rerank.rerank(
      queryText,
      results.map((r) => ({ id: r.id, content: r.content, metadata: r.metadata })),
      { topK, minScore: options.minScore },
    );

    return reranked.map((r) => ({
      id: r.id ?? results[r.index].id,
      content: r.content,
      score: r.score,
      metadata: r.metadata,
    }));
  }

  abstract initialize(): Promise<void>;
  abstract upsert(collection: string, doc: VectorDocument): Promise<void>;
  abstract upsertBatch(collection: string, docs: VectorDocument[]): Promise<void>;
  abstract search(
    collection: string,
    query: number[] | string | ContentPart[],
    options?: VectorSearchOptions,
  ): Promise<VectorSearchResult[]>;
  abstract delete(collection: string, id: string): Promise<void>;
  abstract get(collection: string, id: string): Promise<VectorDocument | null>;
  abstract dropCollection(collection: string): Promise<void>;
  abstract close(): Promise<void>;
}

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && (v.length === 0 || typeof v[0] === "number");
}
