import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { ContentPart } from "../models/types.js";
import { BaseVectorStore } from "./base.js";
import type { EmbeddingProvider, VectorDocument, VectorSearchOptions, VectorSearchResult } from "./types.js";

const _require = createRequire(import.meta.url);

export interface QdrantConfig {
  url?: string;
  apiKey?: string;
  dimensions?: number;
  checkCompatibility?: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Deterministic UUID from an arbitrary string.
 * Qdrant only accepts UUIDs or unsigned ints as point IDs,
 * so we hash arbitrary strings into valid UUID v4 format
 * and store the original ID in the payload under `_originalId`.
 */
function stringToUUID(str: string): string {
  const hex = createHash("md5").update(str).digest("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), `4${hex.slice(13, 16)}`, `8${hex.slice(17, 20)}`, hex.slice(20, 32)].join(
    "-",
  );
}

function toQdrantId(id: string): string | number {
  if (/^\d+$/.test(id)) return Number(id);
  if (UUID_RE.test(id)) return id;
  return stringToUUID(id);
}

export class QdrantVectorStore extends BaseVectorStore {
  private client: any;
  private dimensions: number;
  private initializedCollections = new Set<string>();

  constructor(config: QdrantConfig = {}, embedder?: EmbeddingProvider) {
    super(embedder);
    this.dimensions = config.dimensions ?? embedder?.dimensions ?? 1536;
    try {
      const { QdrantClient } = _require("@qdrant/js-client-rest");
      this.client = new QdrantClient({
        url: config.url ?? "http://localhost:6333",
        apiKey: config.apiKey,
        checkCompatibility: config.checkCompatibility ?? false,
      });
    } catch (e: any) {
      if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error(
          "@qdrant/js-client-rest is required for QdrantVectorStore. Install it: npm install @qdrant/js-client-rest",
        );
      }
      throw e;
    }
  }

  async initialize(): Promise<void> {}

  private collectionInitPromises = new Map<string, Promise<void>>();

  private async ensureCollection(collection: string): Promise<void> {
    if (this.initializedCollections.has(collection)) return;
    if (!this.collectionInitPromises.has(collection)) {
      this.collectionInitPromises.set(
        collection,
        this._initCollection(collection).finally(() => this.collectionInitPromises.delete(collection)),
      );
    }
    return this.collectionInitPromises.get(collection)!;
  }

  private async _initCollection(collection: string): Promise<void> {
    try {
      await this.client.getCollection(collection);
    } catch (e: any) {
      const status = e?.status ?? e?.statusCode ?? (e?.data?.status as Record<string, unknown>);
      const isNotFound = status === 404 || /not found/i.test(e?.message ?? "");
      if (!isNotFound) throw e;
      await this.client.createCollection(collection, {
        vectors: {
          size: this.dimensions,
          distance: "Cosine",
        },
      });
    }
    this.initializedCollections.add(collection);
  }

  async upsert(collection: string, doc: VectorDocument): Promise<void> {
    await this.ensureCollection(collection);
    const embedding = await this.ensureEmbedding(doc);
    await this.client.upsert(collection, {
      wait: true,
      points: [
        {
          id: toQdrantId(doc.id),
          vector: embedding,
          payload: {
            _originalId: doc.id,
            content: doc.content,
            ...(doc.metadata ?? {}),
          },
        },
      ],
    });
  }

  async upsertBatch(collection: string, docs: VectorDocument[]): Promise<void> {
    await this.ensureCollection(collection);
    const points = await Promise.all(
      docs.map(async (doc) => {
        const embedding = await this.ensureEmbedding(doc);
        return {
          id: toQdrantId(doc.id),
          vector: embedding,
          payload: {
            _originalId: doc.id,
            content: doc.content,
            ...(doc.metadata ?? {}),
          },
        };
      }),
    );
    await this.client.upsert(collection, { wait: true, points });
  }

  async search(
    collection: string,
    query: number[] | string | ContentPart[],
    options?: VectorSearchOptions,
  ): Promise<VectorSearchResult[]> {
    await this.ensureCollection(collection);
    const vec = await this.ensureQueryVector(query);
    const topK = options?.topK ?? 10;

    const searchParams: Record<string, unknown> = {
      vector: vec,
      limit: topK,
      with_payload: true,
    };

    if (options?.filter) {
      searchParams.filter = {
        must: Object.entries(options.filter).map(([key, value]) => ({
          key,
          match: { value },
        })),
      };
    }

    if (options?.minScore != null) {
      searchParams.score_threshold = options.minScore;
    }

    const results = await this.client.search(collection, searchParams);

    return results.map((r: any) => {
      const { _originalId, content, ...rest } = r.payload ?? {};
      return {
        id: _originalId ?? String(r.id),
        content: content ?? "",
        score: r.score,
        metadata: rest,
      };
    });
  }

  async delete(collection: string, id: string): Promise<void> {
    await this.ensureCollection(collection);
    await this.client.delete(collection, {
      wait: true,
      points: [toQdrantId(id)],
    });
  }

  async get(collection: string, id: string): Promise<VectorDocument | null> {
    await this.ensureCollection(collection);
    try {
      const results = await this.client.retrieve(collection, {
        ids: [toQdrantId(id)],
        with_payload: true,
      });
      if (!results || results.length === 0) return null;
      const point = results[0];
      const { _originalId, content, ...rest } = point.payload ?? {};
      return {
        id: _originalId ?? String(point.id),
        content: content ?? "",
        metadata: rest,
      };
    } catch (e: any) {
      const status = e?.status ?? e?.statusCode;
      if (status === 404 || /not found/i.test(e?.message ?? "")) return null;
      throw e;
    }
  }

  async dropCollection(collection: string): Promise<void> {
    try {
      await this.client.deleteCollection(collection);
    } catch (e: any) {
      const status = e?.status ?? e?.statusCode;
      if (status === 404 || /not found/i.test(e?.message ?? "")) return;
      throw e;
    }
    this.initializedCollections.delete(collection);
  }

  async close(): Promise<void> {
    // Qdrant JS client doesn't require explicit close
  }
}
