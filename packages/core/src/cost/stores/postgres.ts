import { createRequire } from "node:module";
import type { AccountingBackend, AccountingTransaction, DocumentQuery } from "../store.js";
import { TransactionalAccountingStore } from "./base.js";
import { ACCOUNTING_SCHEMA_VERSION, documentColumns, documentValues, schemaSql, whereQuery } from "./sql.js";

const requireOptional = createRequire(import.meta.url);
class PostgresAccountingBackend implements AccountingBackend {
  readonly capabilities = { durable: true, atomicSettlement: true, sharedReservations: true, cursorPagination: true };
  private readonly pool: any;
  private ready: Promise<void> | undefined;
  constructor(connectionString: string) {
    try {
      const { Pool } = requireOptional("pg");
      this.pool = new Pool({ connectionString });
    } catch (error) {
      throw new Error("Install pg to use PostgresUsageStore", { cause: error });
    }
  }
  async initialize(): Promise<void> {
    if (!this.ready)
      this.ready = (async () => {
        const client = await this.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT pg_advisory_xact_lock(hashtext('agentium_accounting_schema'))");
          await client.query(schemaSql);
          const result = await client.query("SELECT version FROM agentium_accounting_schema WHERE id = 1");
          if (result.rows[0] && result.rows[0].version !== ACCOUNTING_SCHEMA_VERSION)
            throw new Error(`Unsupported accounting schema ${result.rows[0].version}`);
          await client.query(
            "INSERT INTO agentium_accounting_schema (id, version) VALUES (1, $1) ON CONFLICT DO NOTHING",
            [ACCOUNTING_SCHEMA_VERSION],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      })();
    await this.ready;
  }
  async transaction<T>(tenantId: string, operation: (transaction: AccountingTransaction) => Promise<T>): Promise<T> {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`agentium-accounting:${tenantId}`]);
      const tx: AccountingTransaction = {
        get: async <V>(kind: string, id: string) => {
          const result = await client.query(
            "SELECT payload FROM agentium_accounting_documents WHERE tenant_id = $1 AND kind = $2 AND id = $3",
            [tenantId, kind, id],
          );
          return result.rows[0] ? (JSON.parse(result.rows[0].payload) as V) : null;
        },
        put: async (document) => {
          const updates = documentColumns
            .slice(3)
            .map((column) => `${column} = EXCLUDED.${column}`)
            .join(", ");
          await client.query(
            `INSERT INTO agentium_accounting_documents (${documentColumns.join(", ")}) VALUES (${documentColumns.map((_, index) => `$${index + 1}`).join(", ")}) ON CONFLICT (tenant_id, kind, id) DO UPDATE SET ${updates}`,
            documentValues({ ...document, tenantId }),
          );
        },
        list: async <V>(query: Omit<DocumentQuery, "tenantId">) => {
          const { sql, values } = whereQuery({ ...query, tenantId }, true);
          const result = await client.query(`SELECT id, payload FROM agentium_accounting_documents ${sql}`, values);
          return (result.rows as Array<{ id: string; payload: string }>).map((row) => ({
            id: row.id,
            value: JSON.parse(row.payload) as V,
          }));
        },
      };
      const value = await operation(tx);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}
/** Shared ledger. Admission, selection and settlement use the same tenant transaction lock. */
export class PostgresUsageStore extends TransactionalAccountingStore {
  constructor(connectionString: string) {
    super(new PostgresAccountingBackend(connectionString));
  }
}
