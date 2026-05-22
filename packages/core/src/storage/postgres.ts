import { createRequire } from "node:module";
import type { StorageDriver } from "./driver.js";

const _require = createRequire(import.meta.url);

export class PostgresStorage implements StorageDriver {
  private pool: any;

  constructor(connectionString: string) {
    try {
      const { Pool } = _require("pg");
      this.pool = new Pool({ connectionString });
    } catch (e: any) {
      if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error("pg is required for PostgresStorage. Install it: npm install pg");
      }
      throw e;
    }
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS kv_store (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (namespace, key)
      )
    `);
  }

  async get<T>(namespace: string, key: string): Promise<T | null> {
    const result = await this.pool.query("SELECT value FROM kv_store WHERE namespace = $1 AND key = $2", [
      namespace,
      key,
    ]);
    if (result.rows.length === 0) return null;
    return result.rows[0].value as T;
  }

  async set<T>(namespace: string, key: string, value: T): Promise<void> {
    await this.pool.query(
      `INSERT INTO kv_store (namespace, key, value, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (namespace, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [namespace, key, JSON.stringify(value)],
    );
  }

  async delete(namespace: string, key: string): Promise<void> {
    await this.pool.query("DELETE FROM kv_store WHERE namespace = $1 AND key = $2", [namespace, key]);
  }

  async list<T>(namespace: string, prefix?: string): Promise<Array<{ key: string; value: T }>> {
    const result = prefix
      ? await this.pool.query("SELECT key, value FROM kv_store WHERE namespace = $1 AND key LIKE $2", [
          namespace,
          `${prefix}%`,
        ])
      : await this.pool.query("SELECT key, value FROM kv_store WHERE namespace = $1", [namespace]);

    return result.rows.map((row: { key: string; value: T }) => ({
      key: row.key,
      value: row.value,
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
