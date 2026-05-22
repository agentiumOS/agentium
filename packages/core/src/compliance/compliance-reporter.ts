import type { AuditLogger } from "./audit-logger.js";
import type { RetentionManager } from "./retention-manager.js";
import type { AuditQueryFilter, ComplianceReport } from "./types.js";

export class ComplianceReporter {
  private auditLogger: AuditLogger;
  private retentionManager: RetentionManager;

  constructor(auditLogger: AuditLogger, retentionManager: RetentionManager) {
    this.auditLogger = auditLogger;
    this.retentionManager = retentionManager;
  }

  async generateReport(filter?: Partial<AuditQueryFilter>): Promise<ComplianceReport> {
    const now = new Date();
    const from = filter?.fromDate ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const to = filter?.toDate ?? now;

    const entries = await this.auditLogger.query({
      ...filter,
      fromDate: from,
      toDate: to,
    });

    const entriesByAction: Record<string, number> = {};
    const entriesByAgent: Record<string, number> = {};

    for (const entry of entries) {
      entriesByAction[entry.action] = (entriesByAction[entry.action] ?? 0) + 1;
      entriesByAgent[entry.agentName] = (entriesByAgent[entry.agentName] ?? 0) + 1;
    }

    const retentionStatus = await this.retentionManager.getRetentionStatus();
    const chainIntegrity = await this.auditLogger.verify();

    return {
      generatedAt: now,
      period: { from, to },
      totalEntries: entries.length,
      entriesByAction,
      entriesByAgent,
      retentionStatus: {
        compliant: retentionStatus.compliant,
        oldestEntry: retentionStatus.oldestEntry,
        entriesNeedingPurge: retentionStatus.entriesNeedingPurge,
      },
      hashChainIntegrity: {
        verified: chainIntegrity.valid,
        brokenAt: chainIntegrity.brokenAt,
      },
    };
  }
}
