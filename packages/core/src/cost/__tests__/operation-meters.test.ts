import { describe, expect, it } from "vitest";
import { normalizeOperationUsage, normalizeSpeechUsage } from "../operation-usage.js";

describe("non-model billing evidence", () => {
  it("retains provider embedding counts without response content", () => {
    const usage = normalizeOperationUsage("openai", "embeddings", {
      usage: { prompt_tokens: 42, total_tokens: 42 },
      data: [{ embedding: [1, 2, 3] }],
    });
    expect(usage.measurements[0]).toMatchObject({ meter: "token.input", quantity: "42", source: "provider" });
    expect(usage.rawUsage).toEqual({ prompt_tokens: 42, total_tokens: 42 });
  });
  it("uses Cohere billed search units, not document count", () => {
    const usage = normalizeOperationUsage("cohere", "rerank", {
      meta: { billedUnits: { searchUnits: 2 } },
      results: [1],
    });
    expect(usage.measurements[0]).toMatchObject({ meter: "rerank.search_unit", quantity: "2" });
  });
  it("keeps missing rerank token evidence unknown", () => {
    const usage = normalizeOperationUsage("voyage", "rerank", { data: [] });
    expect(usage.measurements[0].quantity).toBeNull();
    expect(usage.coverage.requiredMeters).toContain("token.input");
  });
  it("marks returned image count as measured and token overlap as uncovered", () => {
    const usage = normalizeOperationUsage(
      "openai",
      "images",
      { data: [{ url: "secret-result" }], usage: { input_tokens: 20, output_tokens: 200 } },
      { size: "1024x1024", quality: "hd" },
    );
    expect(usage.measurements[0]).toMatchObject({
      meter: "image.output",
      source: "measured",
      quantity: "1",
      dimensions: { quality: "hd" },
    });
    expect(usage.coverage.unsupportedFeatures).toContain("image_token_modality_partition");
    expect(JSON.stringify(usage)).not.toContain("secret-result");
  });
  it("retains speech characters and durations without assuming a tariff", () => {
    expect(normalizeSpeechUsage("elevenlabs", "characters", 200).measurements[0]).toMatchObject({
      meter: "speech.characters",
      unit: "character",
      quantity: "200",
      source: "measured",
    });
    expect(normalizeSpeechUsage("sarvam", "seconds", 20.5).measurements[0]).toMatchObject({
      meter: "speech.duration",
      unit: "second",
      quantity: "20.5",
    });
    expect(normalizeSpeechUsage("sarvam", "seconds", -1).measurements[0].quantity).toBeNull();
  });
});
