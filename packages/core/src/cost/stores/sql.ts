import type { DocumentQuery, StoredDocument } from "../store.js";
export const ACCOUNTING_SCHEMA_VERSION = 1;
export const documentColumns = [
  "tenant_id",
  "kind",
  "id",
  "payload",
  "run_id",
  "root_run_id",
  "session_id",
  "user_id",
  "operation_id",
  "attempt_id",
  "target_id",
  "currency",
  "provider_id",
  "model_id",
  "occurred_at",
];
export function documentValues(item: StoredDocument): unknown[] {
  return [
    item.tenantId,
    item.kind,
    item.id,
    JSON.stringify(item.payload),
    item.runId ?? null,
    item.rootRunId ?? null,
    item.sessionId ?? null,
    item.userId ?? null,
    item.operationId ?? null,
    item.attemptId ?? null,
    item.targetId ?? null,
    item.currency ?? null,
    item.providerId ?? null,
    item.modelId ?? null,
    item.occurredAt ?? null,
  ];
}
export function whereQuery(query: DocumentQuery, postgres: boolean): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  const conditions: string[] = [];
  const add = (column: string, value: unknown, op = "=") => {
    values.push(value);
    conditions.push(`${column} ${op} ${postgres ? `$${values.length}` : "?"}`);
  };
  add("tenant_id", query.tenantId);
  add("kind", query.kind);
  const fields = {
    runId: "run_id",
    rootRunId: "root_run_id",
    sessionId: "session_id",
    userId: "user_id",
    operationId: "operation_id",
    attemptId: "attempt_id",
    targetId: "target_id",
    currency: "currency",
    providerId: "provider_id",
    modelId: "model_id",
  } as const;
  for (const [field, column] of Object.entries(fields)) {
    const value = query[field as keyof typeof fields];
    if (value !== undefined) add(column, value);
  }
  if (query.since) add("occurred_at", query.since, ">=");
  if (query.until) add("occurred_at", query.until, "<");
  if (query.after) add("id", query.after, ">");
  values.push(query.limit ?? 1000);
  return {
    sql: `WHERE ${conditions.join(" AND ")} ORDER BY id ASC LIMIT ${postgres ? `$${values.length}` : "?"}`,
    values,
  };
}
export const schemaSql = `
CREATE TABLE IF NOT EXISTS agentium_accounting_schema (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agentium_accounting_documents (
  tenant_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
  run_id TEXT, root_run_id TEXT, session_id TEXT, user_id TEXT, operation_id TEXT, attempt_id TEXT, target_id TEXT, currency TEXT,
  provider_id TEXT, model_id TEXT, occurred_at TEXT, PRIMARY KEY (tenant_id, kind, id)
);
CREATE INDEX IF NOT EXISTS agentium_accounting_attempt ON agentium_accounting_documents (tenant_id, kind, attempt_id, id);
CREATE INDEX IF NOT EXISTS agentium_accounting_run ON agentium_accounting_documents (tenant_id, kind, run_id, id);
CREATE INDEX IF NOT EXISTS agentium_accounting_root ON agentium_accounting_documents (tenant_id, kind, root_run_id, id);
CREATE INDEX IF NOT EXISTS agentium_accounting_session ON agentium_accounting_documents (tenant_id, kind, session_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS agentium_accounting_user ON agentium_accounting_documents (tenant_id, kind, user_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS agentium_accounting_model ON agentium_accounting_documents (tenant_id, kind, provider_id, model_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS agentium_accounting_operation ON agentium_accounting_documents (tenant_id, kind, operation_id, id);
`;
