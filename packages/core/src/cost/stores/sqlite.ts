import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { AccountingBackend, AccountingTransaction, DocumentQuery } from "../store.js";
import { TransactionalAccountingStore } from "./base.js";
import { ACCOUNTING_SCHEMA_VERSION, documentColumns, documentValues, schemaSql, whereQuery } from "./sql.js";

const requireOptional = createRequire(import.meta.url);
const queues = new Map<string, Promise<unknown>>();
class SqliteAccountingBackend implements AccountingBackend {
  readonly capabilities = { durable: true, atomicSettlement: true, sharedReservations: true, cursorPagination: true };
  private readonly database: any;
  private readonly lockKey: string;
  constructor(path: string) {
    let Database: any;
    try {
      Database = requireOptional("better-sqlite3");
    } catch (error) {
      throw new Error("Install better-sqlite3 to use SqliteUsageStore", { cause: error });
    }
    this.database = new Database(path, { timeout: 10000 });
    this.lockKey = path === ":memory:" ? crypto.randomUUID() : resolve(path);
    this.database.pragma("busy_timeout = 10000");
    this.database.pragma("journal_mode = WAL");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(schemaSql);
      const version = this.database.prepare("SELECT version FROM agentium_accounting_schema WHERE id = 1").get() as
        | { version: number }
        | undefined;
      if (version && version.version !== ACCOUNTING_SCHEMA_VERSION)
        throw new Error(`Unsupported accounting schema ${version.version}`);
      this.database
        .prepare("INSERT OR IGNORE INTO agentium_accounting_schema (id, version) VALUES (1, ?)")
        .run(ACCOUNTING_SCHEMA_VERSION);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      this.database.close();
      throw error;
    }
  }
  async transaction<T>(tenantId: string, operation: (transaction: AccountingTransaction) => Promise<T>): Promise<T> {
    const result = (queues.get(this.lockKey) ?? Promise.resolve()).then(async () => {
      this.database.exec("BEGIN IMMEDIATE");
      const tx: AccountingTransaction = {
        get: async <V>(kind: string, id: string) => {
          const row = this.database
            .prepare("SELECT payload FROM agentium_accounting_documents WHERE tenant_id = ? AND kind = ? AND id = ?")
            .get(tenantId, kind, id) as { payload: string } | undefined;
          return row ? (JSON.parse(row.payload) as V) : null;
        },
        put: async (document) => {
          const columns = documentColumns.join(", ");
          const updates = documentColumns
            .slice(3)
            .map((column) => `${column} = excluded.${column}`)
            .join(", ");
          this.database
            .prepare(
              `INSERT INTO agentium_accounting_documents (${columns}) VALUES (${documentColumns.map(() => "?").join(", ")}) ON CONFLICT (tenant_id, kind, id) DO UPDATE SET ${updates}`,
            )
            .run(...documentValues({ ...document, tenantId }));
        },
        list: async <V>(query: Omit<DocumentQuery, "tenantId">) => {
          const { sql, values } = whereQuery({ ...query, tenantId }, false);
          return (
            this.database
              .prepare(`SELECT id, payload FROM agentium_accounting_documents ${sql}`)
              .all(...values) as Array<{ id: string; payload: string }>
          ).map((row) => ({ id: row.id, value: JSON.parse(row.payload) as V }));
        },
      };
      try {
        const value = await operation(tx);
        this.database.exec("COMMIT");
        return value;
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    });
    queues.set(
      this.lockKey,
      result.catch(() => {}),
    );
    return result;
  }
  async close(): Promise<void> {
    await queues.get(this.lockKey);
    this.database.close();
  }
}
/** Durable local ledger, migrations and atomic budgets in one SQLite transaction. */
export class SqliteUsageStore extends TransactionalAccountingStore {
  constructor(path: string) {
    super(new SqliteAccountingBackend(path));
  }
}
