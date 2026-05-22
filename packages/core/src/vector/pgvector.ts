import { createRequire } from "node:module";
import { BaseVectorStore } from "./base.js";
import type { EmbeddingProvider, VectorDocument, VectorSearchOptions, VectorSearchResult } from "./types.js";

const _require = createRequire(import.meta.url);

export interface PgVectorConfig {
  connectionString: string;
  dimensions?: number;
}

export class PgVectorStore extends BaseVectorStore {
  private pool: any;
  private dimensions: number;
  private initializedCollections = new Set<string>();

  constructor(config: PgVectorConfig, embedder?: EmbeddingProvider) {
    super(embedder);
    this.dimensions = config.dimensions ?? embedder?.dimensions ?? 1536;
    try {
      const { Pool } = _require("pg");
      this.pool = new Pool({ connectionString: config.connectionString });
    } catch (e: any) {
      if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error("pg is required for PgVectorStore. Install it: npm install pg");
      }
      throw e;
    }
  }

  async initialize(): Promise<void> {
    await this.pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  }

  private async ensureCollection(collection: string): Promise<void> {
    if (this.initializedCollections.has(collection)) return;
    const table = this.sanitize(collection);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${table} (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        embedding vector(${this.dimensions}),
        metadata JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${table}_embedding_idx
      ON ${table} USING hnsw (embedding vector_cosine_ops)
    `);
    this.initializedCollections.add(collection);
  }

  private sanitize(name: string): string {
    const clean = name.replace(/[^a-zA-Z0-9_]/g, "_");
    if (!clean || /^\d/.test(clean)) throw new Error(`Invalid collection name: ${name}`);
    return clean;
  }

  private toSql(vec: number[]): string {
    return `[${vec.join(",")}]`;
  }

  async upsert(collection: string, doc: VectorDocument): Promise<void> {
    await this.ensureCollection(collection);
    const embedding = await this.ensureEmbedding(doc);
    const table = this.sanitize(collection);
    await this.pool.query(
      `INSERT INTO ${table} (id, content, embedding, metadata)
       VALUES ($1, $2, $3::vector, $4::jsonb)
       ON CONFLICT (id)
       DO UPDATE SET content = EXCLUDED.content,
                     embedding = EXCLUDED.embedding,
                     metadata = EXCLUDED.metadata`,
      [doc.id, doc.content, this.toSql(embedding), JSON.stringify(doc.metadata ?? {})],
    );
  }

  async upsertBatch(collection: string, docs: VectorDocument[]): Promise<void> {
    if (docs.length === 0) return;
    await this.ensureCollection(collection);
    const table = this.sanitize(collection);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const valuePlaceholders: string[] = [];
      const params: unknown[] = [];
      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i];
        const embedding = await this.ensureEmbedding(doc);
        const offset = i * 4;
        valuePlaceholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}::vector, $${offset + 4}::jsonb)`);
        params.push(doc.id, doc.content, this.toSql(embedding), JSON.stringify(doc.metadata ?? {}));
      }

      await client.query(
        `INSERT INTO ${table} (id, content, embedding, metadata)
         VALUES ${valuePlaceholders.join(", ")}
         ON CONFLICT (id)
         DO UPDATE SET content = EXCLUDED.content,
                       embedding = EXCLUDED.embedding,
                       metadata = EXCLUDED.metadata`,
        params,
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async search(
    collection: string,
    query: number[] | string,
    options?: VectorSearchOptions,
  ): Promise<VectorSearchResult[]> {
    await this.ensureCollection(collection);
    const vec = await this.ensureQueryVector(query);
    const topK = options?.topK ?? 10;
    const table = this.sanitize(collection);

    let filterClause = "";
    const params: unknown[] = [this.toSql(vec), topK];

    if (options?.filter) {
      const conditions = Object.entries(options.filter).map(([k, v], i) => {
        if (!/^[a-zA-Z0-9_]+$/.test(k)) throw new Error(`Invalid metadata key: ${k}`);
        params.push(JSON.stringify(v));
        return `metadata->>'${k}' = $${i + 3}`;
      });
      if (conditions.length > 0) {
        filterClause = `WHERE ${conditions.join(" AND ")}`;
      }
    }

    const result = await this.pool.query(
      `SELECT id, content, metadata,
              1 - (embedding <=> $1::vector) AS score
       FROM ${table}
       ${filterClause}
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      params,
    );

    let rows = result.rows as Array<{
      id: string;
      content: string;
      score: number;
      metadata: Record<string, unknown>;
    }>;

    if (options?.minScore != null) {
      rows = rows.filter((r) => r.score >= options.minScore!);
    }

    return rows.map((r) => ({
      id: r.id,
      content: r.content,
      score: r.score,
      metadata: r.metadata,
    }));
  }

  async delete(collection: string, id: string): Promise<void> {
    await this.ensureCollection(collection);
    const table = this.sanitize(collection);
    await this.pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  }

  async get(collection: string, id: string): Promise<VectorDocument | null> {
    await this.ensureCollection(collection);
    const table = this.sanitize(collection);
    const result = await this.pool.query(`SELECT id, content, metadata FROM ${table} WHERE id = $1`, [id]);
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return { id: row.id, content: row.content, metadata: row.metadata };
  }

  async dropCollection(collection: string): Promise<void> {
    const table = this.sanitize(collection);
    await this.pool.query(`DROP TABLE IF EXISTS ${table}`);
    this.initializedCollections.delete(collection);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
