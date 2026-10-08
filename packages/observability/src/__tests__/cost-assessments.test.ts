import { type CostAssessment, EventBus } from "@agentium/core";
import { describe, expect, it } from "vitest";
import { MetricsCollector } from "../metrics.js";

function assessment(overrides: Partial<CostAssessment> = {}): CostAssessment {
  return {
    tenantId: "tenant",
    assessmentId: "partial-1",
    attemptId: "attempt",
    targetKind: "attempt",
    targetId: "attempt",
    usageRevision: 1,
    createdAt: "2026-10-08T12:00:00Z",
    context: {
      providerId: "fixture",
      billingProviderId: "fixture",
      modelId: "model",
      api: "fixture",
      occurredAt: "2026-10-08T12:00:00Z",
    },
    catalogId: "fixture",
    catalogVersion: "1",
    currency: "USD",
    charges: [],
    knownSubtotal: "0.047",
    total: null,
    unpricedCount: 1,
    pricingStatus: "partial",
    usageStatus: "complete",
    executionStatus: "succeeded",
    basis: "list_price",
    purpose: "original",
    finality: "provisional",
    arithmeticPolicy: "rational-36-half-up-v1",
    ...overrides,
  };
}

describe("canonical cost assessment metrics", () => {
  it("shows the known partial subtotal separately from complete-run compatibility totals", () => {
    const bus = new EventBus();
    const metrics = new MetricsCollector();
    metrics.attach(bus);
    const partial = assessment();
    bus.emit("cost.assessed", { runId: "run", assessment: partial });
    bus.emit("cost.assessed", { runId: "run", assessment: partial });
    expect(metrics.getMetrics().gauges).toMatchObject({
      known_attempt_cost_usd: 0.047,
      total_cost_usd: 0,
      unpriced_attempts: 1,
      provisional_attempts: 1,
      assessed_attempts: 1,
    });
    bus.emit("cost.assessed", {
      runId: "run",
      assessment: assessment({
        assessmentId: "complete-2",
        usageRevision: 2,
        knownSubtotal: "0.072",
        total: "0.072",
        pricingStatus: "complete",
        unpricedCount: 0,
        finality: "final",
      }),
    });
    bus.emit("cost.assessed", { runId: "run", assessment: partial });
    expect(metrics.getMetrics().gauges).toMatchObject({
      known_attempt_cost_usd: 0.072,
      total_cost_usd: 0,
      unpriced_attempts: 0,
      provisional_attempts: 0,
      assessed_attempts: 1,
    });
    bus.emit("run.start", { runId: "run", agentName: "worker", input: "work" });
    bus.emit("cost.tracked", {
      runId: "run",
      agentName: "worker",
      modelId: "model",
      cost: 0.072,
      usage: { promptTokens: 15000, completionTokens: 500, totalTokens: 15500 },
    });
    expect(metrics.getMetrics().gauges.known_attempt_cost_usd).toBe(0.072);
    expect(metrics.getMetrics().gauges.total_cost_usd).toBe(0.072);
  });
  it("does not mix currencies or group charges into an own-attempt USD subtotal", () => {
    const bus = new EventBus();
    const metrics = new MetricsCollector();
    metrics.attach(bus);
    bus.emit("cost.assessed", { assessment: assessment({ currency: "EUR", total: "0.047" }) });
    bus.emit("cost.assessed", {
      assessment: assessment({ targetKind: "billing_group", targetId: "batch", total: "2", knownSubtotal: "2" }),
    });
    expect(metrics.getMetrics().gauges.known_attempt_cost_usd).toBe(0);
    expect(metrics.getMetrics().gauges.assessed_attempts).toBe(1);
  });
});
