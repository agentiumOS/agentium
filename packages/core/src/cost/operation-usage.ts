import type { Measurement, NormalizedUsage } from "./accounting-types.js";
import { readTokenCount, retainRawUsage } from "./usage.js";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

/** Provider-specific non-chat mappings; only usage metadata is retained. */
export function normalizeOperationUsage(
  provider: string,
  api: "embeddings" | "rerank" | "images",
  response: unknown,
  dimensions: Record<string, string> = {},
): NormalizedUsage {
  const data = object(response);
  const raw = api === "rerank" && provider === "cohere" ? object(data.meta) : object(data.usage ?? data.usageMetadata);
  const result: NormalizedUsage = {
    schemaVersion: 1,
    normalizerId: `${provider}.${api}`,
    normalizerVersion: "1",
    tokens: null,
    measurements: [],
    coverage: { requiredMeters: [], unsupportedFeatures: [] },
    issues: [],
    ...retainRawUsage(raw),
  };
  const add = (
    meter: string,
    unit: string,
    value: unknown,
    path: string,
    source: Measurement["source"] = "provider",
  ) => {
    const quantity = readTokenCount(value, path, result.issues);
    result.measurements.push({
      id: meter,
      meter,
      unit,
      quantity: quantity === null ? null : String(quantity),
      dimensions,
      source,
      evidencePaths: [path],
    });
    result.coverage.requiredMeters.push(meter);
  };
  if (api === "embeddings") {
    add(
      "token.input",
      "token",
      provider === "openai" ? raw.prompt_tokens : (raw.promptTokenCount ?? raw.totalTokenCount),
      "usage.prompt_tokens",
    );
    if (provider === "google") result.coverage.unsupportedFeatures.push("embedding_modality_billing");
  } else if (api === "rerank") {
    if (provider === "cohere") {
      const units = object(raw.billedUnits ?? raw.billed_units);
      add(
        "rerank.search_unit",
        "search_unit",
        units.searchUnits ?? units.search_units,
        "meta.billed_units.search_units",
      );
    } else add("token.input", "token", raw.total_tokens, "usage.total_tokens");
  } else {
    // Image count describes returned images. Failed/partial request billing still needs provider evidence.
    add("image.output", "image", Array.isArray(data.data) ? data.data.length : undefined, "data.length", "measured");
    if (raw.input_tokens !== undefined || raw.output_tokens !== undefined) {
      add("token.input", "token", raw.input_tokens, "usage.input_tokens");
      add("token.output", "token", raw.output_tokens, "usage.output_tokens");
      result.coverage.unsupportedFeatures.push("image_token_modality_partition");
    }
    result.coverage.unsupportedFeatures.push("image_billing_contract_required");
  }
  return result;
}

/** Measured speech quantities are estimates until a billing contract defines their unit semantics. */
export function normalizeSpeechUsage(provider: string, unit: string, quantity: number): NormalizedUsage {
  const issues: NormalizedUsage["issues"] = [];
  const valid =
    Number.isFinite(quantity) && quantity >= 0 && quantity <= Number.MAX_SAFE_INTEGER && !/[eE]/.test(String(quantity));
  if (!valid) issues.push({ code: "invalid_quantity", message: "Speech quantity must be finite and nonnegative." });
  const meter = unit === "characters" ? "speech.characters" : unit === "seconds" ? "speech.duration" : `speech.${unit}`;
  return {
    schemaVersion: 1,
    normalizerId: `${provider}.speech`,
    normalizerVersion: "1",
    tokens: null,
    measurements: [
      {
        id: meter,
        meter,
        unit: unit === "characters" ? "character" : unit === "seconds" ? "second" : unit,
        quantity: valid ? String(quantity) : null,
        dimensions: {},
        source: "measured",
        evidencePaths: ["speech.onUsage"],
      },
    ],
    coverage: { requiredMeters: [meter], unsupportedFeatures: ["speech_billing_contract_required"] },
    issues,
  };
}
