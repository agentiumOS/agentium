import { z } from "zod";
import type { BillingContext } from "../cost/accounting-types.js";
import type { ModelBillingContext } from "./types.js";

const reservedDimensions = new Set([
  "providerId",
  "billingProviderId",
  "modelId",
  "requestedModelId",
  "api",
  "occurredAt",
  "providerRequestId",
  "resourceId",
  "accountId",
  "contractId",
  "region",
  "actualServiceTier",
  "requestedServiceTier",
  "reasoningMode",
  "reasoningEffort",
  "inputTokens",
  "dimensions",
  "provenance",
  "endpointContract",
]);
const label = z.string().min(1).max(512);
const billingDefaultsSchema = z
  .object({
    accountId: label.optional(),
    contractId: label.optional(),
    region: label.optional(),
    actualServiceTier: label.optional(),
    dimensions: z
      .record(z.string().min(1).max(256), label)
      .refine(
        (dimensions) =>
          Object.keys(dimensions).length <= 64 && Object.keys(dimensions).every((key) => !reservedDimensions.has(key)),
        "Billing dimensions must not override provider identity or billing context fields",
      )
      .optional(),
  })
  .strict();

/** Trusted host facts only; this metadata does not change the provider request or select its service tier. */
export function configuredBillingContext(value?: ModelBillingContext): Partial<BillingContext> {
  if (value === undefined) return {};
  const result = billingDefaultsSchema.safeParse(value);
  if (!result.success)
    throw new TypeError(
      `Invalid model billingContext: ${result.error.message}. Use only accountId, contractId, region, actualServiceTier, and billing dimensions. Provider identity belongs to the model adapter.`,
    );
  const configured = result.data;
  const fields = [
    ...Object.keys(configured).filter((key) => key !== "dimensions"),
    ...Object.keys(configured.dimensions ?? {}),
  ];
  return {
    ...configured,
    provenance: Object.fromEntries(fields.map((field) => [field, "configured_contract" as const])),
  };
}

/** Response/request evidence overrides configured facts; configured facts override documented defaults. */
export function mergeBillingContext(base: BillingContext, observed?: Partial<BillingContext>): BillingContext;
export function mergeBillingContext(
  base: Partial<BillingContext>,
  observed?: Partial<BillingContext>,
): Partial<BillingContext>;
export function mergeBillingContext(
  base: Partial<BillingContext>,
  observed: Partial<BillingContext> = {},
): Partial<BillingContext> {
  const entries = Object.entries(observed).filter(
    ([key, value]) =>
      value !== undefined &&
      key !== "dimensions" &&
      key !== "provenance" &&
      !(base.provenance?.[key] === "configured_contract" && observed.provenance?.[key] === "documented_default"),
  );
  const dimensions = { ...base.dimensions };
  for (const [key, value] of Object.entries(observed.dimensions ?? {})) {
    if (!(base.provenance?.[key] === "configured_contract" && observed.provenance?.[key] === "documented_default"))
      dimensions[key] = value;
  }
  const provenance = { ...base.provenance };
  for (const [key, source] of Object.entries(observed.provenance ?? {})) {
    if (!(provenance[key] === "configured_contract" && source === "documented_default")) provenance[key] = source;
  }
  return {
    ...base,
    ...Object.fromEntries(entries),
    ...(base.dimensions || observed.dimensions ? { dimensions } : {}),
    ...(base.provenance || observed.provenance ? { provenance } : {}),
  };
}
