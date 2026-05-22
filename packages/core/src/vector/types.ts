import type { ContentPart } from "../models/types.js";

export interface VectorDocument {
  id: string;
  content: string;
  /**
   * Optional multimodal payload (text, image, audio, video, PDF). When set and non-empty,
   * the configured `EmbeddingProvider` must implement `embedMultimodal`; the parts will
   * be used for embedding instead of `content`.
   */
  parts?: ContentPart[];
  embedding?: number[];
  metadata?: Record<string, unknown>;
}

export interface VectorSearchResult {
  id: string;
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface VectorSearchOptions {
  topK?: number;
  filter?: Record<string, unknown>;
  minScore?: number;
}

/**
 * Input accepted by multimodal-capable embedding providers. Always produces one vector.
 */
export type EmbeddingInput = string | ContentPart | ContentPart[];

export interface EmbeddingProvider {
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  /**
   * Optional: embed a single multimodal input (text + images + audio + video + PDFs).
   * Returns ONE aggregated vector. Implementations should throw if the configured model
   * does not support multimodal input.
   */
  embedMultimodal?(input: EmbeddingInput): Promise<number[]>;
  /** Whether this provider/model supports `embedMultimodal`. */
  readonly supportsMultimodal?: boolean;
}

export interface VectorStore {
  /** Initialize collections/indexes. Call once before use. */
  initialize(): Promise<void>;

  /** Upsert a single document (embedding computed if not provided). */
  upsert(collection: string, doc: VectorDocument): Promise<void>;

  /** Upsert multiple documents in batch. */
  upsertBatch(collection: string, docs: VectorDocument[]): Promise<void>;

  /**
   * Similarity search by vector, text query, or multimodal `ContentPart[]` query.
   * Multimodal queries require an `EmbeddingProvider` with `embedMultimodal` support.
   */
  search(
    collection: string,
    query: number[] | string | ContentPart[],
    options?: VectorSearchOptions,
  ): Promise<VectorSearchResult[]>;

  /** Delete a document by ID. */
  delete(collection: string, id: string): Promise<void>;

  /** Get a document by ID. */
  get(collection: string, id: string): Promise<VectorDocument | null>;

  /** Drop an entire collection. */
  dropCollection(collection: string): Promise<void>;

  /** Close connections. */
  close(): Promise<void>;
}
