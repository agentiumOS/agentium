import { createRequire } from "node:module";
import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

const _require = createRequire(import.meta.url);

export interface SqlConfig {
  /** Database dialect. */
  dialect: "sqlite" | "postgres" | "mysql";
  /** Connection string or file path (for sqlite). */
  connectionString: string;
  /** Restrict to read-only queries (default true). */
  readOnly?: boolean;
  /** Max rows to return per query (default 100). */
  maxRows?: number;
}

/**
 * SQL Database Toolkit — query databases from your agent.
 *
 * Supports SQLite (via `better-sqlite3`), PostgreSQL (via `pg`), and MySQL (via `mysql2`).
 * Install the appropriate driver as a peer dependency.
 *
 * Read-only by default — only SELECT, SHOW, DESCRIBE, EXPLAIN, and PRAGMA are allowed.
 *
 * @example
 * ```ts
 * const sql = new SqlToolkit({ dialect: "sqlite", connectionString: "./data.db" });
 * const agent = new Agent({ tools: [...sql.getTools()] });
 * ```
 */
export class SqlToolkit extends Toolkit {
  readonly name = "sql";
  private config: SqlConfig;
  private connection: any = null;

  constructor(config: SqlConfig) {
    super();
    this.config = { readOnly: true, maxRows: 100, ...config };
  }

  private validateQuery(query: string): void {
    if (!this.config.readOnly) return;

    const trimmed = query.trim().toUpperCase();
    const allowed = ["SELECT", "SHOW", "DESCRIBE", "EXPLAIN", "PRAGMA", "WITH"];
    const startsWithAllowed = allowed.some((kw) => trimmed.startsWith(kw));

    if (!startsWithAllowed) {
      throw new Error("Read-only mode: only SELECT, SHOW, DESCRIBE, EXPLAIN, PRAGMA, and WITH queries are allowed.");
    }
  }

  private async getConnection(): Promise<any> {
    if (this.connection) return this.connection;

    switch (this.config.dialect) {
      case "sqlite": {
        const Database = _require("better-sqlite3");
        this.connection = new Database(this.config.connectionString, {
          readonly: this.config.readOnly,
        });
        return this.connection;
      }
      case "postgres": {
        const { Client } = _require("pg");
        const client = new Client({ connectionString: this.config.connectionString });
        await client.connect();
        this.connection = client;
        return this.connection;
      }
      case "mysql": {
        const mysql = _require("mysql2/promise");
        this.connection = await mysql.createConnection(this.config.connectionString);
        return this.connection;
      }
      default:
        throw new Error(`Unsupported dialect: ${this.config.dialect}`);
    }
  }

  private async executeQuery(query: string): Promise<Array<Record<string, unknown>>> {
    const conn = await this.getConnection();
    const maxRows = this.config.maxRows ?? 100;

    switch (this.config.dialect) {
      case "sqlite": {
        const rows = conn.prepare(query).all();
        return (rows as Array<Record<string, unknown>>).slice(0, maxRows);
      }
      case "postgres": {
        const result = await conn.query(query);
        return (result.rows as Array<Record<string, unknown>>).slice(0, maxRows);
      }
      case "mysql": {
        const [rows] = await conn.execute(query);
        return (rows as Array<Record<string, unknown>>).slice(0, maxRows);
      }
      default:
        throw new Error(`Unsupported dialect: ${this.config.dialect}`);
    }
  }

  private formatRows(rows: Array<Record<string, unknown>>): string {
    if (rows.length === 0) return "(no rows returned)";

    const columns = Object.keys(rows[0]);
    const header = columns.join(" | ");
    const separator = columns.map((c) => "-".repeat(c.length)).join("-+-");
    const body = rows.map((r) => columns.map((c) => String(r[c] ?? "NULL")).join(" | ")).join("\n");

    return `${header}\n${separator}\n${body}\n\n(${rows.length} row${rows.length === 1 ? "" : "s"})`;
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "sql_query",
        description: `Execute a SQL query against the ${this.config.dialect} database.${this.config.readOnly ? " Read-only: only SELECT and similar queries allowed." : ""} Returns results as a formatted table.`,
        parameters: z.object({
          query: z.string().describe("The SQL query to execute"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const query = args.query as string;
          this.validateQuery(query);
          const rows = await this.executeQuery(query);
          return this.formatRows(rows);
        },
      },
      {
        name: "sql_tables",
        description: "List all tables in the database.",
        parameters: z.object({}),
        execute: async (_args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          let query: string;
          switch (this.config.dialect) {
            case "sqlite":
              query = "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name";
              break;
            case "postgres":
              query = "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename";
              break;
            case "mysql":
              query = "SHOW TABLES";
              break;
            default:
              throw new Error(`Unsupported dialect: ${this.config.dialect}`);
          }
          const rows = await this.executeQuery(query);
          if (rows.length === 0) return "(no tables found)";
          return rows.map((r) => Object.values(r)[0]).join("\n");
        },
      },
      {
        name: "sql_describe",
        description: "Describe the schema (columns, types) of a table.",
        parameters: z.object({
          table: z.string().describe("Table name to describe"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const table = args.table as string;
          if (!/^[a-zA-Z_]\w*$/.test(table)) throw new Error("Invalid table name");

          let query: string;
          switch (this.config.dialect) {
            case "sqlite":
              query = `PRAGMA table_info("${table}")`;
              break;
            case "postgres": {
              const conn = await this.getConnection();
              const result = await conn.query(
                "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1 AND table_schema = 'public' ORDER BY ordinal_position",
                [table],
              );
              return this.formatRows(result.rows as Array<Record<string, unknown>>);
            }
            case "mysql":
              query = `DESCRIBE \`${table}\``;
              break;
            default:
              throw new Error(`Unsupported dialect: ${this.config.dialect}`);
          }
          const rows = await this.executeQuery(query);
          return this.formatRows(rows);
        },
      },
    ];
  }
}
