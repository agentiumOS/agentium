import { BaseVectorStore } from "./base.js";
import type { VectorDocument, VectorSearchOptions, VectorSearchResult } from "./types.js";

interface StoredDoc {
  id: string;
  content: string;
  embedding: number[];
  metadata: Record<string, unknown>;
}

export class InMemoryVectorStore extends BaseVectorStore {
  private collections = new Map<string, Map<string, StoredDoc>>();

  async initialize(): Promise<void> {}

  private getCol(collection: string): Map<string, StoredDoc> {
    let col = this.collections.get(collection);
    if (!col) {
      col = new Map();
      this.collections.set(collection, col);
    }
    return col;
  }

  async upsert(collection: string, doc: VectorDocument): Promise<void> {
    const embedding = await this.ensureEmbedding(doc);
    this.getCol(collection).set(doc.id, {
      id: doc.id,
      content: doc.content,
      embedding,
      metadata: doc.metadata ?? {},
    });
  }

  async upsertBatch(collection: string, docs: VectorDocument[]): Promise<void> {
    for (const doc of docs) {
      await this.upsert(collection, doc);
    }
  }

  async search(
    collection: string,
    query: number[] | string,
    options?: VectorSearchOptions,
  ): Promise<VectorSearchResult[]> {
    const vec = await this.ensureQueryVector(query);
    const topK = options?.topK ?? 10;
    const col = this.getCol(collection);

    const scored: VectorSearchResult[] = [];
    for (const doc of col.values()) {
      const score = this.cosineSimilarity(vec, doc.embedding);
      if (options?.minScore != null && score < options.minScore) continue;
      if (options?.filter) {
        let match = true;
        for (const [k, v] of Object.entries(options.filter)) {
          if (doc.metadata[k] !== v) {
            match = false;
            break;
          }
        }
        if (!match) continue;
      }
      scored.push({
        id: doc.id,
        content: doc.content,
        score,
        metadata: doc.metadata,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
    }
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  async delete(collection: string, id: string): Promise<void> {
    this.getCol(collection).delete(id);
  }

  async get(collection: string, id: string): Promise<VectorDocument | null> {
    const doc = this.getCol(collection).get(id);
    if (!doc) return null;
    return { id: doc.id, content: doc.content, metadata: doc.metadata };
  }

  async dropCollection(collection: string): Promise<void> {
    this.collections.delete(collection);
  }

  async close(): Promise<void> {
    this.collections.clear();
  }
}
