import type { StorageDriver } from "../storage/driver.js";
import type { AuditEntry, RetentionPolicy } from "./types.js";

const NAMESPACE = "audit-log";

export class RetentionManager {
  private storage: StorageDriver;
  private policy: RetentionPolicy;

  constructor(storage: StorageDriver, policy?: Partial<RetentionPolicy>) {
    this.storage = storage;
    this.policy = {
      defaultRetentionDays: policy?.defaultRetentionDays ?? 365,
      personalDataRetentionDays: policy?.personalDataRetentionDays ?? 730,
      anonymizeAfterDays: policy?.anonymizeAfterDays,
      tenantOverrides: policy?.tenantOverrides,
    };
  }

  async purge(): Promise<{ purgedCount: number }> {
    const entries = await this.storage.list<AuditEntry>(NAMESPACE);
    const now = Date.now();
    let purgedCount = 0;

    for (const item of entries) {
      const entry = item.value;
      const ageMs = now - new Date(entry.timestamp).getTime();
      const ageDays = ageMs / (24 * 60 * 60 * 1000);

      let retentionDays = this.policy.defaultRetentionDays;
      if (entry.tenantId && this.policy.tenantOverrides?.[entry.tenantId]) {
        retentionDays = this.policy.tenantOverrides[entry.tenantId].retentionDays;
      }

      if (ageDays > retentionDays) {
        await this.storage.delete(NAMESPACE, item.key);
        purgedCount++;
      }
    }

    return { purgedCount };
  }

  async anonymize(): Promise<{ anonymizedCount: number }> {
    if (!this.policy.anonymizeAfterDays) return { anonymizedCount: 0 };

    const entries = await this.storage.list<AuditEntry>(NAMESPACE);
    const now = Date.now();
    let anonymizedCount = 0;

    for (const item of entries) {
      const entry = item.value;
      const ageMs = now - new Date(entry.timestamp).getTime();
      const ageDays = ageMs / (24 * 60 * 60 * 1000);

      if (ageDays > this.policy.anonymizeAfterDays && (entry.userId || entry.input || entry.output)) {
        const anonymized: AuditEntry = {
          ...entry,
          userId: entry.userId ? "[ANONYMIZED]" : undefined,
          input: entry.input ? "[ANONYMIZED]" : undefined,
          output: entry.output ? "[ANONYMIZED]" : undefined,
          reasoning: entry.reasoning ? "[ANONYMIZED]" : undefined,
        };
        await this.storage.set(NAMESPACE, item.key, anonymized);
        anonymizedCount++;
      }
    }

    return { anonymizedCount };
  }

  async getRetentionStatus(): Promise<{
    totalEntries: number;
    oldestEntry?: Date;
    entriesNeedingPurge: number;
    compliant: boolean;
  }> {
    const entries = await this.storage.list<AuditEntry>(NAMESPACE);
    if (entries.length === 0) return { totalEntries: 0, entriesNeedingPurge: 0, compliant: true };

    const now = Date.now();
    let oldestDate: Date | undefined;
    let needingPurge = 0;

    for (const item of entries) {
      const ts = new Date(item.value.timestamp);
      if (!oldestDate || ts < oldestDate) oldestDate = ts;

      const ageDays = (now - ts.getTime()) / (24 * 60 * 60 * 1000);
      if (ageDays > this.policy.defaultRetentionDays) needingPurge++;
    }

    return {
      totalEntries: entries.length,
      oldestEntry: oldestDate,
      entriesNeedingPurge: needingPurge,
      compliant: needingPurge === 0,
    };
  }
}
