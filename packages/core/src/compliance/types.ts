import type { PiiGuard } from "../guards/pii-guard.js";
import type { StorageDriver } from "../storage/driver.js";

export type AuditAction = "llm.call" | "tool.exec" | "handoff" | "decision" | "memory.access" | "output";

export interface AuditEntry {
  id: string;
  timestamp: Date;
  traceId: string;
  agentName: string;
  agentVersion?: string;
  action: AuditAction;
  tenantId?: string;
  userId?: string;
  input?: string;
  output?: string;
  reasoning?: string;
  metadata?: Record<string, unknown>;
  previousHash: string;
  hash: string;
}

export interface RetentionPolicy {
  defaultRetentionDays: number;
  personalDataRetentionDays: number;
  anonymizeAfterDays?: number;
  tenantOverrides?: Record<string, { retentionDays: number }>;
}

export interface ComplianceConfig {
  enabled: boolean;
  storage: StorageDriver;
  retention?: RetentionPolicy;
  piiScrubber?: PiiGuard;
  hashAlgorithm?: "sha256" | "sha512";
}

export interface AuditQueryFilter {
  agentName?: string;
  tenantId?: string;
  userId?: string;
  action?: AuditAction;
  fromDate?: Date;
  toDate?: Date;
  traceId?: string;
}

export interface ComplianceReport {
  generatedAt: Date;
  period: { from: Date; to: Date };
  totalEntries: number;
  entriesByAction: Record<string, number>;
  entriesByAgent: Record<string, number>;
  retentionStatus: {
    compliant: boolean;
    oldestEntry?: Date;
    entriesNeedingPurge: number;
  };
  hashChainIntegrity: { verified: boolean; brokenAt?: string };
}

export interface ErasureResult {
  userId: string;
  erasedAt: Date;
  stores: Array<{ name: string; itemsErased: number }>;
  auditEntriesAnonymized: number;
}
