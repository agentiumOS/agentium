import { createRequire } from "node:module";
import type { StorageDriver } from "./driver.js";

const _require = createRequire(import.meta.url);

export interface MySQLStorageConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  connectionString?: string;
  tableName?: string;
}

export class MySQLStorage implements StorageDriver {
  private pool: any;
  private tableName: string;
  private initialized = false;

  constructor(private config: MySQLStorageConfig = {}) {
    this.tableName = config.tableName ?? "kv_store";

    let mysql2: any;
    try {
      mysql2 = _require("mysql2/promise");
    } catch {
      throw new Error("mysql2 is required for MySQLStorage. Install it: npm install mysql2");
    }

    if (config.connectionString) {
      this.pool = mysql2.createPool(config.connectionString);
    } else {
      this.pool = mysql2.createPool({
        host: config.host ?? "localhost",
        port: config.port ?? 3306,
        user: config.user ?? "root",
        password: config.password ?? "",
        database: config.database ?? "agentium",
      });
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        namespace VARCHAR(255) NOT NULL,
        \`key\` VARCHAR(255) NOT NULL,
        value JSON NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (namespace, \`key\`)
      )
    `);
    this.initialized = true;
  }

  async get<T>(namespace: string, key: string): Promise<T | null> {
    await this.initialize();
    const [rows] = await this.pool.execute(`SELECT value FROM ${this.tableName} WHERE namespace = ? AND \`key\` = ?`, [
      namespace,
      key,
    ]);
    if ((rows as any[]).length === 0) return null;
    return (rows as any[])[0].value as T;
  }

  async set<T>(namespace: string, key: string, value: T): Promise<void> {
    await this.initialize();
    await this.pool.execute(
      `INSERT INTO ${this.tableName} (namespace, \`key\`, value) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value)`,
      [namespace, key, JSON.stringify(value)],
    );
  }

  async delete(namespace: string, key: string): Promise<void> {
    await this.initialize();
    await this.pool.execute(`DELETE FROM ${this.tableName} WHERE namespace = ? AND \`key\` = ?`, [namespace, key]);
  }

  async list<T>(namespace: string, prefix?: string): Promise<Array<{ key: string; value: T }>> {
    await this.initialize();
    let query = `SELECT \`key\`, value FROM ${this.tableName} WHERE namespace = ?`;
    const params: string[] = [namespace];

    if (prefix) {
      query += ` AND \`key\` LIKE ?`;
      params.push(`${prefix}%`);
    }

    const [rows] = await this.pool.execute(query, params);
    return (rows as any[]).map((row: any) => ({
      key: row.key,
      value: row.value as T,
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
