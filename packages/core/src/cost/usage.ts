import { z } from "zod";
import type { CanonicalTokens, NormalizationIssue, NormalizedUsage, UsageJson } from "./accounting-types.js";

const tokenCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const decimalQuantitySchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);

/** Validate counters before arithmetic. Missing and invalid counters remain unknown. */
export function readTokenCount(value: unknown, path: string, issues: NormalizationIssue[]): number | null {
  if (value === undefined || value === null) return null;
  const result = tokenCountSchema.safeParse(value);
  if (result.success) return result.data;
  issues.push({ code: "invalid_token_count", path, message: "Expected a finite nonnegative safe integer" });
  return null;
}

export function isDecimalQuantity(value: unknown): value is string {
  return decimalQuantitySchema.safeParse(value).success;
}

export function sumTokenCounts(values: (number | null)[], issues: NormalizationIssue[], path: string): number | null {
  if (values.some((value) => value === null)) return null;
  let sum = 0;
  for (const value of values) sum += value ?? 0;
  return readTokenCount(sum, path, issues);
}

export function unknownTokens(): CanonicalTokens {
  return {
    input: { total: null, ordinary: null, cacheRead: null, cacheWrite: null, cacheWriteByTTL: [] },
    output: { total: null, reasoning: null },
    total: null,
    providerReportedTotal: null,
  };
}

/** Retain bounded usage data, never a response body or request credentials. */
export function retainRawUsage(value: unknown): { rawUsage: UsageJson; rawUsageTruncated: boolean } {
  let truncated = false;
  let entries = 0;
  let bytes = 0;
  function copy(item: unknown, depth: number): UsageJson {
    if (depth > 8 || entries++ > 512 || bytes > 32_768) {
      truncated = true;
      return null;
    }
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number") {
      const scalar = Number.isFinite(item) ? item : String(item);
      bytes += Buffer.byteLength(JSON.stringify(scalar), "utf8");
      return scalar;
    }
    if (typeof item === "string") {
      if (item.length > 256) truncated = true;
      const safe = item.slice(0, 256);
      bytes += Buffer.byteLength(JSON.stringify(safe), "utf8");
      return safe;
    }
    if (Array.isArray(item)) {
      if (item.length > 128) truncated = true;
      return item.slice(0, 128).map((entry) => copy(entry, depth + 1));
    }
    if (item && typeof item === "object") {
      const output: { [key: string]: UsageJson } = {};
      for (const [key, entry] of Object.entries(item)) {
        if (
          key.length > 128 ||
          /authorization|api[_-]?key|secret|password|headers/i.test(key) ||
          (/prompt|content|messages/i.test(key) && !/tokens?|count|cachedContent/i.test(key))
        ) {
          truncated = true;
          continue;
        }
        bytes += Buffer.byteLength(JSON.stringify(key), "utf8") + 2;
        if (entries > 512 || bytes > 32_768) {
          truncated = true;
          break;
        }
        output[key] = copy(entry, depth + 1);
      }
      return output;
    }
    return null;
  }
  const copied = copy(value, 0);
  let rawUsage = copied && typeof copied === "object" && !Array.isArray(copied) ? copied : {};
  // The final check includes UTF-8, keys, commas, brackets, numbers and JSON escaping.
  if (Buffer.byteLength(JSON.stringify(rawUsage), "utf8") > 32_768) {
    truncated = true;
    rawUsage = {};
  }
  return { rawUsage, rawUsageTruncated: truncated };
}

/** Check relationships without changing provider evidence or inventing residual usage. */
export function validateCanonicalTokens(tokens: CanonicalTokens, issues: NormalizationIssue[]): void {
  const { input, output } = tokens;
  const canonicalTotal = sumTokenCounts([input.total, output.total], issues, "total");
  if (tokens.total !== null && canonicalTotal !== null && tokens.total !== canonicalTotal)
    issues.push({
      code: "canonical_total_mismatch",
      path: "total",
      message: "Canonical total must equal inclusive input plus output",
    });
  if (new Set(input.cacheWriteByTTL.map((bucket) => bucket.ttlSeconds)).size !== input.cacheWriteByTTL.length)
    issues.push({
      code: "cache_ttl_partition_mismatch",
      path: "input.cacheWriteByTTL",
      message: "Cache TTL buckets must have distinct durations",
    });
  const inputParts = sumTokenCounts([input.ordinary, input.cacheRead, input.cacheWrite], issues, "input.total");
  if (input.total !== null && inputParts !== null && input.total !== inputParts)
    issues.push({
      code: "input_partition_mismatch",
      path: "input",
      message: "Input categories do not equal the inclusive input total",
    });
  if (output.reasoning !== null && output.total !== null && output.reasoning > output.total)
    issues.push({
      code: "reasoning_subset_mismatch",
      path: "output.reasoning",
      message: "Reasoning exceeds inclusive output",
    });
  if (input.cacheWriteByTTL.length && input.cacheWrite !== null) {
    const total = sumTokenCounts(
      input.cacheWriteByTTL.map((bucket) => bucket.tokens),
      issues,
      "input.cacheWriteByTTL",
    );
    if (total !== input.cacheWrite)
      issues.push({
        code: "cache_ttl_partition_mismatch",
        path: "input.cacheWriteByTTL",
        message: "Cache TTL buckets do not equal cache writes",
      });
  }
  if (tokens.providerReportedTotal !== null && tokens.total !== null && tokens.providerReportedTotal !== tokens.total)
    issues.push({
      code: "provider_total_mismatch",
      path: "providerReportedTotal",
      message: "Provider total differs from the canonical input plus output total",
    });
}

const tokenSchema = tokenCountSchema.nullable();
const tokensSchema = z.object({
  input: z.object({
    total: tokenSchema,
    ordinary: tokenSchema,
    cacheRead: tokenSchema,
    cacheWrite: tokenSchema,
    cacheWriteByTTL: z.array(z.object({ ttlSeconds: tokenCountSchema.positive(), tokens: tokenCountSchema })).max(64),
  }),
  output: z.object({ total: tokenSchema, reasoning: tokenSchema }),
  total: tokenSchema,
  providerReportedTotal: tokenSchema,
});
const labelSchema = z.string().min(1).max(256);
const dimensionsSchema = z
  .record(z.string(), z.string().max(256))
  .refine(
    (value) =>
      Object.keys(value).length <= 64 &&
      Object.keys(value).every((key) => key.length <= 128 && !/secret|password|api[_-]?key|authorization/i.test(key)),
  );
const measurementSchema = z.object({
  id: labelSchema,
  meter: labelSchema,
  unit: labelSchema,
  quantity: decimalQuantitySchema.max(256).nullable(),
  dimensions: dimensionsSchema,
  source: z.enum(["provider", "derived", "measured", "estimated"]),
  evidencePaths: z.array(z.string().max(256)).max(64),
});
const issueSchema = z.object({
  code: labelSchema,
  path: z.string().max(256).optional(),
  message: z.string().max(2048),
});
const contextSchema = z.object({
  providerId: labelSchema.optional(),
  billingProviderId: labelSchema.optional(),
  modelId: labelSchema.optional(),
  api: labelSchema.optional(),
  occurredAt: z.string().datetime().optional(),
  requestedModelId: labelSchema.optional(),
  resourceId: labelSchema.optional(),
  accountId: labelSchema.optional(),
  contractId: labelSchema.optional(),
  region: labelSchema.optional(),
  requestedServiceTier: labelSchema.optional(),
  actualServiceTier: labelSchema.optional(),
  reasoningMode: labelSchema.optional(),
  reasoningEffort: labelSchema.optional(),
  inputTokens: tokenCountSchema.optional(),
  providerRequestId: labelSchema.optional(),
  dimensions: dimensionsSchema.optional(),
  provenance: z
    .record(z.string(), z.enum(["response", "request", "documented_default", "configured_contract", "unknown"]))
    .optional(),
});

/** Validate custom adapter data at runtime; preserve evidence when a typed JavaScript caller is malformed. */
export function validateNormalizedUsage(value: NormalizedUsage): NormalizedUsage {
  const envelope = z
    .object({
      schemaVersion: z.literal(1),
      normalizerId: labelSchema,
      normalizerVersion: labelSchema,
      tokens: z.unknown(),
      measurements: z.array(z.unknown()).max(1024),
      coverage: z.object({
        requiredMeters: z.array(labelSchema).max(1024),
        unsupportedFeatures: z.array(labelSchema).max(256),
      }),
      issues: z.array(issueSchema).max(256),
      rawUsage: z.unknown().optional(),
      rawUsageTruncated: z.boolean().optional(),
      context: z.unknown().optional(),
    })
    .safeParse(value);
  if (!envelope.success)
    return {
      schemaVersion: 1,
      normalizerId: "agentium/invalid",
      normalizerVersion: "1.0.0",
      tokens: unknownTokens(),
      measurements: [],
      coverage: { requiredMeters: ["usage.invalid"], unsupportedFeatures: ["invalid_normalized_usage"] },
      issues: [
        {
          code: "invalid_normalized_usage",
          message: "The normalized usage envelope does not satisfy the public contract",
        },
      ],
    };
  const data = envelope.data;
  const issues = [...data.issues];
  const tokenResult = data.tokens === null ? null : tokensSchema.safeParse(data.tokens);
  const tokens = tokenResult === null ? null : tokenResult.success ? tokenResult.data : unknownTokens();
  if (tokenResult && !tokenResult.success)
    issues.push({ code: "invalid_token_count", message: "Invalid canonical token fields" });
  const measurements = data.measurements.map((measurement, index) => {
    const parsed = measurementSchema.safeParse(measurement);
    if (parsed.success) return parsed.data;
    issues.push({
      code: "invalid_measurement",
      path: `measurements.${index}`,
      message: "Invalid measurement fields or decimal quantity",
    });
    const identity = z.object({ id: labelSchema, meter: labelSchema, unit: labelSchema }).safeParse(measurement);
    return {
      id: identity.success ? identity.data.id : `invalid:${index}`,
      meter: identity.success ? identity.data.meter : "usage.invalid",
      unit: identity.success ? identity.data.unit : "unknown",
      quantity: null,
      dimensions: {},
      source: "derived" as const,
      evidencePaths: [],
    };
  });
  const measurementIds = new Set<string>();
  for (const measurement of measurements) {
    if (measurementIds.has(measurement.id))
      issues.push({
        code: "invalid_measurement_duplicate",
        path: measurement.id,
        message: "Measurement IDs must be unique within a usage revision",
      });
    measurementIds.add(measurement.id);
  }
  const contextResult = contextSchema.safeParse(data.context ?? {});
  if (!contextResult.success)
    issues.push({
      code: "invalid_billing_context",
      message: "Billing metadata does not satisfy the safe context contract",
    });
  if (tokens) validateCanonicalTokens(tokens, issues);
  const evidence = retainRawUsage(data.rawUsage);
  return {
    schemaVersion: 1,
    normalizerId: data.normalizerId,
    normalizerVersion: data.normalizerVersion,
    tokens,
    measurements,
    coverage: data.coverage,
    issues,
    ...evidence,
    rawUsageTruncated: evidence.rawUsageTruncated || data.rawUsageTruncated,
    ...(contextResult.success ? { context: contextResult.data } : {}),
  };
}
