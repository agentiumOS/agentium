export interface VectorDocument {
  id: string;
  content: string;
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

export interface EmbeddingProvider {
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

export interface VectorStore {
  /** Initialize collections/indexes. Call once before use. */
  initialize(): Promise<void>;

  /** Upsert a single document (embedding computed if not provided). */
  upsert(collection: string, doc: VectorDocument): Promise<void>;

  /** Upsert multiple documents in batch. */
  upsertBatch(collection: string, docs: VectorDocument[]): Promise<void>;

  /** Similarity search by vector or text query. */
  search(collection: string, query: number[] | string, options?: VectorSearchOptions): Promise<VectorSearchResult[]>;

  /** Delete a document by ID. */
  delete(collection: string, id: string): Promise<void>;

  /** Get a document by ID. */
  get(collection: string, id: string): Promise<VectorDocument | null>;

  /** Drop an entire collection. */
  dropCollection(collection: string): Promise<void>;

  /** Close connections. */
  close(): Promise<void>;
}
