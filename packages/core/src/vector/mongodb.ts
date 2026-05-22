import { createRequire } from "node:module";
import type { ContentPart } from "../models/types.js";
import { BaseVectorStore } from "./base.js";
import type { EmbeddingProvider, VectorDocument, VectorSearchOptions, VectorSearchResult } from "./types.js";

const _require = createRequire(import.meta.url);

export interface MongoDBVectorConfig {
  uri: string;
  dbName?: string;
  /** Atlas Search index name (must be pre-created for $vectorSearch). Defaults to "vector_index". */
  indexName?: string;
}

export class MongoDBVectorStore extends BaseVectorStore {
  private client: any;
  private db: any;
  private indexName: string;
  private dbName: string;
  private useAtlas: boolean | null = null;

  constructor(config: MongoDBVectorConfig, embedder?: EmbeddingProvider) {
    super(embedder);
    this.indexName = config.indexName ?? "vector_index";
    this.dbName = config.dbName ?? "agentium_vectors";
    try {
      const { MongoClient } = _require("mongodb");
      this.client = new MongoClient(config.uri);
    } catch (e: any) {
      if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error("mongodb is required for MongoDBVectorStore. Install it: npm install mongodb");
      }
      throw e;
    }
  }

  async initialize(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(this.dbName);
  }

  private col(collection: string) {
    return this.db.collection(collection);
  }

  async upsert(collection: string, doc: VectorDocument): Promise<void> {
    const embedding = await this.ensureEmbedding(doc);
    await this.col(collection).updateOne(
      { _id: doc.id },
      {
        $set: {
          content: doc.content,
          embedding,
          metadata: doc.metadata ?? {},
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }

  async upsertBatch(collection: string, docs: VectorDocument[]): Promise<void> {
    const ops = await Promise.all(
      docs.map(async (doc) => {
        const embedding = await this.ensureEmbedding(doc);
        return {
          updateOne: {
            filter: { _id: doc.id },
            update: {
              $set: {
                content: doc.content,
                embedding,
                metadata: doc.metadata ?? {},
                updatedAt: new Date(),
              },
            },
            upsert: true,
          },
        };
      }),
    );
    if (ops.length > 0) {
      await this.col(collection).bulkWrite(ops);
    }
  }

  async search(
    collection: string,
    query: number[] | string | ContentPart[],
    options?: VectorSearchOptions,
  ): Promise<VectorSearchResult[]> {
    const vec = await this.ensureQueryVector(query);

    if (this.useAtlas === true) {
      return this.atlasSearch(collection, vec, options);
    }

    if (this.useAtlas === false) {
      return this.localSearch(collection, vec, options);
    }

    // First call: auto-detect Atlas support
    try {
      const results = await this.atlasSearch(collection, vec, options);
      this.useAtlas = true;
      return results;
    } catch (e: any) {
      const code = e?.codeName ?? e?.code;
      const isAtlasUnavailable =
        code === "AtlasSearchNotEnabled" ||
        code === "CommandNotFound" ||
        code === 59 ||
        /\$vectorSearch|\$search|atlas/i.test(e?.message ?? "");
      if (isAtlasUnavailable) {
        this.useAtlas = false;
        return this.localSearch(collection, vec, options);
      }
      throw e;
    }
  }

  private async atlasSearch(
    collection: string,
    vec: number[],
    options?: VectorSearchOptions,
  ): Promise<VectorSearchResult[]> {
    const topK = options?.topK ?? 10;

    const pipeline: Record<string, unknown>[] = [
      {
        $vectorSearch: {
          index: this.indexName,
          path: "embedding",
          queryVector: vec,
          numCandidates: topK * 10,
          limit: topK,
          ...(options?.filter ? { filter: this.buildFilter(options.filter) } : {}),
        },
      },
      {
        $addFields: {
          score: { $meta: "vectorSearchScore" },
        },
      },
    ];

    if (options?.minScore != null) {
      pipeline.push({ $match: { score: { $gte: options.minScore } } });
    }

    pipeline.push({
      $project: { _id: 1, content: 1, score: 1, metadata: 1 },
    });

    const results = await this.col(collection).aggregate(pipeline).toArray();

    return results.map((r: any) => ({
      id: String(r._id),
      content: r.content ?? "",
      score: r.score,
      metadata: r.metadata,
    }));
  }

  private async localSearch(
    collection: string,
    vec: number[],
    options?: VectorSearchOptions,
  ): Promise<VectorSearchResult[]> {
    console.warn(
      "[agentium] MongoDB Atlas $vectorSearch not available, using local brute-force search. This loads all documents into memory and is not recommended for production.",
    );
    const topK = options?.topK ?? 10;
    const filter: Record<string, unknown> = {};
    if (options?.filter) {
      for (const [k, v] of Object.entries(options.filter)) {
        filter[`metadata.${k}`] = v;
      }
    }

    const MAX_LOCAL_DOCS = 10000;
    const docs = await this.col(collection)
      .find(filter, { projection: { _id: 1, content: 1, embedding: 1, metadata: 1 } })
      .limit(MAX_LOCAL_DOCS)
      .toArray();

    const scored: VectorSearchResult[] = [];
    for (const doc of docs) {
      if (!doc.embedding) continue;
      const score = cosine(vec, doc.embedding);
      if (options?.minScore != null && score < options.minScore) continue;
      scored.push({
        id: String(doc._id),
        content: doc.content ?? "",
        score,
        metadata: doc.metadata,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  private buildFilter(filter: Record<string, unknown>): Record<string, unknown> {
    const conditions: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(filter)) {
      conditions[`metadata.${key}`] = value;
    }
    return conditions;
  }

  async delete(collection: string, id: string): Promise<void> {
    await this.col(collection).deleteOne({ _id: id });
  }

  async get(collection: string, id: string): Promise<VectorDocument | null> {
    const doc = await this.col(collection).findOne({ _id: id });
    if (!doc) return null;
    return {
      id: String(doc._id),
      content: doc.content,
      metadata: doc.metadata,
    };
  }

  async dropCollection(collection: string): Promise<void> {
    try {
      await this.col(collection).drop();
    } catch {
      // collection may not exist
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

function cosine(a: number[], b: number[]): number {
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
