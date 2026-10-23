import { describe, expect, it } from "vitest";
import { normalizeProviderUsage } from "../../models/usage-normalizers.js";
import type { BillingContext, NormalizedUsage, PricingCatalog } from "../accounting-types.js";
import { calculateCharges } from "../calculator.js";
import { resolvePriceRule } from "../catalog.js";
import { REVIEWED_PRICING_CATALOG } from "../catalog-data/reviewed.js";
import { fixtureContext, fixtureUsage } from "./fixtures.js";

const current = "2026-10-24T00:00:00.000Z";

function assess(usage: NormalizedUsage, extra: Partial<BillingContext> = {}) {
  return calculateCharges({
    usage,
    catalog: REVIEWED_PRICING_CATALOG,
    context: { ...fixtureContext, ...usage.context, ...extra },
  });
}
function rate(
  providerId: string,
  modelId: string,
  api: string,
  meter: string,
  extra: Partial<BillingContext> = {},
  dimensions: Record<string, string> = {},
  catalog: PricingCatalog = REVIEWED_PRICING_CATALOG,
) {
  const measurement = fixtureUsage().measurements[0];
  return resolvePriceRule(
    catalog,
    {
      ...fixtureContext,
      providerId,
      billingProviderId: providerId,
      modelId,
      api,
      dimensions: { modality: "text", pricePlan: "paid", speed: "standard" },
      ...extra,
    },
    { ...measurement, meter, dimensions },
  );
}

describe("reviewed current first-party tariffs", () => {
  it.each([
    ["openai", "gpt-6-luna", "responses", "token.input", "0.1"],
    ["openai", "gpt-6-luna", "responses", "token.cache_read", "0.01"],
    ["openai", "gpt-6-luna", "responses", "token.cache_write", "0.125"],
    ["anthropic", "claude-sonnet-5-5", "messages", "token.input", "2"],
    ["anthropic", "claude-opus-5-5", "messages", "token.output", "20"],
    ["anthropic", "claude-fable-5-1", "messages", "token.cache_read", "0.25"],
    ["google", "gemini-3.5-flash", "generate-content", "token.output", "9"],
    ["google", "gemini-3.8-flash", "generate-content", "token.input", "0.75"],
    ["google", "gemini-3.8-flash", "generate-content", "token.cache_read", "0.075"],
    ["cohere", "command-a-03-2025", "chat-v2", "token.input", "2.5"],
    ["mistral", "mistral-small-2603", "chat-completions", "token.cache_read", "0.015"],
  ])("matches exact %s %s %s %s", (provider, model, api, meter, amount) => {
    expect(rate(provider, model, api, meter)).toHaveProperty("rule.rate.amount", amount);
  });
  it("applies verified Fast, regional, and context factors once", () => {
    expect(
      rate("openai", "gpt-6-luna", "responses", "token.cache_write", {
        actualServiceTier: "fast",
        region: "us",
        inputTokens: 272001,
      }),
    ).toHaveProperty("rule.rate.amount", "0.55");
    expect(
      rate("openai", "gpt-6-astra", "responses", "token.output", {
        actualServiceTier: "ultrafast",
        inputTokens: 272001,
      }),
    ).toHaveProperty("rule.rate.amount", "450");
    expect(rate("openai", "gpt-6-astra", "responses", "token.input", { actualServiceTier: "batch" })).toHaveProperty(
      "rule.rate.amount",
      "5",
    );
  });
  it("uses Haiku and xAI inclusive input thresholds at exact boundaries", () => {
    expect(rate("anthropic", "claude-haiku-5-5", "messages", "token.input", { inputTokens: 100000 })).toHaveProperty(
      "rule.rate.amount",
      "0.1",
    );
    expect(rate("anthropic", "claude-haiku-5-5", "messages", "token.input", { inputTokens: 100001 })).toHaveProperty(
      "rule.rate.amount",
      "0.5",
    );
    expect(rate("xai", "grok-4.6", "chat-completions", "token.input", { inputTokens: 199999 })).toHaveProperty(
      "rule.rate.amount",
      "2",
    );
    expect(rate("xai", "grok-4.6", "chat-completions", "token.input", { inputTokens: 200000 })).toHaveProperty(
      "rule.rate.amount",
      "4",
    );
  });
  it("keeps Anthropic TTL prices distinct and removes unsupported old-model US pricing", () => {
    expect(
      rate("anthropic", "claude-sonnet-5-5", "messages", "token.cache_write", {}, { ttlSeconds: "300" }),
    ).toHaveProperty("rule.rate.amount", "2.5");
    expect(
      rate("anthropic", "claude-sonnet-5-5", "messages", "token.cache_write", {}, { ttlSeconds: "3600" }),
    ).toHaveProperty("rule.rate.amount", "4");
    expect(rate("anthropic", "claude-haiku-4-5", "messages", "token.input", { region: "us" })).toEqual({
      reason: "missing_rate",
    });
  });
  it("prices an actual Opus Fast response separately from ordinary service tier", () => {
    const usage = normalizeProviderUsage(
      "anthropic",
      "messages",
      { input_tokens: 1000, output_tokens: 100, service_tier: "standard", speed: "fast" },
      { modelId: "claude-opus-5-5" },
    );
    expect(assess(usage).total).toBe("0.012");
    expect(assess(usage, { actualServiceTier: "batch" }).total).toBeNull();
  });
  it("charges Decisions GA cache partitions once while retaining inclusive statistics", () => {
    const usage = normalizeProviderUsage(
      "openai-decisions",
      "decisions",
      {
        input_tokens: 1000,
        output_tokens: 50,
        total_tokens: 1050,
        input_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 },
      },
      { modelId: "gpt-6-luna", region: "global" },
    );
    expect(usage.tokens?.input).toMatchObject({ total: 1000, ordinary: 100, cacheRead: 800, cacheWrite: 100 });
    expect(usage.measurements.map((measurement) => measurement.quantity)).toEqual(["100", "800", "100", "0"]);
    expect(assess(usage, { actualServiceTier: undefined, occurredAt: current }).total).toBe("0.0000305");
    expect(
      assess(
        normalizeProviderUsage(
          "openai-decisions",
          "decisions",
          { input_tokens: 1000 },
          { modelId: "gpt-6-luna", region: "global" },
        ),
        { occurredAt: current },
      ).total,
    ).toBeNull();
    expect(assess(usage, { billingProviderId: "unknown" }).total).toBeNull();
    expect(assess(usage).total).toBeNull();
  });
  it.each(["us", "eu"])("applies Decisions long-input and %s regional factors once", (region) => {
    const usage = normalizeProviderUsage(
      "openai-decisions",
      "decisions",
      {
        input_tokens: 272001,
        output_tokens: 50,
        total_tokens: 272051,
        input_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 },
      },
      { modelId: "gpt-6-luna", region },
    );
    expect(assess(usage, { occurredAt: current }).total).toBe("0.05968732");
  });
  it.each([
    ["global", 272000, "token.input", "12"],
    ["global", 272000, "token.output", "60"],
    ["us", 272001, "token.input", "26.4"],
    ["us", 272001, "token.output", "99"],
    ["eu", 272000, "token.cache_read", "0.66"],
    ["eu", 272001, "token.cache_write", "33"],
  ])("prices Sol Ultrafast in %s at %s input tokens for %s", (region, inputTokens, meter, amount) => {
    expect(
      rate("openai", "gpt-6.1-sol", "responses", meter, {
        actualServiceTier: "ultrafast",
        region,
        inputTokens: Number(inputTokens),
        occurredAt: current,
      }),
    ).toHaveProperty("rule.rate.amount", amount);
  });
  it("keeps Ultrafast endpoints and other model regions scoped", () => {
    expect(
      rate("openai", "gpt-6.1-sol", "chat-completions", "token.input", {
        actualServiceTier: "ultrafast",
        occurredAt: current,
      }),
    ).toEqual({ reason: "missing_rate" });
    expect(
      rate("openai", "gpt-6-astra", "responses", "token.input", {
        actualServiceTier: "ultrafast",
        region: "us",
        occurredAt: current,
      }),
    ).toEqual({ reason: "missing_rate" });
    expect(rate("openai", "gpt-6.1-sol", "responses", "token.input", { inputTokens: 272000 })).toHaveProperty(
      "rule.rate.amount",
      "2",
    );
    expect(rate("openai", "gpt-6.1-sol", "responses", "token.input", { inputTokens: 272001 })).toHaveProperty(
      "rule.rate.amount",
      "4",
    );
  });
  it.each([
    ["token.input", "2", "4"],
    ["token.cache_read", "0.1", "0.2"],
    ["token.output", "10", "20"],
  ])("bounds Argon %s prices around the date-only transition", (meter, introductory, regular) => {
    const extended = { ...REVIEWED_PRICING_CATALOG, validUntil: "2027-01-01T00:00:00.000Z" };
    const selected = rate("google", "gemini-4-argon", "generate-content", meter, { occurredAt: current });
    expect(selected).toHaveProperty("rule.rate.amount", introductory);
    expect(selected).toHaveProperty("rule.effectiveFrom", "2026-10-23T21:42:29.000Z");
    expect(selected).toHaveProperty("rule.effectiveUntil", "2026-11-30T10:00:00.000Z");
    for (const occurredAt of ["2026-11-30T10:00:00.000Z", "2026-12-01T11:59:59.999Z"])
      expect(rate("google", "gemini-4-argon", "generate-content", meter, { occurredAt }, {}, extended)).toEqual({
        reason: "missing_rate",
      });
    expect(
      rate(
        "google",
        "gemini-4-argon",
        "generate-content",
        meter,
        { occurredAt: "2026-12-01T12:00:00.000Z" },
        {},
        extended,
      ),
    ).toHaveProperty("rule.rate.amount", regular);
    expect(
      rate("google", "gemini-4-argon", "generate-content", meter, { occurredAt: "2026-12-01T12:00:00.000Z" }),
    ).toEqual({ reason: "stale_catalog" });
  });
  it("prices Argon ordinary usage without inventing a free cache-write product", () => {
    const usage = normalizeProviderUsage(
      "google",
      "generate-content",
      { promptTokenCount: 1000, cachedContentTokenCount: 800, candidatesTokenCount: 100, thoughtsTokenCount: 20 },
      { modelId: "gemini-4-argon" },
    );
    const context = { occurredAt: current, dimensions: { pricePlan: "paid", modality: "text" } };
    expect(assess(usage, context).total).toBe("0.00168");
    const withWrite = {
      ...usage,
      measurements: [
        ...usage.measurements.filter((measurement) => measurement.meter !== "token.cache_write"),
        {
          id: "write",
          meter: "token.cache_write",
          unit: "token",
          quantity: "10",
          dimensions: {},
          source: "provider" as const,
          evidencePaths: ["cacheWriteTokenCount"],
        },
      ],
    };
    expect(assess(withWrite, context).total).toBeNull();
    expect(rate("google", "gemini-4-argon", "generate-content", "token.cache_write", { occurredAt: current })).toEqual({
      reason: "missing_rate",
    });
    expect(rate("google", "gemini-4-argon", "interactions", "token.input", { occurredAt: current })).toEqual({
      reason: "missing_rate",
    });
    expect(
      rate("google", "gemini-4-argon", "generate-content", "token.input", {
        occurredAt: current,
        actualServiceTier: "priority",
      }),
    ).toEqual({ reason: "missing_rate" });
    expect(
      assess(
        normalizeProviderUsage(
          "google",
          "generate-content",
          { promptTokenCount: 1000, candidatesTokenCount: 100, cacheWriteTokenCount: 10 },
          { modelId: "gemini-4-argon" },
        ),
        context,
      ).total,
    ).toBeNull();
  });
  it("prices documented native xAI reasoning and Mistral cache semantics completely", () => {
    const xai = normalizeProviderUsage(
      "xai",
      "chat-completions",
      {
        prompt_tokens: 32,
        completion_tokens: 9,
        total_tokens: 135,
        prompt_tokens_details: { cached_tokens: 6 },
        completion_tokens_details: { reasoning_tokens: 94 },
        num_sources_used: 0,
      },
      { modelId: "grok-4.6" },
    );
    expect(assess(xai).total).toBe("0.000673");
    const mistral = normalizeProviderUsage(
      "mistral",
      "chat-completions",
      { promptTokens: 1013, completionTokens: 30, totalTokens: 1043, promptTokensDetails: { cachedTokens: 1008 } },
      { modelId: "mistral-small-2603" },
    );
    expect(assess(mistral, { dimensions: { pricePlan: "paid" } }).total).toBe("0.00003387");
  });
  it("prices Cohere billed units instead of token statistics", () => {
    const usage = normalizeProviderUsage(
      "cohere",
      "chat-v2",
      { tokens: { input_tokens: 71, output_tokens: 20 }, billed_units: { input_tokens: 5, output_tokens: 10 } },
      { modelId: "command-a-03-2025" },
    );
    expect(assess(usage, { dimensions: { pricePlan: "paid", modality: "text" } }).total).toBe("0.0001125");
  });
  it("requires paid account and text evidence for Google and preserves the announced expiry", () => {
    expect(
      rate("google", "gemini-3.8-flash", "generate-content", "token.input", { dimensions: { modality: "text" } }),
    ).toEqual({ reason: "missing_context" });
    expect(
      rate("google", "gemini-3.8-flash", "generate-content", "token.input", {
        dimensions: { modality: "text", pricePlan: "free" },
      }),
    ).toEqual({ reason: "missing_rate" });
    const selected = rate("google", "gemini-3.8-flash", "generate-content", "token.input");
    expect(selected).toHaveProperty("rule.effectiveUntil", "2027-01-01T00:00:00.000Z");
  });
  it("excludes unknown modality/cache cells from the known subtotal", () => {
    const usage = normalizeProviderUsage(
      "openai",
      "responses",
      {
        input_tokens: 1000,
        output_tokens: 100,
        input_tokens_details: { cached_tokens: 800, cache_write_tokens: 0, audio_tokens: 400 },
      },
      { modelId: "gpt-6.1-sol" },
    );
    const result = assess(usage);
    expect(result.total).toBeNull();
    expect(result.knownSubtotal).toBe("0.001");
    expect(
      result.charges.filter((charge) => charge.meter !== "token.output").every((charge) => charge.amount === null),
    ).toBe(true);
    const google = normalizeProviderUsage(
      "google",
      "generate-content",
      {
        promptTokenCount: 1000,
        cachedContentTokenCount: 800,
        candidatesTokenCount: 100,
        thoughtsTokenCount: 0,
        promptTokensDetails: [{ modality: "AUDIO", tokenCount: 400 }],
      },
      { modelId: "gemini-2.5-flash" },
    );
    const googleResult = assess(google, { dimensions: { pricePlan: "paid", modality: "text" } });
    expect(googleResult.total).toBeNull();
    expect(googleResult.knownSubtotal).toBe("0.00025");
  });
});
