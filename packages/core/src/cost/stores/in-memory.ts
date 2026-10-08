import type { AccountingBackend, AccountingTransaction, DocumentQuery, StoredDocument } from "../store.js";
import { TransactionalAccountingStore } from "./base.js";
export function documentMatches(item: StoredDocument, query: DocumentQuery): boolean {
  if (item.tenantId !== query.tenantId || item.kind !== query.kind) return false;
  for (const field of [
    "runId",
    "rootRunId",
    "sessionId",
    "userId",
    "operationId",
    "attemptId",
    "targetId",
    "currency",
    "providerId",
    "modelId",
  ] as const)
    if (query[field] !== undefined && item[field] !== query[field]) return false;
  return (
    (!query.since || (item.occurredAt ?? "") >= query.since) &&
    (!query.until || (item.occurredAt ?? "") < query.until) &&
    (!query.after || item.id > query.after)
  );
}
export class InMemoryAccountingBackend implements AccountingBackend {
  readonly capabilities = { durable: false, atomicSettlement: true, sharedReservations: false, cursorPagination: true };
  private documents = new Map<string, StoredDocument>();
  private indexes = new Map<string, Set<string>>();
  private tail: Promise<unknown> = Promise.resolve();
  async transaction<T>(tenantId: string, operation: (transaction: AccountingTransaction) => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const pending = new Map<string, StoredDocument>();
      const key = (kind: string, id: string) => JSON.stringify([tenantId, kind, id]);
      const transaction: AccountingTransaction = {
        get: async <V>(kind: string, id: string) => {
          const item = pending.get(key(kind, id)) ?? this.documents.get(key(kind, id));
          return item ? (structuredClone(item.payload) as V) : null;
        },
        put: async (item) => {
          pending.set(key(item.kind, item.id), structuredClone({ ...item, tenantId }));
        },
        list: async <V>(query: Omit<DocumentQuery, "tenantId">) => {
          const fields = [
            "attemptId",
            "operationId",
            "targetId",
            "runId",
            "rootRunId",
            "sessionId",
            "userId",
            "providerId",
            "modelId",
            "currency",
          ] as const;
          const field = fields.find((candidate) => query[candidate] !== undefined);
          const index = JSON.stringify([tenantId, query.kind, field ?? "all", field ? query[field] : "all"]);
          const ids = new Set(this.indexes.get(index) ?? []);
          for (const id of pending.keys()) ids.add(id);
          return [...ids]
            .map((id) => pending.get(id) ?? this.documents.get(id)!)
            .filter(Boolean)
            .filter((item) => documentMatches(item, { ...query, tenantId }))
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            .slice(0, query.limit ?? 1000)
            .map((item) => ({ id: item.id, value: structuredClone(item.payload) as V }));
        },
      };
      const value = await operation(transaction);
      for (const [id, item] of pending) {
        const keys = (document: StoredDocument) => [
          JSON.stringify([document.tenantId, document.kind, "all", "all"]),
          ...(
            [
              "attemptId",
              "operationId",
              "targetId",
              "runId",
              "rootRunId",
              "sessionId",
              "userId",
              "providerId",
              "modelId",
              "currency",
            ] as const
          )
            .filter((field) => document[field] !== undefined)
            .map((field) => JSON.stringify([document.tenantId, document.kind, field, document[field]])),
        ];
        const previous = this.documents.get(id);
        if (previous) for (const index of keys(previous)) this.indexes.get(index)?.delete(id);
        this.documents.set(id, item);
        for (const index of keys(item)) {
          const ids = this.indexes.get(index) ?? new Set<string>();
          ids.add(id);
          this.indexes.set(index, ids);
        }
      }
      return value;
    });
    this.tail = result.catch(() => {});
    return result;
  }
  async close(): Promise<void> {
    await this.tail;
  }
}
/** Process-local ledger. Display-history eviction never removes its budget balances. */
export class InMemoryUsageStore extends TransactionalAccountingStore {
  constructor() {
    super(new InMemoryAccountingBackend());
  }
}
