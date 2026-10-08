import type {
  BillingContext,
  NormalizedUsage,
  PriceRule,
  PricingCatalog,
  UsageRecordInput,
} from "../accounting-types.js";
import { tokenMeasurements } from "../measurements.js";
export const fixtureContext: BillingContext = {
  providerId: "fixture",
  billingProviderId: "fixture",
  modelId: "fixture-model",
  api: "fixture-v1",
  occurredAt: "2026-10-08T12:00:00.000Z",
  actualServiceTier: "standard",
  region: "global",
  inputTokens: 15000,
};
export function fixtureUsage(): NormalizedUsage {
  const tokens = {
    input: { total: 15000, ordinary: 1000, cacheRead: 12000, cacheWrite: 2000, cacheWriteByTTL: [] },
    output: { total: 500, reasoning: 100 },
    total: 15500,
    providerReportedTotal: 15500,
  };
  return {
    schemaVersion: 1,
    normalizerId: "synthetic.fixture",
    normalizerVersion: "1",
    tokens,
    measurements: tokenMeasurements(tokens),
    coverage: {
      requiredMeters: ["token.input", "token.cache_read", "token.cache_write", "token.output"],
      unsupportedFeatures: [],
    },
    issues: [],
  };
}
export function fixtureRule(meter = "token.input", amount = "10", extra: Partial<PriceRule> = {}): PriceRule {
  return {
    id: meter,
    version: "1",
    meter,
    unit: "token",
    currency: "USD",
    match: {
      providerId: "fixture",
      billingProviderId: "fixture",
      modelId: "fixture-model",
      api: "fixture-v1",
      actualServiceTier: "*",
      region: "*",
      reasoningMode: "*",
      reasoningEffort: "*",
      contractId: "*",
      modality: "*",
    },
    verifiedAt: "2026-10-08T00:00:00.000Z",
    sourceUrl: "https://example.com/synthetic-test-tariff",
    rate: { kind: "unit", amount, per: "1000000" },
    ...extra,
  };
}
export function fixtureCatalog(): PricingCatalog {
  return {
    id: "synthetic",
    version: "1",
    rules: [
      fixtureRule("token.input", "10"),
      fixtureRule("token.cache_read", "1"),
      fixtureRule("token.cache_write", "12.5"),
      fixtureRule("token.output", "50"),
    ],
  };
}
export function fixtureRecord(attemptId = "attempt-1"): UsageRecordInput {
  return {
    tenantId: "test",
    attemptId,
    operationId: `operation-${attemptId}`,
    runId: "run-1",
    rootRunId: "root-1",
    sessionId: "session-1",
    userId: "user-1",
    context: fixtureContext,
    usage: fixtureUsage(),
    executionStatus: "succeeded",
  };
}
