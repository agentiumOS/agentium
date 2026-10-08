import { describe, expect, it } from "vitest";
import { USAGE_FIXTURES } from "../../models/__tests__/fixtures/usage-fixtures.js";
import { normalizeProviderUsage } from "../../models/usage-normalizers.js";
import { retainRawUsage, validateNormalizedUsage } from "../usage.js";

describe("usage validation", () => {
  it("rejects a forged canonical total even when provider total repeats it", () => {
    const usage = normalizeProviderUsage("openai", "responses", {
      input_tokens: 19,
      output_tokens: 16,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    });
    if (usage.tokens) {
      usage.tokens.total = 44;
      usage.tokens.providerReportedTotal = 44;
    }
    const result = validateNormalizedUsage(usage);
    expect(result.issues.map((issue) => issue.code)).toContain("canonical_total_mismatch");
    expect(usage.tokens?.output.reasoning).toBeNull();
  });
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "19"])(
    "rejects invalid count %s",
    (value) => {
      const usage = normalizeProviderUsage("openai", "responses", {
        ...USAGE_FIXTURES.openai.raw,
        input_tokens: value,
      });
      expect(usage.tokens?.input.total).toBeNull();
      expect(usage.issues.map((issue) => issue.code)).toContain("invalid_token_count");
    },
  );
  it("preserves proven zero and unknown separately", () => {
    const usage = normalizeProviderUsage("openai", "responses", {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    });
    expect(usage.tokens?.input).toMatchObject({ total: 0, ordinary: 0, cacheRead: 0, cacheWrite: 0 });
    expect(normalizeProviderUsage("openai", "responses", undefined).tokens?.total).toBeNull();
  });
  it("rejects cache subsets larger than input without clamping", () => {
    const usage = normalizeProviderUsage("openai", "responses", { ...USAGE_FIXTURES.openai.raw, input_tokens: 10 });
    expect(usage.tokens?.input.ordinary).toBeNull();
    expect(usage.tokens?.input.cacheRead).toBe(12000);
    expect(usage.issues.map((issue) => issue.code)).toContain("input_partition_mismatch");
  });
  it("flags incorrect TTL partitions and never charges both aggregate and buckets", () => {
    const usage = normalizeProviderUsage("anthropic", "messages", {
      ...USAGE_FIXTURES.anthropic.raw,
      cache_creation_input_tokens: 3000,
    });
    expect(usage.issues.map((issue) => issue.code)).toContain("cache_ttl_partition_mismatch");
    expect(usage.measurements.filter((item) => item.meter === "token.cache_write")).toHaveLength(1);
  });
  it("validates custom decimal quantities at runtime", () => {
    const usage = normalizeProviderUsage("openai", "responses", USAGE_FIXTURES.openai.raw);
    usage.measurements[0].quantity = "-0.1";
    const result = validateNormalizedUsage(usage);
    expect(result.measurements[0].quantity).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toContain("invalid_measurement");
  });
  it("validates custom canonical token values at runtime", () => {
    const usage = normalizeProviderUsage("openai", "responses", USAGE_FIXTURES.openai.raw);
    if (usage.tokens) usage.tokens.input.total = Number.POSITIVE_INFINITY;
    const result = validateNormalizedUsage(usage);
    expect(result.tokens?.input.total).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toContain("invalid_token_count");
  });
  it("bounds raw UTF8 JSON including keys and numeric values", () => {
    const huge = Object.fromEntries(Array.from({ length: 512 }, (_, index) => [`field_${index}`, "界".repeat(256)]));
    const result = retainRawUsage(huge);
    expect(Buffer.byteLength(JSON.stringify(result.rawUsage), "utf8")).toBeLessThanOrEqual(32768);
    expect(result.rawUsageTruncated).toBe(true);
  });
  it("omits huge keys and marks array truncation", () => {
    expect(retainRawUsage({ ["x".repeat(100000)]: 1 }).rawUsageTruncated).toBe(true);
    const result = retainRawUsage({ values: Array.from({ length: 129 }, () => 0) });
    expect(result.rawUsageTruncated).toBe(true);
  });
  it("redacts nested credentials even when names contain tokens", () => {
    const result = retainRawUsage({
      input_tokens: 1,
      nested: {
        authorization: "private",
        api_key_tokens: "private",
        messages: ["private"],
        prompt: "private",
        cache_tokens: 1,
      },
    });
    expect(JSON.stringify(result.rawUsage)).not.toContain("private");
    expect(result.rawUsage).toEqual({ input_tokens: 1, nested: { cache_tokens: 1 } });
    expect(result.rawUsageTruncated).toBe(true);
  });
  it("keeps evidence paths aligned with canonical fields", () => {
    const usage = normalizeProviderUsage("openai", "responses", USAGE_FIXTURES.openai.raw);
    expect(usage.measurements.map((value) => value.evidencePaths[0])).toEqual([
      "input.ordinary",
      "input.cacheRead",
      "input.cacheWrite",
      "output.total",
    ]);
  });
});
