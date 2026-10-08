import { describe, expect, it } from "vitest";
import type { BudgetPolicy, BudgetReservation } from "../accounting-types.js";
import { calculateCharges } from "../calculator.js";
import { CostTracker } from "../cost-tracker.js";
import { InMemoryUsageStore } from "../stores/in-memory.js";
import { fixtureCatalog, fixtureContext, fixtureRecord } from "./fixtures.js";

const period = { start: "2020-01-01T00:00:00.000Z", end: "2099-01-01T00:00:00.000Z" };
function policy(amount = "0.1", mode: "threshold" | "reservation" = "threshold"): BudgetPolicy {
  return { mode, limits: [{ scope: "run", amount, currency: "USD", period }], conservativeBound: "0.072" };
}
describe("budget admission and settlement", () => {
  it("zero limits block and warning mode continues", async () => {
    const tracker = new CostTracker({ catalog: fixtureCatalog(), budget: policy("0") });
    expect((await tracker.checkBudget({ runId: "r" })).status).toBe("blocked");
    const warn = new CostTracker({ catalog: fixtureCatalog(), budget: { ...policy("0"), onExceeded: "warn" } });
    expect((await warn.checkBudget({ runId: "r" })).status).toBe("warned");
  });
  it("reserves all scopes atomically in a race", async () => {
    const store = new InMemoryUsageStore();
    const tracker = new CostTracker({ store, catalog: fixtureCatalog(), budget: policy("0.1", "reservation") });
    const decisions = await Promise.all([
      tracker.checkBudget({ tenantId: "test", runId: "r", attemptId: "a" }),
      tracker.checkBudget({ tenantId: "test", runId: "r", attemptId: "b" }),
    ]);
    expect(decisions.map((d) => d.status).sort()).toEqual(["allowed", "blocked"]);
  });
  it("settles a reservation and adjusts spend only once", async () => {
    const store = new InMemoryUsageStore();
    const tracker = new CostTracker({ store, catalog: fixtureCatalog(), budget: policy("1", "reservation") });
    const input = fixtureRecord();
    const decision = await tracker.checkBudget({ ...input, attemptId: input.attemptId });
    expect(decision.status).toBe("allowed");
    await tracker.recordUsage({ ...input, reservationId: decision.reservationId });
    await tracker.recordUsage({ ...input, reservationId: decision.reservationId });
    expect((await store.getReservation("test", decision.reservationId!))?.status).toBe("settled");
    expect((await tracker.queryCosts({ tenantId: "test" })).total).toBe("0.072");
  });
  it("retains uncertain holds and refuses blind expiry", async () => {
    const store = new InMemoryUsageStore();
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
    const assessment = calculateCharges({
      ...fixtureRecord(),
      purpose: "original",
      catalog: { ...fixtureCatalog(), rules: [] },
      assessmentId: "unknown",
    });
    await store.commitAssessmentAndSettle({
      assessment,
      view: "original",
      expectedSelectionRevision: 0,
      reservationId: "r",
    });
    expect((await store.getReservation("test", "r"))?.status).toBe("uncertain");
    await expect(store.releaseReservation("test", "r", false)).rejects.toThrow("reconciliation");
    expect((await store.balances("test", [{ key: "scope", limit: "2", currency: "USD" }]))[0].reserved).toBe("1");
  });
  it("known over-limit spend takes precedence over warning about unknown cost", async () => {
    const tracker = new CostTracker({ catalog: fixtureCatalog(), budget: policy("0.05") });
    const record = fixtureRecord();
    record.usage.coverage.requiredMeters.push("unknown.extra");
    await tracker.recordUsage(record);
    const decision = await tracker.checkBudget(record);
    expect(decision.status).toBe("blocked");
    expect(decision.reason).toBe("limit");
  });
  it("requires a bound and declared scope for strict admission", async () => {
    const config = policy("1", "reservation");
    delete config.conservativeBound;
    const tracker = new CostTracker({ catalog: fixtureCatalog(), budget: config });
    expect((await tracker.checkBudget({ runId: "r", attemptId: "a" })).reason).toBe("missing_bound");
    expect((await tracker.checkBudget({ attemptId: "a" }, "0.1")).reason).toBe("missing_scope");
  });
});

it("new budget policies include prior spend from a tracker with no policy", async () => {
  const store = new InMemoryUsageStore();
  const writer = new CostTracker({ store, catalog: fixtureCatalog() });
  await writer.recordUsage(fixtureRecord());
  const guarded = new CostTracker({ store, catalog: fixtureCatalog(), budget: policy("0.05") });
  expect((await guarded.checkBudget({ tenantId: "test", runId: "run-1" })).status).toBe("blocked");
});
it("admission replay on the same attempt cannot reserve twice", async () => {
  const store = new InMemoryUsageStore();
  const tracker = new CostTracker({ store, catalog: fixtureCatalog(), budget: policy("1", "reservation") });
  const first = await tracker.checkBudget({ tenantId: "test", runId: "run-1", attemptId: "attempt-1" });
  const second = await tracker.checkBudget({ tenantId: "test", runId: "run-1", attemptId: "attempt-1" });
  expect(second.reservationId).toBe(first.reservationId);
  expect((await store.getReservation("test", first.reservationId!))?.amount).toBe("0.072");
});

it.each([
  ["warn", "block", "blocked"],
  ["throw", "warn", "warned"],
] as const)("atomic unknown admission respects exceeded=%s unknown=%s", async (onExceeded, onUnknown, status) => {
  const store = new InMemoryUsageStore();
  store.reserve = async () => ({
    accepted: false,
    balances: [{ key: "scope", limit: "1", spent: "0", reserved: "0", unknownCount: 1, currency: "USD" }],
  });
  const tracker = new CostTracker({
    store,
    catalog: fixtureCatalog(),
    budget: { ...policy("1", "reservation"), onExceeded, onUnknown },
  });
  const decision = await tracker.checkBudget({ tenantId: "test", runId: "r", attemptId: "a" });
  expect(decision.status).toBe(status);
  expect(decision.reason).toBe("unknown_cost");
});
it("unsettled start intent without a reservation prevents strict admission after restart", async () => {
  const store = new InMemoryUsageStore();
  const unguarded = new CostTracker({ store, catalog: fixtureCatalog() });
  await unguarded.startAttempt(fixtureRecord());
  const guarded = new CostTracker({ store, catalog: fixtureCatalog(), budget: policy("1", "reservation") });
  expect((await guarded.checkBudget({ tenantId: "test", runId: "run-1", attemptId: "second" })).reason).toBe(
    "unknown_cost",
  );
  unguarded.endPendingAttempt(JSON.stringify(["test", "attempt-1"]));
});

it("legacy maxTokensPerRun shorthand applies to canonical calls including zero and warning", async () => {
  const zero = new CostTracker({ budget: { maxTokensPerRun: 0 } });
  expect((await zero.checkBudget({ runId: "r" })).status).toBe("blocked");
  const tracker = new CostTracker({
    catalog: fixtureCatalog(),
    budget: { maxTokensPerRun: 10000, onBudgetExceeded: "warn" },
  });
  await tracker.recordUsage(fixtureRecord());
  expect((await tracker.checkBudget({ tenantId: "test", runId: "run-1" })).status).toBe("warned");
});

it("duplicate budget scopes are rejected before reservations can be double-settled", () => {
  const budget = policy("1", "reservation");
  budget.limits.push({ ...budget.limits[0] });
  expect(() => new CostTracker({ budget })).toThrow("Duplicate budget scope");
});
