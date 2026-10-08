import type { CanonicalTokens, Measurement, NormalizationIssue } from "./accounting-types.js";

export const TOKEN_METERS = ["token.input", "token.cache_read", "token.cache_write", "token.output"] as const;

/** Emit disjoint billable categories. Reasoning remains an output subset. */
export function tokenMeasurements(tokens: CanonicalTokens, issues: NormalizationIssue[] = []): Measurement[] {
  const create = (meter: string, quantity: number | null, dimensions: Record<string, string> = {}): Measurement => ({
    id: `${meter}${dimensions.ttlSeconds ? `:${dimensions.ttlSeconds}` : ""}`,
    meter,
    unit: "token",
    quantity: quantity === null ? null : String(quantity),
    dimensions,
    source: "derived",
    evidencePaths: [
      {
        "token.input": "input.ordinary",
        "token.cache_read": "input.cacheRead",
        "token.cache_write": dimensions.ttlSeconds ? "input.cacheWriteByTTL" : "input.cacheWrite",
        "token.output": "output.total",
      }[meter] ?? meter,
    ],
  });
  const writes = tokens.input.cacheWriteByTTL;
  const validPartition = writes.length > 0 && !issues.some((issue) => issue.code === "cache_ttl_partition_mismatch");
  return [
    create("token.input", tokens.input.ordinary),
    create("token.cache_read", tokens.input.cacheRead),
    ...(validPartition
      ? writes.map((bucket) => create("token.cache_write", bucket.tokens, { ttlSeconds: String(bucket.ttlSeconds) }))
      : [create("token.cache_write", tokens.input.cacheWrite)]),
    create("token.output", tokens.output.total),
  ];
}
