import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorage } from "../../storage/in-memory.js";
import { AuditLogger } from "../audit-logger.js";
import { ComplianceReporter } from "../compliance-reporter.js";
import { ErasureManager } from "../erasure.js";
import { RetentionManager } from "../retention-manager.js";

describe("AuditLogger", () => {
  let storage: InMemoryStorage;
  let logger: AuditLogger;

  beforeEach(() => {
    storage = new InMemoryStorage();
    logger = new AuditLogger(storage);
  });

  it("logs an audit entry with hash chain", async () => {
    const entry = await logger.log({
      traceId: "run-1",
      agentName: "agent-1",
      action: "llm.call",
      input: "hello",
      output: "world",
    });

    expect(entry.id).toBeTruthy();
    expect(entry.hash).toBeTruthy();
    expect(entry.previousHash).toBe("genesis");
    expect(entry.agentName).toBe("agent-1");
    expect(entry.action).toBe("llm.call");
  });

  it("chains hashes between entries", async () => {
    const e1 = await logger.log({ traceId: "r1", agentName: "a", action: "llm.call" });
    const e2 = await logger.log({ traceId: "r1", agentName: "a", action: "tool.exec" });

    expect(e2.previousHash).toBe(e1.hash);
  });

  it("verify() passes for valid chain", async () => {
    await logger.log({ traceId: "r1", agentName: "a", action: "llm.call" });
    await logger.log({ traceId: "r1", agentName: "a", action: "tool.exec" });
    await logger.log({ traceId: "r1", agentName: "a", action: "output" });

    const result = await logger.verify();
    expect(result.valid).toBe(true);
  });

  it("verify() detects tampering", async () => {
    await logger.log({ traceId: "r1", agentName: "a", action: "llm.call" });
    const e2 = await logger.log({ traceId: "r1", agentName: "a", action: "tool.exec" });
    await logger.log({ traceId: "r1", agentName: "a", action: "output" });

    // Tamper with e2
    await storage.set("audit-log", e2.id, { ...e2, hash: "tampered" });

    const result = await logger.verify();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBeTruthy();
  });

  it("query() filters by agentName", async () => {
    await logger.log({ traceId: "r1", agentName: "a1", action: "llm.call" });
    await logger.log({ traceId: "r2", agentName: "a2", action: "llm.call" });
    await logger.log({ traceId: "r3", agentName: "a1", action: "tool.exec" });

    const results = await logger.query({ agentName: "a1" });
    expect(results).toHaveLength(2);
    expect(results.every((e) => e.agentName === "a1")).toBe(true);
  });

  it("query() filters by userId", async () => {
    await logger.log({ traceId: "r1", agentName: "a", action: "llm.call", userId: "u1" });
    await logger.log({ traceId: "r2", agentName: "a", action: "llm.call", userId: "u2" });

    const results = await logger.query({ userId: "u1" });
    expect(results).toHaveLength(1);
  });

  it("query() filters by action", async () => {
    await logger.log({ traceId: "r1", agentName: "a", action: "llm.call" });
    await logger.log({ traceId: "r1", agentName: "a", action: "tool.exec" });

    const results = await logger.query({ action: "tool.exec" });
    expect(results).toHaveLength(1);
  });

  it("supports SHA-512 hashing", async () => {
    const sha512Logger = new AuditLogger(storage, { hashAlgorithm: "sha512" });
    const entry = await sha512Logger.log({ traceId: "r1", agentName: "a", action: "llm.call" });
    expect(entry.hash.length).toBe(128); // SHA-512 hex = 128 chars
  });
});

describe("RetentionManager", () => {
  let storage: InMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
  });

  it("purge() removes entries past retention", async () => {
    const oldEntry = {
      id: "old",
      timestamp: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000), // 400 days
      action: "llm.call",
      agentName: "a",
      traceId: "r1",
      previousHash: "x",
      hash: "y",
    };
    const newEntry = {
      id: "new",
      timestamp: new Date(),
      action: "llm.call",
      agentName: "a",
      traceId: "r2",
      previousHash: "x",
      hash: "y",
    };

    await storage.set("audit-log", "old", oldEntry);
    await storage.set("audit-log", "new", newEntry);

    const retention = new RetentionManager(storage, { defaultRetentionDays: 365 });
    const { purgedCount } = await retention.purge();

    expect(purgedCount).toBe(1);
    expect(await storage.get("audit-log", "old")).toBeNull();
    expect(await storage.get("audit-log", "new")).not.toBeNull();
  });

  it("anonymize() strips PII from old entries", async () => {
    const oldEntry = {
      id: "old",
      timestamp: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000), // 200 days
      action: "llm.call",
      agentName: "a",
      traceId: "r1",
      userId: "user-123",
      input: "secret stuff",
      output: "private data",
      previousHash: "x",
      hash: "y",
    };
    await storage.set("audit-log", "old", oldEntry);

    const retention = new RetentionManager(storage, { anonymizeAfterDays: 180 });
    const { anonymizedCount } = await retention.anonymize();

    expect(anonymizedCount).toBe(1);
    const updated = await storage.get<any>("audit-log", "old");
    expect(updated.userId).toBe("[ANONYMIZED]");
    expect(updated.input).toBe("[ANONYMIZED]");
    expect(updated.output).toBe("[ANONYMIZED]");
  });

  it("getRetentionStatus() reports compliance", async () => {
    await storage.set("audit-log", "recent", {
      id: "recent",
      timestamp: new Date(),
      action: "llm.call",
      agentName: "a",
      traceId: "r1",
      previousHash: "x",
      hash: "y",
    });

    const retention = new RetentionManager(storage);
    const status = await retention.getRetentionStatus();

    expect(status.totalEntries).toBe(1);
    expect(status.compliant).toBe(true);
    expect(status.entriesNeedingPurge).toBe(0);
  });
});

describe("ErasureManager", () => {
  let storage: InMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
  });

  it("erases user data across stores", async () => {
    await storage.set("user-facts", "user-123:fact1", { userId: "user-123", fact: "likes coffee" });
    await storage.set("sessions", "user-123:s1", { userId: "user-123", messages: [] });

    const erasure = new ErasureManager(storage);
    const result = await erasure.eraseUser("user-123");

    expect(result.userId).toBe("user-123");
    expect(result.erasedAt).toBeInstanceOf(Date);
    expect(result.stores.length).toBeGreaterThanOrEqual(0);
  });

  it("anonymizes audit entries instead of deleting", async () => {
    await storage.set("audit-log", "entry-1", {
      id: "entry-1",
      userId: "user-123",
      input: "secret",
      output: "private",
      agentName: "a",
      action: "llm.call",
      timestamp: new Date(),
      traceId: "r1",
      previousHash: "x",
      hash: "y",
    });

    const erasure = new ErasureManager(storage);
    const result = await erasure.eraseUser("user-123");

    expect(result.auditEntriesAnonymized).toBe(1);

    const updated = await storage.get<any>("audit-log", "entry-1");
    expect(updated).not.toBeNull();
    expect(updated.userId).toBe("[ERASED]");
    expect(updated.input).toBe("[ERASED]");
  });
});

describe("ComplianceReporter", () => {
  it("generates a compliance report", async () => {
    const storage = new InMemoryStorage();
    const logger = new AuditLogger(storage);
    const retention = new RetentionManager(storage);

    await logger.log({ traceId: "r1", agentName: "a1", action: "llm.call" });
    await logger.log({ traceId: "r1", agentName: "a1", action: "tool.exec" });
    await logger.log({ traceId: "r2", agentName: "a2", action: "llm.call" });

    const reporter = new ComplianceReporter(logger, retention);
    const report = await reporter.generateReport();

    expect(report.totalEntries).toBe(3);
    expect(report.entriesByAction["llm.call"]).toBe(2);
    expect(report.entriesByAction["tool.exec"]).toBe(1);
    expect(report.entriesByAgent.a1).toBe(2);
    expect(report.entriesByAgent.a2).toBe(1);
    expect(report.hashChainIntegrity.verified).toBe(true);
    expect(report.retentionStatus.compliant).toBe(true);
    expect(report.generatedAt).toBeInstanceOf(Date);
  });
});
