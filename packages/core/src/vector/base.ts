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
