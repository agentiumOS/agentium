/**
 * Document input for reranking.
 * Accepts either a plain string, a `VectorSearchResult`-like object, or any shape
 * with a textual `content` field.
 */
export type RerankDocument =
  | string
  | {
      id?: string;
      content: string;
      metadata?: Record<string, unknown>;
    };

export interface RerankResult {
  /** Original index in the input array (useful when callers want to keep their own metadata). */
  index: number;
  /** Relevance score from the reranker. Higher is more relevant. */
  score: number;
  /** Document content as fed to the reranker. */
  content: string;
  /** Original metadata, if the input was an object. */
  metadata?: Record<string, unknown>;
  /** Original id, if the input was an object. */
  id?: string;
}

export interface RerankOptions {
  /** Maximum number of results to return. If undefined, returns all reranked. */
  topK?: number;
  /** Minimum score threshold; results below this are dropped. */
  minScore?: number;
}

export interface Reranker {
  /** Name of the provider/model (for logging). */
  readonly providerId: string;
  /**
   * Reorder documents by relevance to a query.
   * Returns results sorted by score descending.
   */
  rerank(query: string, documents: RerankDocument[], options?: RerankOptions): Promise<RerankResult[]>;
}

/**
 * Internal helper: normalize a RerankDocument to a plain string content + metadata.
 */
export function toRerankInput(doc: RerankDocument): {
  content: string;
  id?: string;
  metadata?: Record<string, unknown>;
} {
  if (typeof doc === "string") return { content: doc };
  return { content: doc.content, id: doc.id, metadata: doc.metadata };
}
