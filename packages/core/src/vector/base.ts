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
    return this.embedder.embed(doc.content);
  }

  protected async ensureQueryVector(query: number[] | string): Promise<number[]> {
    if (Array.isArray(query)) return query;
    if (!this.embedder) {
      throw new Error("String query requires an EmbeddingProvider to be configured");
    }
    return this.embedder.embed(query);
  }

  abstract initialize(): Promise<void>;
  abstract upsert(collection: string, doc: VectorDocument): Promise<void>;
  abstract upsertBatch(collection: string, docs: VectorDocument[]): Promise<void>;
  abstract search(
    collection: string,
    query: number[] | string,
    options?: VectorSearchOptions,
  ): Promise<VectorSearchResult[]>;
  abstract delete(collection: string, id: string): Promise<void>;
  abstract get(collection: string, id: string): Promise<VectorDocument | null>;
  abstract dropCollection(collection: string): Promise<void>;
  abstract close(): Promise<void>;
}
