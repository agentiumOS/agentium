import { describe, expect, it } from "vitest";
import type { BudgetReservation, UsageObservation } from "../accounting-types.js";
import { calculateCharges } from "../calculator.js";
import { CostTracker } from "../cost-tracker.js";
import { type AccountingBackend, AccountingConflictError, type AccountingTransaction } from "../store.js";
import { TransactionalAccountingStore } from "../stores/base.js";
import { InMemoryAccountingBackend, InMemoryUsageStore } from "../stores/in-memory.js";
import { fixtureCatalog, fixtureContext, fixtureRecord, fixtureUsage } from "./fixtures.js";

function observation(id = "o1"): UsageObservation {
  return {
    ...fixtureRecord(),
    tenantId: "test",
    observationId: id,
    sequence: 1,
    observedAt: fixtureContext.occurredAt,
    observationKind: "snapshot",
  };
}
describe("accounting ledger", () => {
  it("deduplicates identical observation delivery and rejects content conflicts", async () => {
    const store = new InMemoryUsageStore();
    expect(await store.appendObservation(observation())).toBe("inserted");
    expect(await store.appendObservation(observation())).toBe("duplicate");
    await expect(store.appendObservation({ ...observation(), executionStatus: "failed" })).rejects.toBeInstanceOf(
      AccountingConflictError,
    );
  });
  it("keeps selected corrections separate from immutable history", async () => {
    const store = new InMemoryUsageStore();
    const assessment = calculateCharges({
      ...fixtureRecord(),
      purpose: "original",
      catalog: fixtureCatalog(),
      assessmentId: "a1",
    });
    await store.commitAssessmentAndSettle({
      assessment,
      view: "original",
      expectedSelectionRevision: 0,
      projections: [{ key: "scope", amount: assessment.knownSubtotal, unknown: false, currency: "USD" }],
    });
    expect(await store.commitAssessmentAndSettle({ assessment, view: "original", expectedSelectionRevision: 0 })).toBe(
      "duplicate",
    );
    const next = { ...assessment, assessmentId: "a2", total: "0.1", knownSubtotal: "0.1", usageRevision: 2 };
    await store.commitAssessmentAndSettle({
      assessment: next,
      view: "original",
      expectedSelectionRevision: 1,
      projections: [{ key: "scope", amount: "0.1", unknown: false, currency: "USD" }],
    });
    expect((await store.balances("test", [{ key: "scope", limit: "1", currency: "USD" }]))[0].spent).toBe("0.1");
    expect((await store.queryAssessments({ tenantId: "test", selected: false })).items).toHaveLength(2);
    expect((await store.queryCosts({ tenantId: "test" })).total).toBe("0.1");
    await expect(
      store.commitAssessmentAndSettle({
        assessment: { ...next, assessmentId: "stale" },
        view: "original",
        expectedSelectionRevision: 0,
      }),
    ).rejects.toThrow("Stale");
  });
  it("pages attempts and isolates tenants/filter cursors", async () => {
    const store = new InMemoryUsageStore();
    for (let i = 0; i < 5; i++)
      await store.appendObservation({ ...observation(`o${i}`), attemptId: `attempt-${i}`, runId: i < 2 ? "a" : "b" });
    await store.appendObservation({ ...observation(), tenantId: "other" });
    const first = await store.queryUsage({ tenantId: "test", limit: 1, runId: "b" });
    expect(first.items).toHaveLength(1);
    const next = await store.queryUsage({ tenantId: "test", limit: 1, runId: "b", cursor: first.nextCursor! });
    expect(next.items[0].attemptId).not.toBe(first.items[0].attemptId);
    await expect(
      store.queryUsage({ tenantId: "other", limit: 1, runId: "b", cursor: first.nextCursor! }),
    ).rejects.toThrow("Cursor");
    expect((await store.queryUsage({ tenantId: "test", attemptId: "attempt-4", limit: 1 })).items[0].attemptId).toBe(
      "attempt-4",
    );
  });
  it("replaces snapshots, deduplicates deltas and retains replay history", async () => {
    const tracker = new CostTracker({ catalog: fixtureCatalog() });
    const first = fixtureRecord();
    await tracker.recordUsage({ ...first, observationId: "one", sequence: 1 });
    await tracker.recordUsage({ ...first, observationId: "two", sequence: 2 });
    expect((await tracker.queryCosts({ tenantId: "test" })).total).toBe("0.072");
    await tracker.recordUsage({ ...first, observationId: "delta", sequence: 3, observationKind: "delta" });
    await tracker.recordUsage({ ...first, observationId: "delta", sequence: 3, observationKind: "delta" });
    expect((await tracker.queryCosts({ tenantId: "test" })).total).toBe("0.144");
    await tracker.recordUsage({ ...first, observationId: "stale", sequence: 1 });
    expect((await tracker.queryCosts({ tenantId: "test" })).total).toBe("0.144");
    expect((await tracker.queryAssessments({ tenantId: "test", selected: false })).items).toHaveLength(3);
  });
  it("reprices into a separate view without rewriting original totals", async () => {
    const tracker = new CostTracker({ catalog: fixtureCatalog() });
    await tracker.recordUsage(fixtureRecord());
    const next = fixtureCatalog();
    next.version = "2";
    next.rules[0].rate = { kind: "unit", amount: "20", per: "1000000" };
    await tracker.reprice({ tenantId: "test" }, next);
    expect((await tracker.queryCosts({ tenantId: "test" })).total).toBe("0.072");
    expect((await tracker.queryCosts({ tenantId: "test", view: "repriced" })).total).toBe("0.082");
  });
  it("rolls back each conceptual settlement write atomically", async () => {
    for (let failAt = 1; failAt <= 6; failAt++) {
      const memory = new InMemoryAccountingBackend();
      let enabled = false;
      let writes = 0;
      const backend: AccountingBackend = {
        capabilities: memory.capabilities,
        close: () => memory.close(),
        transaction: (tenantId, operation) =>
          memory.transaction(tenantId, (tx) =>
            operation({
              ...tx,
              put: async (document) => {
                if (enabled && ++writes === failAt) throw new Error("injected crash");
                await tx.put(document);
              },
            } as AccountingTransaction),
          ),
      };
      const store = new TransactionalAccountingStore(backend);
      const reservation: BudgetReservation = {
        tenantId: "test",
        reservationId: "r",
        attemptId: "attempt-1",
        amount: "1",
        currency: "USD",
        scopes: [{ key: "scope", limit: "2" }],
        status: "reserved",
        createdAt: fixtureContext.occurredAt,
      };
      await store.reserve(reservation);
      enabled = true;
      const assessment = calculateCharges({
        ...fixtureRecord(),
        purpose: "original",
        catalog: fixtureCatalog(),
        assessmentId: "a",
      });
      await expect(
        store.commitAssessmentAndSettle({
          assessment,
          view: "original",
          expectedSelectionRevision: 0,
          reservationId: "r",
          projections: [{ key: "scope", amount: "0.072", unknown: false, currency: "USD" }],
        }),
      ).rejects.toThrow("injected crash");
      expect(await store.getSelection("test", "attempt", "attempt-1", "original")).toBeNull();
      expect((await store.queryAssessments({ tenantId: "test", selected: false })).items).toHaveLength(0);
      expect((await store.getReservation("test", "r"))?.status).toBe("reserved");
      expect((await store.balances("test", [{ key: "scope", limit: "2", currency: "USD" }]))[0]).toMatchObject({
        spent: "0",
        reserved: "1",
      });
    }
  });
  it("flush retries a failed write with original IDs and no provider work", async () => {
    const store = new InMemoryUsageStore();
    const append = store.appendObservation.bind(store);
    let failures = 1;
    store.appendObservation = async (input) => {
      if (failures-- > 0) throw new Error("disk unavailable");
      return append(input);
    };
    const tracker = new CostTracker({ store, catalog: fixtureCatalog() });
    await expect(tracker.recordUsage(fixtureRecord())).rejects.toThrow("flush retries");
    await tracker.flush();
    expect((await tracker.queryCosts({ tenantId: "test" })).total).toBe("0.072");
  });
  it("preserves start intent before a result exists", async () => {
    const tracker = new CostTracker({ catalog: fixtureCatalog() });
    await tracker.startAttempt(fixtureRecord());
    expect((await tracker.queryUsage({ tenantId: "test" })).items[0].executionStatus).toBe("started");
  });
  it("does not evict spend when the legacy display cache passes ten thousand rows", () => {
    const tracker = new CostTracker({
      pricing: { local: { promptPer1k: 1, completionPer1k: 1 } },
      budget: { maxCostPerRun: 10 },
    });
    for (let i = 0; i < 10001; i++)
      tracker.track({
        runId: "r",
        agentName: "a",
        modelId: "local",
        usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
      });
    expect(tracker.getEntries()).toHaveLength(10000);
    expect(tracker.isBudgetExceeded("r")).toBe(true);
    expect(() => tracker.getSummary()).toThrow("evicted");
  });
  it("retains missing usage as unknown", async () => {
    const tracker = new CostTracker({ catalog: fixtureCatalog() });
    const usage = fixtureUsage();
    usage.measurements[0].quantity = null;
    await tracker.recordUsage({ ...fixtureRecord(), usage });
    const total = await tracker.queryCosts({ tenantId: "test" });
    expect(total.total).toBeNull();
    expect(total.knownSubtotal).toBe("0.062");
  });
});

it("synchronous legacy snapshots cannot silently report zero after canonical usage", async () => {
  for (const complete of [true, false]) {
    const tracker = new CostTracker({ catalog: complete ? fixtureCatalog() : { ...fixtureCatalog(), rules: [] } });
    await tracker.recordUsage(fixtureRecord());
    expect(() => tracker.getSummary()).toThrow("queryCosts");
    expect(() => tracker.getEntries()).toThrow("queryUsage");
    expect((await tracker.queryCosts({ tenantId: "test" })).total).toBe(complete ? "0.072" : null);
  }
});

it("run tree totals include descendants and exclude siblings", async () => {
  const tracker = new CostTracker({ catalog: fixtureCatalog() });
  await tracker.recordUsage({ ...fixtureRecord("parent"), runId: "parent", rootRunId: "parent" });
  await tracker.recordUsage({ ...fixtureRecord("child"), runId: "child", rootRunId: "parent", parentRunId: "parent" });
  await tracker.recordUsage({
    ...fixtureRecord("grandchild"),
    runId: "grandchild",
    rootRunId: "parent",
    parentRunId: "child",
  });
  await tracker.recordUsage({
    ...fixtureRecord("sibling"),
    runId: "sibling",
    rootRunId: "parent",
    parentRunId: "parent",
  });
  expect((await tracker.queryCosts({ tenantId: "test", runId: "child" })).total).toBe("0.072");
  expect((await tracker.queryCosts({ tenantId: "test", runId: "child", includeChildren: true })).total).toBe("0.144");
  expect((await tracker.queryCosts({ tenantId: "test", runId: "parent", includeChildren: true })).total).toBe("0.288");
});
it("tracker close drains accounting but does not close a host-owned store", async () => {
  const store = new InMemoryUsageStore();
  let closed = false;
  store.close = async () => {
    closed = true;
  };
  const tracker = new CostTracker({ catalog: fixtureCatalog(), store });
  await tracker.recordUsage(fixtureRecord());
  await tracker.close();
  expect(closed).toBe(false);
  expect((await store.queryCosts({ tenantId: "test" })).total).toBe("0.072");
});

it("delta aggregation selects context bands using aggregate inclusive input", async () => {
  const catalog = fixtureCatalog();
  catalog.rules[0].contextBand = { field: "inputTokens", upTo: 200000 };
  catalog.rules.push({
    ...catalog.rules[0],
    id: "long-input",
    contextBand: { field: "inputTokens", above: 200000 },
    rate: { kind: "unit", amount: "20", per: "1000000" },
  });
  const tracker = new CostTracker({ catalog });
  const usage = fixtureUsage();
  usage.tokens = {
    input: { total: 200000, ordinary: 200000, cacheRead: 0, cacheWrite: 0, cacheWriteByTTL: [] },
    output: { total: 0, reasoning: 0 },
    total: 200000,
    providerReportedTotal: 200000,
  };
  usage.measurements = usage.measurements.map((measurement) => ({
    ...measurement,
    quantity: measurement.meter === "token.input" ? "200000" : "0",
  }));
  usage.context = { inputTokens: 200000 };
  for (const sequence of [1, 2])
    await tracker.recordUsage({
      ...fixtureRecord(),
      observationKind: "delta",
      sequence,
      observationId: String(sequence),
      usage,
    });
  expect((await tracker.queryCosts({ tenantId: "test" })).total).toBe("8");
});

it("preserves actionable immutable conflict codes instead of asking to retry invalid content", async () => {
  const tracker = new CostTracker({ catalog: fixtureCatalog() });
  await tracker.recordUsage(fixtureRecord());
  await expect(tracker.recordUsage({ ...fixtureRecord(), executionStatus: "failed" })).rejects.toMatchObject({
    code: "ACCOUNTING_CONFLICT",
  });
  const store = new InMemoryUsageStore();
  store.appendObservation = async () => {
    throw new Error("disk unavailable");
  };
  await expect(
    new CostTracker({ store, catalog: fixtureCatalog() }).recordUsage(fixtureRecord()),
  ).rejects.toMatchObject({ code: "ACCOUNTING_PERSISTENCE" });
});

it("resolves empty ancestor runs from retained lineage and bounds reads to one indexed root", async () => {
  const memory = new InMemoryAccountingBackend();
  const reads: Array<{ kind: string; rootRunId?: string; runId?: string }> = [];
  let capture = false;
  const backend: AccountingBackend = {
    capabilities: memory.capabilities,
    close: () => memory.close(),
    transaction: (tenantId, operation) =>
      memory.transaction(tenantId, (tx) =>
        operation({
          ...tx,
          list: async (query) => {
            if (capture) reads.push(query);
            return tx.list(query);
          },
        }),
      ),
  };
  const tracker = new CostTracker({ catalog: fixtureCatalog(), store: new TransactionalAccountingStore(backend) });
  await tracker.recordUsage({
    ...fixtureRecord("nested"),
    runId: "leaf",
    rootRunId: "root",
    parentRunId: "empty-inner",
    ancestorRunIds: ["root", "empty-outer", "empty-inner"],
  });
  await tracker.recordUsage({
    ...fixtureRecord("sibling"),
    runId: "sibling",
    rootRunId: "root",
    parentRunId: "root",
    ancestorRunIds: ["root"],
  });
  await tracker.recordUsage({ ...fixtureRecord("unrelated"), runId: "elsewhere", rootRunId: "elsewhere" });
  capture = true;
  expect((await tracker.queryCosts({ tenantId: "test", runId: "empty-outer", includeChildren: true })).total).toBe(
    "0.072",
  );
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.every((query) => query.rootRunId === "root")).toBe(true);
  expect((await tracker.queryCosts({ tenantId: "test", runId: "root", includeChildren: true })).total).toBe("0.144");
});

it("selected aggregate and a newly attached budget include more than ten thousand retained charges", async () => {
  const store = new InMemoryUsageStore();
  const template = calculateCharges({ ...fixtureRecord(), purpose: "original", catalog: fixtureCatalog() });
  for (let index = 0; index < 10001; index++) {
    const id = `scale-${index}`;
    await store.commitAssessmentAndSettle({
      assessment: { ...template, assessmentId: id, targetId: id, attemptId: id, operationId: id },
      view: "original",
      expectedSelectionRevision: 0,
    });
  }
  const result = await store.queryCosts({ tenantId: "test", runId: "run-1" });
  expect(result).toMatchObject({ total: "720.072", assessmentCount: 10001, attemptCount: 10001 });
  const tracker = new CostTracker({ store, budget: { maxCostPerRun: 720 } });
  expect(await tracker.checkBudget({ tenantId: "test", runId: "run-1" })).toMatchObject({ status: "blocked" });
}, 20000);
