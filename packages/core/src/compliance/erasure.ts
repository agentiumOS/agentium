import type { StorageDriver } from "../storage/driver.js";
import type { AuditEntry, ErasureResult } from "./types.js";

const AUDIT_NAMESPACE = "audit-log";

const USER_DATA_NAMESPACES = [
  "user-facts",
  "user-profile",
  "sessions",
  "entity-memory",
  "learned-knowledge",
  "decision-log",
  "graph-memory",
  "procedure-memory",
];

export class ErasureManager {
  private storage: StorageDriver;

  constructor(storage: StorageDriver) {
    this.storage = storage;
  }

  async eraseUser(userId: string): Promise<ErasureResult> {
    const stores: Array<{ name: string; itemsErased: number }> = [];

    for (const namespace of USER_DATA_NAMESPACES) {
      let erased = 0;
      try {
        const items = await this.storage.list(namespace, userId);
        for (const item of items) {
          await this.storage.delete(namespace, item.key);
          erased++;
        }

        if (erased === 0) {
          const allItems = await this.storage.list(namespace);
          for (const item of allItems) {
            const val = item.value as any;
            if (val?.userId === userId || item.key.includes(userId)) {
              await this.storage.delete(namespace, item.key);
              erased++;
            }
          }
        }
      } catch {
        // Namespace may not exist, skip
      }

      if (erased > 0) stores.push({ name: namespace, itemsErased: erased });
    }

    let auditEntriesAnonymized = 0;
    try {
      const auditEntries = await this.storage.list<AuditEntry>(AUDIT_NAMESPACE);
      for (const item of auditEntries) {
        if (item.value.userId === userId) {
          const anonymized: AuditEntry = {
            ...item.value,
            userId: "[ERASED]",
            input: item.value.input ? "[ERASED]" : undefined,
            output: item.value.output ? "[ERASED]" : undefined,
            reasoning: item.value.reasoning ? "[ERASED]" : undefined,
          };
          await this.storage.set(AUDIT_NAMESPACE, item.key, anonymized);
          auditEntriesAnonymized++;
        }
      }
    } catch {
      // Audit log may not exist
    }

    return {
      userId,
      erasedAt: new Date(),
      stores,
      auditEntriesAnonymized,
    };
  }
}
