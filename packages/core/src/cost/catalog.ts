import { z } from "zod";
import type { BillingContext, Measurement, PriceRule, PricingCatalog, UnpricedReason } from "./accounting-types.js";
import { Decimal, nonnegativeDecimal } from "./decimal.js";

const decimalSchema = z.string().refine((value) => {
  try {
    nonnegativeDecimal(value);
    return true;
  } catch {
    return false;
  }
}, "Expected a nonnegative decimal string");
const positiveDecimalSchema = decimalSchema.refine((value) => Decimal.from(value).compare(Decimal.zero()) > 0);
const matchSchema = z.record(z.string(), z.union([z.string(), z.array(z.string()).min(1)]));
const ruleSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  meter: z.string().min(1),
  unit: z.string().min(1),
  currency: z.string().regex(/^[A-Z]{3}$/),
  match: matchSchema,
  requiredContext: z.array(z.string()).optional(),
  contextBand: z
    .object({
      field: z.literal("inputTokens"),
      above: z.number().nonnegative().optional(),
      upTo: z.number().nonnegative().optional(),
    })
    .optional(),
  effectiveFrom: z.iso.datetime().optional(),
  effectiveUntil: z.iso.datetime().optional(),
  verifiedAt: z.iso.datetime(),
  sourceUrl: z.url(),
  precedence: z.enum(["contract", "standard"]).optional(),
  scope: z.enum(["attempt", "session", "account_period"]).optional(),
  groupBy: z.array(z.string()).optional(),
  rate: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("unit"), amount: decimalSchema, per: positiveDecimalSchema }),
    z.object({ kind: z.literal("fixed"), amount: decimalSchema }),
    z.object({
      kind: z.literal("tiered"),
      tiers: z
        .array(z.object({ upTo: positiveDecimalSchema.nullable(), amount: decimalSchema, per: positiveDecimalSchema }))
        .min(1),
    }),
  ]),
  rounding: z
    .object({
      increment: positiveDecimalSchema,
      mode: z.enum(["ceil", "floor", "half_up"]),
      minimum: decimalSchema.optional(),
    })
    .optional(),
  adjustments: z
    .array(
      z.object({ id: z.string().min(1), kind: z.enum(["multiply", "add"]), amount: z.string(), sourceUrl: z.url() }),
    )
    .optional(),
});
export function validateCatalog(catalog: PricingCatalog): void {
  z.object({
    id: z.string().min(1),
    version: z.string().min(1),
    rules: z.array(ruleSchema),
    validUntil: z.iso.datetime().optional(),
  }).parse(catalog);
  const ids = new Set<string>();
  for (const rule of catalog.rules) {
    if (ids.has(rule.id)) throw new TypeError(`Duplicate price rule: ${rule.id}`);
    ids.add(rule.id);
    for (const field of [
      "providerId",
      "billingProviderId",
      "modelId",
      "api",
      "actualServiceTier",
      "region",
      "reasoningMode",
      "reasoningEffort",
      "contractId",
      "modality",
    ])
      if (!rule.match[field]) throw new TypeError(`Rule ${rule.id} must explicitly match ${field}`);
    if (rule.effectiveFrom && rule.effectiveUntil && rule.effectiveFrom >= rule.effectiveUntil)
      throw new TypeError(`Invalid effective interval: ${rule.id}`);
    if (
      rule.contextBand?.above !== undefined &&
      rule.contextBand.upTo !== undefined &&
      rule.contextBand.above >= rule.contextBand.upTo
    )
      throw new TypeError(`Invalid context band: ${rule.id}`);
    let previous = Decimal.zero();
    if (rule.rate.kind === "tiered") {
      for (const [index, tier] of rule.rate.tiers.entries()) {
        if (tier.upTo === null && index !== rule.rate.tiers.length - 1)
          throw new TypeError("An unlimited tier must be last");
        if (tier.upTo !== null) {
          const end = Decimal.from(tier.upTo);
          if (end.compare(previous) <= 0) throw new TypeError("Tier boundaries must increase");
          previous = end;
        }
      }
      if (rule.rate.tiers.at(-1)?.upTo !== null) throw new TypeError("Tiered rules must cover the remaining quantity");
    }
    const adjustments = new Set<string>();
    for (const adjustment of rule.adjustments ?? []) {
      if (adjustments.has(adjustment.id)) throw new TypeError("Duplicate adjustment");
      adjustments.add(adjustment.id);
      if (adjustment.kind === "multiply") nonnegativeDecimal(adjustment.amount);
      else Decimal.from(adjustment.amount);
    }
  }
  const aliases = new Set<string>();
  for (const alias of catalog.aliases ?? []) {
    const key = JSON.stringify([alias.providerId, alias.billingProviderId, alias.api, alias.from]);
    if (aliases.has(key) || alias.from === alias.to) throw new TypeError("Ambiguous or cyclic catalog alias");
    aliases.add(key);
    if (
      (catalog.aliases ?? []).some(
        (other) =>
          other.from === alias.to &&
          other.providerId === alias.providerId &&
          other.billingProviderId === alias.billingProviderId &&
          other.api === alias.api,
      )
    )
      throw new TypeError("Alias chains are not supported");
    if (!catalog.rules.some((rule) => matchesValue(rule.match.modelId, alias.to)))
      throw new TypeError(`Alias target has no rule: ${alias.to}`);
  }
  for (let i = 0; i < catalog.rules.length; i++)
    for (let j = i + 1; j < catalog.rules.length; j++) {
      const a = catalog.rules[i];
      const b = catalog.rules[j];
      if (
        a.meter !== b.meter ||
        a.currency !== b.currency ||
        (a.precedence ?? "standard") !== (b.precedence ?? "standard")
      )
        continue;
      if (
        (a.effectiveUntil ?? "9999") <= (b.effectiveFrom ?? "") ||
        (b.effectiveUntil ?? "9999") <= (a.effectiveFrom ?? "")
      )
        continue;
      if (
        a.contextBand &&
        b.contextBand &&
        ((a.contextBand.upTo ?? Infinity) <= (b.contextBand.above ?? -1) ||
          (b.contextBand.upTo ?? Infinity) <= (a.contextBand.above ?? -1))
      )
        continue;
      const keys = new Set([...Object.keys(a.match), ...Object.keys(b.match)]);
      if ([...keys].every((key) => overlaps(a.match[key], b.match[key])))
        throw new TypeError(`Overlapping price rules: ${a.id}, ${b.id}`);
    }
}
function matchesValue(expected: string | string[] | undefined, actual: unknown): boolean {
  return expected === "*" || (Array.isArray(expected) ? expected.includes(String(actual)) : expected === actual);
}
function overlaps(a: string | string[] | undefined, b: string | string[] | undefined): boolean {
  if (a === undefined || b === undefined || a === "*" || b === "*") return true;
  return (Array.isArray(a) ? a : [a]).some((value) => (Array.isArray(b) ? b : [b]).includes(value));
}
export function billingFacts(context: BillingContext, measurement: Measurement): Record<string, unknown> {
  const dimensions = { ...context.dimensions, ...measurement.dimensions };
  for (const key of Object.keys(dimensions)) {
    if (
      [
        "providerId",
        "billingProviderId",
        "modelId",
        "api",
        "occurredAt",
        "requestedModelId",
        "resourceId",
        "accountId",
        "contractId",
        "region",
        "requestedServiceTier",
        "actualServiceTier",
        "reasoningMode",
        "reasoningEffort",
        "inputTokens",
        "providerRequestId",
        "provenance",
        "dimensions",
      ].includes(key)
    )
      throw new TypeError(`Billing dimension collides with context: ${key}`);
  }
  return { ...dimensions, ...context };
}
export function resolvePriceRule(
  catalog: PricingCatalog,
  context: BillingContext,
  measurement: Measurement,
  currency = "USD",
): { rule: PriceRule } | { reason: UnpricedReason } {
  if (catalog.validUntil && context.occurredAt >= catalog.validUntil) return { reason: "stale_catalog" };
  const alias = catalog.aliases?.find(
    (item) =>
      item.providerId === context.providerId &&
      item.billingProviderId === context.billingProviderId &&
      item.api === context.api &&
      item.from === context.modelId,
  );
  const facts = billingFacts({ ...context, modelId: alias?.to ?? context.modelId }, measurement);
  const candidates: PriceRule[] = [];
  let missingContext = false;
  let historicalUnknown = false;
  for (const rule of catalog.rules) {
    if (rule.meter !== measurement.meter || rule.currency !== currency) continue;
    if (
      Object.entries(rule.match).some(
        ([key, expected]) => facts[key] !== undefined && !matchesValue(expected, facts[key]),
      )
    )
      continue;
    if (
      Object.entries(rule.match).some(([key, expected]) => expected !== "*" && facts[key] === undefined) ||
      rule.requiredContext?.some((key) => facts[key] === undefined)
    ) {
      missingContext = true;
      continue;
    }
    if (rule.effectiveFrom && context.occurredAt < rule.effectiveFrom) continue;
    if (rule.effectiveUntil && context.occurredAt >= rule.effectiveUntil) continue;
    if (!rule.effectiveFrom && context.occurredAt < rule.verifiedAt) {
      historicalUnknown = true;
      continue;
    }
    if (rule.contextBand) {
      if (context.inputTokens === undefined) {
        missingContext = true;
        continue;
      }
      if (rule.contextBand.above !== undefined && context.inputTokens <= rule.contextBand.above) continue;
      if (rule.contextBand.upTo !== undefined && context.inputTokens > rule.contextBand.upTo) continue;
    }
    candidates.push(rule);
  }
  const preferred = candidates.some((rule) => rule.precedence === "contract")
    ? candidates.filter((rule) => rule.precedence === "contract")
    : candidates;
  if (preferred.length > 1) return { reason: "ambiguous_rate" };
  if (preferred.length === 0)
    return {
      reason: missingContext ? "missing_context" : historicalUnknown ? "historical_rate_unknown" : "missing_rate",
    };
  if (preferred[0].unit !== measurement.unit) return { reason: "unit_mismatch" };
  return { rule: preferred[0] };
}
