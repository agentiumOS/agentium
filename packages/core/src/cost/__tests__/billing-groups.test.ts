import { describe, expect, it } from "vitest";
import type { NormalizedUsage } from "../accounting-types.js";
import { CostTracker } from "../cost-tracker.js";
import { InMemoryUsageStore } from "../stores/in-memory.js";
import { fixtureCatalog, fixtureContext, fixtureRecord, fixtureRule } from "./fixtures.js";

function duration(seconds: string): NormalizedUsage {
  return {
    schemaVersion: 1,
    normalizerId: "duration",
    normalizerVersion: "1",
    tokens: null,
    measurements: [
      {
        id: "duration",
        meter: "duration",
        quantity: seconds,
        unit: "second",
        dimensions: {},
        source: "provider",
        evidencePaths: ["usage.seconds"],
      },
    ],
    coverage: { requiredMeters: ["duration"], unsupportedFeatures: [] },
    issues: [],
  };
}
function catalog(scope: "session" | "attempt" | "account_period") {
  return {
    ...fixtureCatalog(),
    rules: [
      fixtureRule("duration", "0.01", {
        scope,
        unit: "second",
        rate: { kind: "unit", amount: "0.01", per: "60" },
        rounding: { increment: "60", mode: "ceil" },
      }),
    ],
  };
}
describe("billing groups", () => {
  it("rounds two20-second operations once for a session and twice for requests", async () => {
    for (const [scope, expected] of [
      ["session", "0.01"],
      ["attempt", "0.02"],
    ] as const) {
      const tracker = new CostTracker({ catalog: catalog(scope) });
      for (const id of ["a", "b"]) await tracker.recordUsage({ ...fixtureRecord(id), usage: duration("20") });
      const total = await tracker.queryCosts({ tenantId: "test" });
      expect(total.knownSubtotal).toBe(expected);
      expect(total.total).toBe(expected);
      if (scope === "session")
        expect((await tracker.queryCosts({ tenantId: "test", runId: "run-1" })).total).toBeNull();
    }
  });
  it("replay is idempotent and late snapshots replace group usage", async () => {
    const tracker = new CostTracker({ catalog: catalog("session") });
    const a = { ...fixtureRecord("a"), usage: duration("20"), observationId: "first", sequence: 1 };
    await tracker.recordUsage(a);
    await tracker.recordUsage(a);
    await tracker.recordUsage({ ...fixtureRecord("b"), usage: duration("20") });
    expect((await tracker.queryCosts({ tenantId: "test" })).total).toBe("0.01");
    await tracker.recordUsage({ ...a, usage: duration("50"), observationId: "later", sequence: 2 });
    expect((await tracker.queryCosts({ tenantId: "test" })).total).toBe("0.02");
    const selectedGroup = (await tracker.queryAssessments({ tenantId: "test" })).items.find(
      (item) => item.targetKind === "billing_group",
    );
    expect(selectedGroup?.groupMembers).toEqual(
      expect.arrayContaining([{ attemptId: "a", observationIds: ["later"], measurementIds: ["duration"] }]),
    );
    expect(
      (await tracker.queryAssessments({ tenantId: "test", selected: false })).items.filter(
        (item) => item.targetKind === "billing_group",
      ),
    ).toHaveLength(3);
  });
  it("separates account billing periods", async () => {
    const tracker = new CostTracker({ catalog: catalog("account_period") });
    for (const [id, period] of [
      ["a", "october"],
      ["b", "november"],
    ])
      await tracker.recordUsage({
        ...fixtureRecord(id),
        context: { ...fixtureContext, accountId: "account", dimensions: { billingPeriod: period } },
        usage: duration("20"),
      });
    expect((await tracker.queryCosts({ tenantId: "test" })).total).toBe("0.02");
  });
  it("two workers can update different snapshots on one attempt without losing observations", async () => {
    const store = new InMemoryUsageStore();
    const one = new CostTracker({ catalog: fixtureCatalog(), store });
    const two = new CostTracker({ catalog: fixtureCatalog(), store });
    const record = fixtureRecord();
    await Promise.all([
      one.recordUsage({ ...record, observationId: "one", sequence: 1 }),
      two.recordUsage({ ...record, observationId: "two", sequence: 2 }),
    ]);
    expect((await one.queryCosts({ tenantId: "test" })).total).toBe("0.072");
    expect((await one.queryUsage({ tenantId: "test" })).items).toHaveLength(2);
  });
});

it("settles session reservations only after its group charge is selected atomically", async () => {
  const store = new InMemoryUsageStore();
  const tracker = new CostTracker({
    store,
    catalog: catalog("session"),
    budget: {
      mode: "reservation",
      conservativeBound: "0.01",
      limits: [
        {
          scope: "session",
          amount: "1",
          currency: "USD",
          period: { start: "2020-01-01T00:00:00.000Z", end: "2099-01-01T00:00:00.000Z" },
        },
      ],
    },
  });
  const record = { ...fixtureRecord(), usage: duration("20") };
  const admission = await tracker.checkBudget(record);
  await tracker.recordUsage({ ...record, reservationId: admission.reservationId });
  expect((await store.getReservation("test", admission.reservationId!))?.status).toBe("settled");
  expect((await tracker.queryCosts({ tenantId: "test", sessionId: "session-1" })).total).toBe("0.01");
});

it("stores allocation history as views and never adds shares to the group charge", async () => {
  const tracker = new CostTracker({ catalog: catalog("session") });
  await tracker.recordUsage({ ...fixtureRecord("a"), usage: duration("20"), runId: "run-a" });
  await tracker.recordUsage({ ...fixtureRecord("b"), usage: duration("20"), runId: "run-b" });
  const group = (await tracker.queryAssessments({ tenantId: "test" })).items.find(
    (item) => item.targetKind === "billing_group",
  )!;
  await tracker.allocate(
    group.assessmentId,
    [
      { operationId: "operation-a", runId: "run-a", weight: "20" },
      { operationId: "operation-b", runId: "run-b", weight: "20" },
    ],
    { tenantId: "test", policyVersion: "duration-v1" },
  );
  expect((await tracker.queryCosts({ tenantId: "test" })).total).toBe("0.01");
  expect((await tracker.queryCosts({ tenantId: "test" })).unallocatedSubtotal).toBe("0");
  expect((await tracker.queryCosts({ tenantId: "test", runId: "run-a" })).total).toBe("0.005");
  expect((await tracker.queryCosts({ tenantId: "test", runId: "run-b" })).total).toBe("0.005");
  expect((await tracker.queryAllocations({ tenantId: "test" })).items).toHaveLength(2);
  const finalized = await tracker.finalizeGroup(group.targetId, { tenantId: "test", confirmedFinal: true });
  expect(finalized.finality).toBe("final");
  expect(
    (await tracker.queryAssessments({ tenantId: "test", selected: false })).items.some(
      (item) => item.assessmentId === group.assessmentId,
    ),
  ).toBe(true);
  // Prior assessment allocations are retained but must not silently apply to its replacement.
  expect((await tracker.queryCosts({ tenantId: "test", runId: "run-a" })).total).toBeNull();
});

it("keeps provider-reported and invoice costs in separate selected views", async () => {
  const tracker = new CostTracker({ catalog: fixtureCatalog() });
  await tracker.recordUsage(fixtureRecord());
  const input = {
    tenantId: "test",
    assessmentId: "provider-amount",
    targetKind: "attempt" as const,
    targetId: "attempt-1",
    attemptId: "attempt-1",
    context: fixtureContext,
    amount: "0.05",
    currency: "USD",
    basis: "provider_reported" as const,
    sourceUrl: "https://example.com/provider-response",
    evidenceVersion: "v1",
    includedMeters: ["token.input", "token.cache_read", "token.cache_write", "token.output"],
    finality: "final" as const,
    evidence: { total_cost: "0.05" },
  };
  await tracker.recordReportedCost(input);
  await tracker.recordReportedCost(input);
  expect((await tracker.queryCosts({ tenantId: "test" })).total).toBe("0.072");
  expect((await tracker.queryCosts({ tenantId: "test", view: "provider_reported" })).total).toBe("0.05");
  await tracker.recordReportedCost({ ...input, assessmentId: "invoice-amount", basis: "invoice", amount: "0.04" });
  expect((await tracker.queryCosts({ tenantId: "test", view: "invoice" })).total).toBe("0.04");
});

it("repricing rebuilds groups in its own view without duplicating the original invoice estimate", async () => {
  const tracker = new CostTracker({ catalog: catalog("session") });
  for (const id of ["a", "b"]) await tracker.recordUsage({ ...fixtureRecord(id), usage: duration("20") });
  const revised = catalog("session");
  revised.version = "2";
  revised.rules[0].rate = { kind: "unit", amount: "0.02", per: "60" };
  await tracker.reprice({ tenantId: "test" }, revised);
  expect((await tracker.queryCosts({ tenantId: "test" })).total).toBe("0.01");
  expect((await tracker.queryCosts({ tenantId: "test", view: "repriced" })).total).toBe("0.02");
});

it("account-period allocations preserve currency, selected view and one global payable amount", async () => {
  const tracker = new CostTracker({ catalog: fixtureCatalog() });
  const report = {
    tenantId: "test",
    assessmentId: "eur-period",
    targetKind: "account_period" as const,
    targetId: "october",
    context: fixtureContext,
    amount: "2",
    currency: "EUR",
    basis: "invoice" as const,
    sourceUrl: "https://example.com/invoice",
    evidenceVersion: "1",
    includedMeters: ["account.subscription"],
    finality: "final" as const,
  };
  await tracker.recordReportedCost(report);
  await tracker.allocate("eur-period", [{ operationId: "operation", runId: "r", weight: "1" }], {
    tenantId: "test",
    policyVersion: "1",
    view: "invoice",
  });
  expect((await tracker.queryCosts({ tenantId: "test", view: "invoice" })).total).toBe("0");
  expect((await tracker.queryCosts({ tenantId: "test", view: "invoice", currency: "EUR" })).total).toBe("2");
  expect((await tracker.queryCosts({ tenantId: "test", view: "invoice", currency: "EUR" })).unallocatedSubtotal).toBe(
    "0",
  );
  expect((await tracker.queryCosts({ tenantId: "test", runId: "r", view: "invoice", currency: "EUR" })).total).toBe(
    "2",
  );
  expect((await tracker.queryAllocations({ tenantId: "test", view: "original" })).items).toHaveLength(0);
  expect((await tracker.queryAllocations({ tenantId: "test", view: "invoice", limit: 1 })).items).toHaveLength(1);
});
it("rejects reported money without a coherent target and source", async () => {
  const tracker = new CostTracker();
  const report = {
    assessmentId: "bad",
    targetKind: "attempt" as const,
    targetId: "a",
    attemptId: "b",
    context: fixtureContext,
    amount: "1",
    currency: "USD",
    basis: "provider_reported" as const,
    sourceUrl: "https://example.com",
    evidenceVersion: "1",
    includedMeters: ["token.input"],
    finality: "final" as const,
  };
  await expect(tracker.recordReportedCost(report)).rejects.toThrow("identity disagree");
  await expect(tracker.recordReportedCost({ ...report, attemptId: "a", includedMeters: [] })).rejects.toThrow();
});

it("repeated repricing to a new rule version retires the old group's selected amount", async () => {
  const tracker = new CostTracker({ catalog: catalog("session") });
  await tracker.recordUsage({ ...fixtureRecord("a"), usage: duration("20") });
  await tracker.reprice({ tenantId: "test" }, catalog("session"));
  const next = catalog("session");
  next.version = "2";
  next.rules[0].version = "2";
  next.rules[0].rate = { kind: "unit", amount: "0.02", per: "60" };
  await tracker.reprice({ tenantId: "test" }, next);
  expect((await tracker.queryCosts({ tenantId: "test", view: "repriced" })).total).toBe("0.02");
});
it("a wildcard session meter includes contributions from all matching models", async () => {
  const prices = catalog("session");
  prices.rules[0].match.modelId = "*";
  const tracker = new CostTracker({ catalog: prices });
  await tracker.recordUsage({
    ...fixtureRecord("a"),
    context: { ...fixtureContext, modelId: "a" },
    usage: duration("20"),
  });
  await tracker.recordUsage({
    ...fixtureRecord("b"),
    context: { ...fixtureContext, modelId: "b" },
    usage: duration("50"),
  });
  expect((await tracker.queryCosts({ tenantId: "test" })).total).toBe("0.02");
});
it("moving a corrected snapshot to another session removes its old group contribution", async () => {
  const tracker = new CostTracker({ catalog: catalog("session") });
  const first = { ...fixtureRecord("a"), observationId: "first", sequence: 1, usage: duration("20") };
  await tracker.recordUsage(first);
  await tracker.recordUsage({ ...first, observationId: "move", sequence: 2, sessionId: "session-2" });
  expect((await tracker.queryCosts({ tenantId: "test", sessionId: "session-1" })).total).toBe("0");
  expect((await tracker.queryCosts({ tenantId: "test" })).total).toBe("0.01");
});

it("groupBy core billing fields partition identity and selected memberships consistently", async () => {
  const prices = catalog("session");
  prices.rules[0].groupBy = ["region"];
  const tracker = new CostTracker({ catalog: prices });
  for (const region of ["us", "eu"])
    await tracker.recordUsage({
      ...fixtureRecord(region),
      context: { ...fixtureContext, region },
      usage: duration("20"),
    });
  expect((await tracker.queryCosts({ tenantId: "test" })).total).toBe("0.02");
  expect(
    (await tracker.queryAssessments({ tenantId: "test" })).items.filter((item) => item.targetKind === "billing_group"),
  ).toHaveLength(2);
});
