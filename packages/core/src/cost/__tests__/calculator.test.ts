import { describe, expect, it } from "vitest";
import { allocateGroupAmount, calculateCharges } from "../calculator.js";
import { Decimal } from "../decimal.js";
import { fixtureCatalog, fixtureContext, fixtureRule, fixtureUsage } from "./fixtures.js";

function assess() {
  return { context: fixtureContext, usage: fixtureUsage(), catalog: fixtureCatalog(), assessmentId: "a" };
}
describe("exact cost calculator", () => {
  it("prices disjoint input/read/write/output and never bills reasoning twice", () => {
    const result = calculateCharges(assess());
    expect(result.total).toBe("0.072");
    expect(result.charges.map((c) => c.amount)).toEqual(["0.01", "0.012", "0.025", "0.025"]);
    expect(result.charges).toHaveLength(4);
  });
  it("keeps missing writes unpriced, distinct from a proven free write rate", () => {
    const input = assess();
    input.catalog.rules = input.catalog.rules.filter((r) => r.meter !== "token.cache_write");
    const partial = calculateCharges(input);
    expect(partial.total).toBeNull();
    expect(partial.knownSubtotal).toBe("0.047");
    input.catalog.rules.push(fixtureRule("token.cache_write", "0"));
    expect(calculateCharges(input).total).toBe("0.047");
  });
  it("does not add reasoning to the 19/16/9 OpenAI fixture", () => {
    const input = assess();
    input.usage.tokens = {
      input: { total: 19, ordinary: 19, cacheRead: 0, cacheWrite: 0, cacheWriteByTTL: [] },
      output: { total: 16, reasoning: 9 },
      total: 35,
      providerReportedTotal: 35,
    };
    input.usage.measurements = input.usage.measurements.map((m) => ({
      ...m,
      quantity: m.meter === "token.input" ? "19" : m.meter === "token.output" ? "16" : "0",
    }));
    const result = calculateCharges(input);
    expect(result.total).toBe("0.00099");
    expect(result.charges.filter((c) => c.meter === "token.output")).toHaveLength(1);
  });
  it("rejects malformed counts and conflicting subsets at the public boundary", () => {
    const input = assess();
    input.usage.tokens!.input.cacheRead = 20000;
    expect(calculateCharges(input).total).toBeNull();
    input.usage.tokens!.input.total = -2;
    expect(calculateCharges(input).total).toBeNull();
  });
  it("does not consider a known subtotal complete when required extra fees are unknown", () => {
    const input = assess();
    input.usage.coverage.requiredMeters.push("search.request");
    const result = calculateCharges(input);
    expect(result.knownSubtotal).toBe("0.072");
    expect(result.total).toBeNull();
    expect(result.charges.at(-1)?.reason).toBe("missing_usage");
  });
  it("prices TTL buckets instead of their parent count", () => {
    const input = assess();
    input.usage.tokens!.input.cacheWriteByTTL = [
      { ttlSeconds: 300, tokens: 1000 },
      { ttlSeconds: 3600, tokens: 1000 },
    ];
    input.usage.measurements = input.usage.measurements.filter((m) => m.meter !== "token.cache_write");
    for (const ttl of [300, 3600])
      input.usage.measurements.push({
        id: `write-${ttl}`,
        meter: "token.cache_write",
        unit: "token",
        quantity: "1000",
        dimensions: { ttlSeconds: String(ttl) },
        source: "provider",
        evidencePaths: [],
      });
    input.catalog.rules = input.catalog.rules.filter((r) => r.meter !== "token.cache_write");
    for (const [ttl, rate] of [
      ["300", "12.5"],
      ["3600", "20"],
    ]) {
      const rule = fixtureRule("token.cache_write", rate);
      input.catalog.rules.push({ ...rule, id: ttl, match: { ...rule.match, ttlSeconds: ttl } });
    }
    expect(calculateCharges(input).total).toBe("0.0795");
  });
  it("applies block minimums, fixed occurrences, marginal tiers and ordered adjustments", () => {
    const input = assess();
    input.usage.tokens = null;
    input.usage.coverage.requiredMeters = ["compute.second"];
    input.usage.measurements = [
      {
        id: "duration",
        meter: "compute.second",
        unit: "second",
        quantity: "20",
        dimensions: {},
        source: "provider",
        evidencePaths: [],
      },
    ];
    input.catalog.rules = [
      fixtureRule("compute.second", "0.01", {
        unit: "second",
        rounding: { increment: "60", mode: "ceil", minimum: "60" },
        rate: { kind: "unit", amount: "0.01", per: "60" },
      }),
    ];
    expect(calculateCharges(input).total).toBe("0.01");
    input.catalog.rules[0].rate = {
      kind: "tiered",
      tiers: [
        { upTo: "10", amount: "1", per: "1" },
        { upTo: null, amount: "2", per: "1" },
      ],
    };
    delete input.catalog.rules[0].rounding;
    expect(calculateCharges(input).total).toBe("30");
    input.catalog.rules[0].rate = { kind: "fixed", amount: "0.01" };
    input.catalog.rules[0].adjustments = [
      { id: "discount", kind: "multiply", amount: "0.5", sourceUrl: "https://example.com" },
      { id: "credit", kind: "add", amount: "-0.01", sourceUrl: "https://example.com" },
    ];
    expect(calculateCharges(input).total).toBe("0.09");
  });
  it("does not round a group minimum separately on each attempt", () => {
    const input = assess();
    input.usage.tokens = null;
    input.usage.coverage.requiredMeters = ["duration"];
    input.usage.measurements = [
      {
        id: "duration",
        meter: "duration",
        unit: "second",
        quantity: "40",
        dimensions: {},
        source: "provider",
        evidencePaths: [],
      },
    ];
    input.catalog.rules = [
      fixtureRule("duration", "0.01", {
        scope: "session",
        unit: "second",
        rate: { kind: "unit", amount: "0.01", per: "60" },
        rounding: { increment: "60", mode: "ceil" },
      }),
    ];
    expect(calculateCharges(input).charges[0].inclusion).toBe("contribution");
    expect(calculateCharges({ ...input, targetKind: "billing_group" }).total).toBe("0.01");
    expect(
      allocateGroupAmount("0.01", [
        { operationId: "a", weight: "20" },
        { operationId: "b", weight: "20" },
      ]),
    ).toEqual([
      { operationId: "a", amount: "0.005" },
      { operationId: "b", amount: "0.005" },
    ]);
  });
  it("keeps rational operations exact until the explicit 36-place half-up output", () => {
    expect(Decimal.from("0.1").add(Decimal.from("0.2")).toString()).toBe("0.3");
    expect(Decimal.from("1").divide(Decimal.from("3")).toString()).toBe("0.333333333333333333333333333333333333");
    expect(Decimal.from("-0.5").round(Decimal.from("1"), "half_up").toString()).toBe("-1");
  });
  it("retains complete rate and evidence snapshots", () => {
    const input = assess();
    const result = calculateCharges(input);
    input.catalog.rules[0].rate = { kind: "unit", amount: "999", per: "1" };
    expect(result.charges[0].rule?.rate).toEqual({ kind: "unit", amount: "10", per: "1000000" });
    expect(result.arithmeticPolicy).toBe("rational-36-half-up-v1");
  });
});
