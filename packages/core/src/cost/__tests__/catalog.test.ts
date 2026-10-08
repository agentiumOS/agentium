import { describe, expect, it } from "vitest";
import { resolvePriceRule, validateCatalog } from "../catalog.js";
import { REVIEWED_PRICING_CATALOG } from "../catalog-data/reviewed.js";
import { fixtureCatalog, fixtureContext, fixtureRule, fixtureUsage } from "./fixtures.js";

const measurement = fixtureUsage().measurements[0];
describe("versioned catalog", () => {
  it("validates the bundled reviewed subset", () =>
    expect(() => validateCatalog(REVIEWED_PRICING_CATALOG)).not.toThrow());
  it("matches exact models only", () => {
    const catalog = fixtureCatalog();
    expect(resolvePriceRule(catalog, { ...fixtureContext, modelId: "prefix-fixture-model" }, measurement)).toEqual({
      reason: "missing_rate",
    });
    expect(resolvePriceRule(catalog, { ...fixtureContext, modelId: "o3-mini-2025" }, measurement)).toEqual({
      reason: "missing_rate",
    });
  });
  it("rejects overlapping rules and ambiguous aliases", () => {
    const catalog = fixtureCatalog();
    catalog.rules.push({ ...catalog.rules[0], id: "overlap" });
    expect(() => validateCatalog(catalog)).toThrow("Overlapping");
    catalog.rules.pop();
    catalog.aliases = [
      { providerId: "fixture", billingProviderId: "fixture", api: "fixture-v1", from: "alias", to: "fixture-model" },
      { providerId: "fixture", billingProviderId: "fixture", api: "fixture-v1", from: "alias", to: "fixture-model" },
    ];
    expect(() => validateCatalog(catalog)).toThrow("Ambiguous");
  });
  it("gives explicit contract overrides precedence", () => {
    const catalog = fixtureCatalog();
    catalog.rules.push(
      fixtureRule("token.input", "5", {
        id: "contract",
        precedence: "contract",
        match: { ...catalog.rules[0].match, contractId: "private" },
      }),
    );
    expect(resolvePriceRule(catalog, { ...fixtureContext, contractId: "private" }, measurement)).toHaveProperty(
      "rule.id",
      "contract",
    );
  });
  it("selects returned standard for a downgraded Fast request", () => {
    const context = {
      ...fixtureContext,
      providerId: "openai",
      billingProviderId: "openai",
      modelId: "gpt-6.1-sol",
      api: "responses",
      requestedServiceTier: "priority",
      actualServiceTier: "default",
      region: "global",
      dimensions: { modality: "text" },
    };
    expect(resolvePriceRule(REVIEWED_PRICING_CATALOG, context, measurement)).toHaveProperty("rule.rate.amount", "2");
    expect(
      resolvePriceRule(REVIEWED_PRICING_CATALOG, { ...context, actualServiceTier: undefined }, measurement),
    ).toEqual({ reason: "missing_context" });
  });
  it("uses whole request context threshold without a Pro multiplier", () => {
    const context = {
      ...fixtureContext,
      providerId: "openai",
      billingProviderId: "openai",
      modelId: "gpt-6.1-sol",
      api: "responses",
      actualServiceTier: "standard",
      reasoningMode: "pro",
      dimensions: { modality: "text" },
    };
    expect(resolvePriceRule(REVIEWED_PRICING_CATALOG, { ...context, inputTokens: 272000 }, measurement)).toHaveProperty(
      "rule.rate.amount",
      "2",
    );
    expect(resolvePriceRule(REVIEWED_PRICING_CATALOG, { ...context, inputTokens: 272001 }, measurement)).toHaveProperty(
      "rule.rate.amount",
      "4",
    );
  });
  it("does not backdate source retrieval or price a stale catalog", () => {
    expect(
      resolvePriceRule(fixtureCatalog(), { ...fixtureContext, occurredAt: "2026-10-07T00:00:00.000Z" }, measurement),
    ).toEqual({ reason: "historical_rate_unknown" });
    expect(
      resolvePriceRule({ ...fixtureCatalog(), validUntil: "2026-10-08T00:00:00.000Z" }, fixtureContext, measurement),
    ).toEqual({ reason: "stale_catalog" });
  });
  it("rejects identity injection from dimensions, including absent optional fields", () => {
    expect(() =>
      resolvePriceRule(fixtureCatalog(), fixtureContext, { ...measurement, dimensions: { modelId: "other" } }),
    ).toThrow("collides");
    expect(() =>
      resolvePriceRule(fixtureCatalog(), fixtureContext, { ...measurement, dimensions: { contractId: "private" } }),
    ).toThrow("collides");
  });
  it("keeps currencies and units separate", () => {
    expect(resolvePriceRule(fixtureCatalog(), fixtureContext, measurement, "EUR")).toEqual({ reason: "missing_rate" });
    expect(resolvePriceRule(fixtureCatalog(), fixtureContext, { ...measurement, unit: "second" })).toEqual({
      reason: "unit_mismatch",
    });
  });
});
