import { describe, expect, it } from "vitest";
import { configuredBillingContext, mergeBillingContext } from "../billing-context.js";

describe("trusted model billing context", () => {
  it("validates billing defaults and records configured contract provenance", () => {
    expect(
      configuredBillingContext({
        accountId: "paid-account",
        contractId: "standard-contract",
        region: "global",
        actualServiceTier: "standard",
        dimensions: { pricePlan: "paid" },
      }),
    ).toEqual({
      accountId: "paid-account",
      contractId: "standard-contract",
      region: "global",
      actualServiceTier: "standard",
      dimensions: { pricePlan: "paid" },
      provenance: {
        accountId: "configured_contract",
        contractId: "configured_contract",
        region: "configured_contract",
        actualServiceTier: "configured_contract",
        pricePlan: "configured_contract",
      },
    });
    expect(configuredBillingContext()).toEqual({});
  });
  it.each(["providerId", "billingProviderId", "modelId", "api", "occurredAt", "providerRequestId", "inputTokens"])(
    "rejects forged %s",
    (key) => {
      expect(() => configuredBillingContext(Object.assign({ region: "global" }, { [key]: "forged" }))).toThrow(
        "Invalid model billingContext",
      );
      expect(() => configuredBillingContext({ dimensions: { [key]: "forged" } })).toThrow(
        "Invalid model billingContext",
      );
    },
  );
  it("bounds metadata and rejects endpoint contract overrides", () => {
    expect(() => configuredBillingContext({ region: "x".repeat(513) })).toThrow();
    expect(() => configuredBillingContext({ dimensions: { endpointContract: "known" } })).toThrow();
  });
  it("lets returned facts win and retains unrelated configured dimensions", () => {
    const configured = configuredBillingContext({
      region: "us",
      actualServiceTier: "fast",
      dimensions: { pricePlan: "paid", modality: "text" },
    });
    const actual = mergeBillingContext(configured, {
      modelId: "returned-model",
      region: "global",
      actualServiceTier: "standard",
      dimensions: { modality: "audio" },
      provenance: { modelId: "response", region: "response", actualServiceTier: "response", modality: "response" },
    });
    expect(actual).toMatchObject({
      modelId: "returned-model",
      region: "global",
      actualServiceTier: "standard",
      dimensions: { pricePlan: "paid", modality: "audio" },
    });
    expect(actual.provenance).toMatchObject({
      pricePlan: "configured_contract",
      region: "response",
      actualServiceTier: "response",
    });
  });
  it("lets explicit configured facts override documented defaults only", () => {
    const configured = configuredBillingContext({ region: "us", dimensions: { speed: "fast" } });
    expect(
      mergeBillingContext(configured, {
        region: "global",
        dimensions: { speed: "standard" },
        provenance: { region: "documented_default", speed: "documented_default" },
      }),
    ).toMatchObject({
      region: "us",
      dimensions: { speed: "fast" },
      provenance: { region: "configured_contract", speed: "configured_contract" },
    });
    expect(mergeBillingContext(configured, { region: "eu", provenance: { region: "request" } })).toMatchObject({
      region: "eu",
      provenance: { region: "request" },
    });
  });
  it("does not infer paid context or default service tier", () => {
    const observed = mergeBillingContext(configuredBillingContext(), {
      providerId: "google",
      dimensions: { modality: "text" },
    });
    expect(observed.actualServiceTier).toBeUndefined();
    expect(observed.region).toBeUndefined();
    expect(observed.dimensions).not.toHaveProperty("pricePlan");
  });
});
