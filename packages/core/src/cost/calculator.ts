import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AccountingScope,
  BillingContext,
  CostAssessment,
  CostCharge,
  ExecutionStatus,
  Measurement,
  NormalizedUsage,
  PriceRule,
  PricingCatalog,
  UsageStatus,
} from "./accounting-types.js";
import { resolvePriceRule, validateCatalog } from "./catalog.js";
import { Decimal, nonnegativeDecimal, sumDecimals } from "./decimal.js";
import { validateNormalizedUsage } from "./usage.js";
export interface CalculateChargesInput extends AccountingScope {
  context: BillingContext;
  usage: NormalizedUsage;
  catalog: PricingCatalog;
  currency?: string;
  assessmentId?: string;
  targetKind?: CostAssessment["targetKind"];
  targetId?: string;
  attemptId?: string;
  usageRevision?: number;
  executionStatus?: ExecutionStatus;
  usageStatus?: UsageStatus;
  finality?: CostAssessment["finality"];
  purpose?: CostAssessment["purpose"];
  basis?: CostAssessment["basis"];
}
function priceQuantity(quantity: Decimal, rule: PriceRule): { billed: string; before: string; amount: string } {
  let billed = quantity;
  if (rule.rounding) {
    if (rule.rounding.minimum) {
      const minimum = nonnegativeDecimal(rule.rounding.minimum);
      if (billed.compare(minimum) < 0) billed = minimum;
    }
    billed = billed.round(nonnegativeDecimal(rule.rounding.increment), rule.rounding.mode);
  }
  let amount = Decimal.zero();
  if (rule.rate.kind === "unit")
    amount = billed.multiply(nonnegativeDecimal(rule.rate.amount)).divide(nonnegativeDecimal(rule.rate.per));
  else if (rule.rate.kind === "fixed") amount = billed.multiply(nonnegativeDecimal(rule.rate.amount));
  else {
    let previous = Decimal.zero();
    for (const tier of rule.rate.tiers) {
      const end = tier.upTo === null ? billed : nonnegativeDecimal(tier.upTo);
      const upper = billed.compare(end) < 0 ? billed : end;
      const width = upper.subtract(previous);
      if (width.compare(Decimal.zero()) > 0)
        amount = amount.add(width.multiply(nonnegativeDecimal(tier.amount)).divide(nonnegativeDecimal(tier.per)));
      previous = end;
      if (billed.compare(end) <= 0) break;
    }
  }
  const before = amount.toString();
  for (const adjustment of rule.adjustments ?? [])
    amount =
      adjustment.kind === "multiply"
        ? amount.multiply(nonnegativeDecimal(adjustment.amount))
        : amount.add(Decimal.from(adjustment.amount));
  return { billed: billed.toString(), before, amount: amount.toString() };
}
/** A deterministic, network-free assessment. Catalogs must first pass validateCatalog. */
export function calculateCharges(input: CalculateChargesInput): CostAssessment {
  const { context, catalog } = input;
  validateCatalog(catalog);
  z.object({
    providerId: z.string().min(1).max(512),
    billingProviderId: z.string().min(1).max(512),
    modelId: z.string().min(1).max(512),
    api: z.string().min(1).max(512),
    occurredAt: z.iso.datetime(),
    inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    dimensions: z.record(z.string().max(256), z.string().max(512)).optional(),
  }).parse(context);
  const usage = validateNormalizedUsage(input.usage);
  const currency = input.currency ?? "USD";
  const targetKind = input.targetKind ?? "attempt";
  const assessmentId = input.assessmentId ?? randomUUID();
  const charges: CostCharge[] = [];
  const measurements = [...usage.measurements];
  const present = new Set(measurements.map((item) => item.meter));
  for (const meter of usage.coverage.requiredMeters)
    if (!present.has(meter))
      measurements.push({
        id: `missing:${meter}`,
        meter,
        unit: "unknown",
        quantity: null,
        dimensions: {},
        source: "derived",
        evidencePaths: [],
      });
  for (const feature of usage.coverage.unsupportedFeatures)
    measurements.push({
      id: `unsupported:${feature}`,
      meter: `unsupported.${feature}`,
      unit: "unknown",
      quantity: null,
      dimensions: {},
      source: "derived",
      evidencePaths: [],
    });
  if (measurements.length === 0)
    measurements.push({
      id: "missing:usage",
      meter: "unknown.usage",
      unit: "unknown",
      quantity: null,
      dimensions: {},
      source: "derived",
      evidencePaths: [],
    });
  const duplicateIds = new Set<string>();
  for (const measurement of measurements) {
    const charge: CostCharge = {
      id: `${assessmentId}:${measurement.id}`,
      measurementId: measurement.id,
      meter: measurement.meter,
      unit: measurement.unit,
      quantity: measurement.quantity,
      billedQuantity: null,
      dimensions: { ...measurement.dimensions },
      currency,
      amount: null,
      amountBeforeAdjustments: null,
      catalogId: catalog.id,
      catalogVersion: catalog.version,
      source: measurement.source,
      evidencePaths: [...measurement.evidencePaths],
      inclusion: "payable",
    };
    if (duplicateIds.has(measurement.id)) throw new TypeError(`Duplicate measurement ID: ${measurement.id}`);
    duplicateIds.add(measurement.id);
    if (measurement.quantity === null)
      charge.reason = measurement.id.startsWith("unsupported:") ? "unsupported_rule" : "missing_usage";
    else {
      try {
        const quantity = nonnegativeDecimal(measurement.quantity);
        const result = resolvePriceRule(catalog, context, measurement, currency);
        if ("reason" in result) charge.reason = result.reason;
        else {
          charge.rule = structuredClone(result.rule);
          if (targetKind === "attempt" && result.rule.scope && result.rule.scope !== "attempt") {
            charge.inclusion = "contribution";
            charge.reason = "group_contribution";
          } else {
            const priced = priceQuantity(quantity, result.rule);
            charge.amount = priced.amount;
            charge.amountBeforeAdjustments = priced.before;
            charge.billedQuantity = priced.billed;
          }
        }
      } catch {
        charge.reason = "invalid_usage";
      }
    }
    charges.push(charge);
  }
  const unpricedCount = charges.filter((charge) => charge.amount === null).length;
  const knownSubtotal = sumDecimals(charges.flatMap((charge) => (charge.amount === null ? [] : [charge.amount])));
  const derivedUsageStatus = usage.issues.some(
    (issue) =>
      issue.code.includes("invalid") ||
      issue.code.includes("partition_mismatch") ||
      issue.code.includes("subset_mismatch") ||
      issue.code === "canonical_total_mismatch",
  )
    ? "invalid"
    : measurements.every((m) => m.quantity === null)
      ? "unknown"
      : measurements.some((m) => m.quantity === null)
        ? "partial"
        : "complete";
  const usageStatus = derivedUsageStatus === "invalid" ? "invalid" : (input.usageStatus ?? derivedUsageStatus);
  const complete = unpricedCount === 0 && usageStatus === "complete";
  return {
    tenantId: input.tenantId ?? "local",
    operationId: input.operationId,
    parentOperationId: input.parentOperationId,
    runId: input.runId,
    rootRunId: input.rootRunId,
    parentRunId: input.parentRunId,
    ancestorRunIds: input.ancestorRunIds,
    sessionId: input.sessionId,
    userId: input.userId,
    agentName: input.agentName,
    assessmentId,
    attemptId: input.attemptId,
    targetKind,
    targetId: input.targetId ?? input.attemptId ?? assessmentId,
    usageRevision: input.usageRevision ?? 1,
    createdAt: context.occurredAt,
    context: structuredClone(context),
    catalogId: catalog.id,
    catalogVersion: catalog.version,
    currency,
    charges,
    knownSubtotal,
    total: complete ? knownSubtotal : null,
    unpricedCount: unpricedCount + (!complete && unpricedCount === 0 ? 1 : 0),
    pricingStatus: complete ? "complete" : charges.some((charge) => charge.amount !== null) ? "partial" : "unpriced",
    usageStatus,
    executionStatus: input.executionStatus ?? "succeeded",
    basis: input.basis ?? "list_price",
    purpose: input.purpose ?? "original",
    finality: input.finality ?? "final",
    arithmeticPolicy: "rational-36-half-up-v1",
  };
}
/** Exact group allocation. The last sorted member receives the rounding remainder. */
export function allocateGroupAmount(
  amount: string,
  members: Array<{ operationId: string; weight: string }>,
): Array<{ operationId: string; amount: string }> {
  const sorted = [...members].sort((a, b) => a.operationId.localeCompare(b.operationId));
  if (new Set(sorted.map((m) => m.operationId)).size !== sorted.length)
    throw new TypeError("Duplicate allocation target");
  const totalWeight = Decimal.from(sumDecimals(sorted.map((m) => nonnegativeDecimal(m.weight).toString())));
  if (totalWeight.compare(Decimal.zero()) === 0) throw new RangeError("Allocation weights must have a positive sum");
  let allocated = Decimal.zero();
  return sorted.map((member, index) => {
    const share =
      index === sorted.length - 1
        ? Decimal.from(amount).subtract(allocated).toString()
        : Decimal.from(amount).multiply(Decimal.from(member.weight)).divide(totalWeight).toString();
    allocated = allocated.add(Decimal.from(share));
    return { operationId: member.operationId, amount: share };
  });
}
export function sumMeasurements(measurements: Measurement[]): Measurement[] {
  const groups = new Map<string, Measurement>();
  for (const measurement of measurements) {
    const key = JSON.stringify([measurement.meter, measurement.unit, Object.entries(measurement.dimensions).sort()]);
    const existing = groups.get(key);
    if (!existing) groups.set(key, structuredClone(measurement));
    else {
      existing.quantity =
        existing.quantity === null || measurement.quantity === null
          ? null
          : sumDecimals([existing.quantity, measurement.quantity]);
      existing.evidencePaths = [...new Set([...existing.evidencePaths, ...measurement.evidencePaths])];
    }
  }
  return [...groups.values()];
}
