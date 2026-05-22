import { createHash } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import type { PiiGuard } from "../guards/pii-guard.js";
import type { StorageDriver } from "../storage/driver.js";
import type { AuditAction, AuditEntry, AuditQueryFilter } from "./types.js";

const NAMESPACE = "audit-log";

export class AuditLogger {
  private storage: StorageDriver;
  private hashAlgorithm: "sha256" | "sha512";
  private piiScrubber?: PiiGuard;
  private lastHash = "genesis";

  constructor(storage: StorageDriver, opts?: { hashAlgorithm?: "sha256" | "sha512"; piiScrubber?: PiiGuard }) {
    this.storage = storage;
    this.hashAlgorithm = opts?.hashAlgorithm ?? "sha256";
    this.piiScrubber = opts?.piiScrubber;
  }

  async log(entry: {
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
  }): Promise<AuditEntry> {
    let input = entry.input;
    let output = entry.output;

    if (this.piiScrubber) {
      if (input) input = this.piiScrubber.scrub(input);
      if (output) output = this.piiScrubber.scrub(output);
    }

    const previousHash = this.lastHash;
    const content = JSON.stringify({
      ...entry,
      input,
      output,
      timestamp: new Date().toISOString(),
      previousHash,
    });

    const hash = createHash(this.hashAlgorithm)
      .update(previousHash + content)
      .digest("hex");

    const auditEntry: AuditEntry = {
      id: uuidv4(),
      timestamp: new Date(),
      traceId: entry.traceId,
      agentName: entry.agentName,
      agentVersion: entry.agentVersion,
      action: entry.action,
      tenantId: entry.tenantId,
      userId: entry.userId,
      input,
      output,
      reasoning: entry.reasoning,
      metadata: entry.metadata,
      previousHash,
      hash,
    };

    await this.storage.set(NAMESPACE, auditEntry.id, auditEntry);
    this.lastHash = hash;

    return auditEntry;
  }

  async verify(entryIds?: string[]): Promise<{ valid: boolean; brokenAt?: string }> {
    const entries = entryIds
      ? await Promise.all(entryIds.map((id) => this.storage.get<AuditEntry>(NAMESPACE, id)))
      : (await this.storage.list<AuditEntry>(NAMESPACE)).map((i) => i.value);

    const sorted = (entries.filter(Boolean) as AuditEntry[]).sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    for (let i = 1; i < sorted.length; i++) {
      const entry = sorted[i];
      const prev = sorted[i - 1];
      if (entry.previousHash !== prev.hash) {
        return { valid: false, brokenAt: entry.id };
      }
    }

    return { valid: true };
  }

  async query(filter: AuditQueryFilter): Promise<AuditEntry[]> {
    const all = await this.storage.list<AuditEntry>(NAMESPACE);
    return all
      .map((i) => i.value)
      .filter((e) => {
        if (filter.agentName && e.agentName !== filter.agentName) return false;
        if (filter.tenantId && e.tenantId !== filter.tenantId) return false;
        if (filter.userId && e.userId !== filter.userId) return false;
        if (filter.action && e.action !== filter.action) return false;
        if (filter.traceId && e.traceId !== filter.traceId) return false;
        if (filter.fromDate && new Date(e.timestamp) < filter.fromDate) return false;
        if (filter.toDate && new Date(e.timestamp) > filter.toDate) return false;
        return true;
      })
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }
}
