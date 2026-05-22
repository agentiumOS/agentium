import { createRequire } from "node:module";
import type { StorageDriver } from "./driver.js";

const _require = createRequire(import.meta.url);

export class SqliteStorage implements StorageDriver {
  private db: any;

  constructor(dbPath: string) {
    try {
      const Database = _require("better-sqlite3");
      this.db = new Database(dbPath);
      this.db.pragma("journal_mode = WAL");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS kv_store (
          namespace TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          updated_at TEXT DEFAULT (datetime('now')),
          PRIMARY KEY (namespace, key)
        )
      `);
    } catch (e: any) {
      if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error("better-sqlite3 is required for SqliteStorage. Install it: npm install better-sqlite3");
      }
      throw e;
    }
  }

  async get<T>(namespace: string, key: string): Promise<T | null> {
    const row = this.db.prepare("SELECT value FROM kv_store WHERE namespace = ? AND key = ?").get(namespace, key) as
      | { value: string }
      | undefined;
    if (!row) return null;
    return JSON.parse(row.value) as T;
  }

  async set<T>(namespace: string, key: string, value: T): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO kv_store (namespace, key, value, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(namespace, key)
         DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      )
      .run(namespace, key, JSON.stringify(value));
  }

  async delete(namespace: string, key: string): Promise<void> {
    this.db.prepare("DELETE FROM kv_store WHERE namespace = ? AND key = ?").run(namespace, key);
  }

  async list<T>(namespace: string, prefix?: string): Promise<Array<{ key: string; value: T }>> {
    const rows = prefix
      ? (this.db
          .prepare("SELECT key, value FROM kv_store WHERE namespace = ? AND key LIKE ?")
          .all(namespace, `${prefix}%`) as Array<{
          key: string;
          value: string;
        }>)
      : (this.db.prepare("SELECT key, value FROM kv_store WHERE namespace = ?").all(namespace) as Array<{
          key: string;
          value: string;
        }>);

    return rows.map((row) => ({
      key: row.key,
      value: JSON.parse(row.value) as T,
    }));
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
