import type { PriceRule, PricingCatalog } from "../accounting-types.js";
import { Decimal } from "../decimal.js";

const verifiedAt = "2026-10-08T00:00:00.000Z";
const tokenMeters = ["token.input", "token.cache_read", "token.cache_write", "token.output"] as const;
type TokenRates = readonly [string, string, string, string];
const rules: PriceRule[] = [];
const invariantDimensions = { reasoningMode: "*", reasoningEffort: "*", contractId: "*" };

function addTokenRules(
  id: string,
  match: PriceRule["match"],
  rates: TokenRates,
  sourceUrl: string,
  options: Pick<PriceRule, "contextBand" | "effectiveUntil"> = {},
) {
  for (const [index, meter] of tokenMeters.entries())
    rules.push({
      id: `${id}:${meter}`,
      version: "1",
      meter,
      unit: "token",
      currency: "USD",
      match: { ...invariantDimensions, ...match },
      sourceUrl,
      verifiedAt,
      rate: { kind: "unit", amount: rates[index], per: "1000000" },
      ...options,
    });
}

const openAITiers = [
  { names: ["default", "standard"], multiplier: "1" },
  { names: ["priority", "fast"], multiplier: "2" },
  { names: ["flex", "batch"], multiplier: "0.5" },
];
function openAI(modelId: string, rates: TokenRates, tiers = openAITiers) {
  for (const tier of tiers)
    for (const long of [false, true])
      for (const regional of [false, true]) {
        if (regional && tier.names.includes("ultrafast")) continue;
        const adjusted = (index: number) =>
          Decimal.from(rates[index])
            .multiply(Decimal.from(tier.multiplier))
            .multiply(Decimal.from(long ? (index === 3 ? "1.5" : "2") : "1"))
            .multiply(Decimal.from(regional ? "1.1" : "1"))
            .toString();
        addTokenRules(
          `openai:${modelId}:${tier.names[0]}:${long}:${regional}`,
          {
            providerId: "openai",
            billingProviderId: "openai",
            modelId,
            api: ["responses", "chat-completions"],
            actualServiceTier: tier.names,
            region: regional ? "us" : "global",
            modality: "*",
          },
          [adjusted(0), adjusted(1), adjusted(2), adjusted(3)],
          tier.names.includes("ultrafast")
            ? "https://developers.openai.com/api/docs/pricing?latest-pricing=ultrafast"
            : `https://developers.openai.com/api/docs/models/${modelId}`,
          { contextBand: { field: "inputTokens", ...(long ? { above: 272000 } : { upTo: 272000 }) } },
        );
      }
}
openAI("gpt-6.1-sol", ["2", "0.1", "2.5", "10"]);
openAI("gpt-6-astra", ["10", "1", "12.5", "50"], [...openAITiers, { names: ["ultrafast"], multiplier: "6" }]);
openAI("gpt-6-luna", ["0.1", "0.01", "0.125", "0.5"]);

// Decisions has an endpoint-specific input-only contract, independent of generation tier prices.
for (const long of [false, true])
  for (const regional of [false, true]) {
    const rate = Decimal.from("0.1")
      .multiply(Decimal.from(long ? "2" : "1"))
      .multiply(Decimal.from(regional ? "1.1" : "1"))
      .toString();
    addTokenRules(
      `decisions:gpt-6-luna:${long}:${regional}`,
      {
        providerId: "openai-decisions",
        billingProviderId: "openai",
        modelId: "gpt-6-luna",
        api: "decisions",
        actualServiceTier: "*",
        region: regional ? "us" : "global",
        modality: "*",
      },
      [rate, "0", "0", "0"],
      "https://developers.openai.com/api/docs/guides/decisions#pricing-and-availability",
      { contextBand: { field: "inputTokens", ...(long ? { above: 272000 } : { upTo: 272000 }) } },
    );
  }

interface ClaudeRates {
  modelId: string;
  rates: readonly [string, string, string, string, string];
  us: boolean;
  above?: number;
  upTo?: number;
  speed?: string;
}
const claudeRows: ClaudeRates[] = [
  { modelId: "claude-sonnet-4-6", rates: ["3", "0.3", "3.75", "6", "15"], us: true },
  { modelId: "claude-opus-4-6", rates: ["5", "0.5", "6.25", "10", "25"], us: true },
  { modelId: "claude-haiku-4-5", rates: ["1", "0.1", "1.25", "2", "5"], us: false },
  { modelId: "claude-sonnet-5-5", rates: ["2", "0.1", "2.5", "4", "10"], us: true },
  { modelId: "claude-opus-5-5", rates: ["4", "0.2", "5", "8", "20"], us: true },
  { modelId: "claude-fable-5-1", rates: ["10", "0.25", "12.5", "20", "50"], us: true },
  { modelId: "claude-haiku-5-5", rates: ["0.1", "0.01", "0.125", "0.2", "0.5"], us: true, upTo: 100000 },
  { modelId: "claude-haiku-5-5", rates: ["0.5", "0.05", "0.625", "1", "2.5"], us: true, above: 100000 },
  { modelId: "claude-opus-5-5", rates: ["8", "0.4", "10", "16", "40"], us: true, speed: "fast" },
];
for (const row of claudeRows)
  for (const regional of row.us ? [false, true] : [false]) {
    const entries = [
      { meter: "token.input", amount: row.rates[0] },
      { meter: "token.cache_read", amount: row.rates[1] },
      { meter: "token.cache_write", amount: row.rates[2], ttl: "300" },
      { meter: "token.cache_write", amount: row.rates[3], ttl: "3600" },
      { meter: "token.cache_write", amount: "0", ttl: "none" },
      { meter: "token.output", amount: row.rates[4] },
    ];
    for (const entry of entries)
      rules.push({
        id: `anthropic:${row.modelId}:${row.speed ?? "standard"}:${row.above ?? "short"}:${regional}:${entry.meter}:${entry.ttl ?? "none"}`,
        version: "1",
        meter: entry.meter,
        unit: "token",
        currency: "USD",
        match: {
          ...invariantDimensions,
          providerId: "anthropic",
          billingProviderId: "anthropic",
          modelId: row.modelId,
          api: "messages",
          actualServiceTier: "standard",
          region: regional ? "us" : "global",
          modality: "*",
          speed: row.speed ?? "standard",
          ...(entry.ttl ? { ttlSeconds: entry.ttl } : {}),
        },
        ...(row.above !== undefined || row.upTo !== undefined
          ? { contextBand: { field: "inputTokens" as const, above: row.above, upTo: row.upTo } }
          : {}),
        sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
        verifiedAt,
        rate: {
          kind: "unit",
          amount: Decimal.from(entry.amount)
            .multiply(Decimal.from(regional ? "1.1" : "1"))
            .toString(),
          per: "1000000",
        },
      });
  }

interface GoogleRates {
  modelId: string;
  rates: TokenRates;
  above?: number;
  upTo?: number;
  effectiveUntil?: string;
}
const googleRows: GoogleRates[] = [
  { modelId: "gemini-2.5-flash", rates: ["0.3", "0.03", "0", "2.5"] },
  { modelId: "gemini-2.5-pro", rates: ["1.25", "0.125", "0", "10"], upTo: 200000 },
  { modelId: "gemini-2.5-pro", rates: ["2.5", "0.25", "0", "15"], above: 200000 },
  { modelId: "gemini-3.5-flash", rates: ["1.5", "0.15", "0", "9"] },
  { modelId: "gemini-3.8-flash", rates: ["0.75", "0.075", "0", "3.75"], effectiveUntil: "2027-01-01T00:00:00.000Z" },
];
for (const row of googleRows)
  addTokenRules(
    `google:${row.modelId}:${row.above ?? "short"}`,
    {
      providerId: "google",
      billingProviderId: "google",
      modelId: row.modelId,
      api: "generate-content",
      actualServiceTier: "standard",
      region: "global",
      modality: "text",
      pricePlan: "paid",
    },
    row.rates,
    "https://ai.google.dev/gemini-api/docs/pricing",
    {
      ...(row.above !== undefined || row.upTo !== undefined
        ? { contextBand: { field: "inputTokens", above: row.above, upTo: row.upTo } }
        : {}),
      ...(row.effectiveUntil ? { effectiveUntil: row.effectiveUntil } : {}),
    },
  );

// Exact first-party contracts only. Compatible gateways and partner deployments require their own tariffs.
for (const long of [false, true])
  addTokenRules(
    `xai:grok-4.6:${long}`,
    {
      providerId: "xai",
      billingProviderId: "xai",
      modelId: "grok-4.6",
      api: ["chat-completions", "responses"],
      actualServiceTier: ["default", "standard"],
      region: "global",
      modality: "*",
    },
    long ? ["4", "1", "0", "12"] : ["2", "0.5", "0", "6"],
    "https://docs.x.ai/developers/pricing",
    { contextBand: { field: "inputTokens", ...(long ? { above: 199999 } : { upTo: 199999 }) } },
  );
addTokenRules(
  "cohere:command-a-03-2025",
  {
    providerId: "cohere",
    billingProviderId: "cohere",
    modelId: "command-a-03-2025",
    api: "chat-v2",
    actualServiceTier: "standard",
    region: "global",
    modality: "text",
    pricePlan: "paid",
  },
  ["2.5", "0", "0", "10"],
  "https://docs.cohere.com/docs/command-a",
);
addTokenRules(
  "mistral:mistral-small-2603",
  {
    providerId: "mistral",
    billingProviderId: "mistral",
    modelId: "mistral-small-2603",
    api: "chat-completions",
    actualServiceTier: "standard",
    region: "global",
    modality: "*",
    pricePlan: "paid",
  },
  ["0.15", "0.015", "0", "0.6"],
  "https://docs.mistral.ai/getting-started/models/compare?models=mistral-small-4-0-26-03",
);

/** Reviewed subset, never a promise to price unknown models, accounts, or future billing features. */
export const REVIEWED_PRICING_CATALOG: PricingCatalog = {
  id: "agentium-reviewed",
  version: "2026-10-08.2",
  validUntil: "2026-11-08T00:00:00.000Z",
  rules,
};
