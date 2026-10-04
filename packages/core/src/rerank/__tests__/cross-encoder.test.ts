import { describe, expect, it, vi } from "vitest";
import { loadCrossEncoder } from "../providers/cross-encoder.js";

describe("Transformers.js cross-encoder boundary", () => {
  it("tokenizes actual text pairs and preserves differences between single relevance logits", async () => {
    const tokenizer = vi.fn((text, options) => ({ query: text, document: options.text_pair }));
    const model = Object.assign(
      vi.fn(async (input) => ({
        logits: { dims: [1, 1], data: new Float32Array([input.document === "relevant" ? 3 : -2]) },
      })),
      { config: {} },
    );
    const sdk = {
      AutoTokenizer: { from_pretrained: vi.fn(async () => tokenizer) },
      AutoModelForSequenceClassification: { from_pretrained: vi.fn(async () => model) },
    };
    const options = { local_files_only: true, dtype: "q8" };
    const pipeline = await loadCrossEncoder(sdk, "/models/local", options);
    const settings = { top_k: null, function_to_apply: "sigmoid" as const };
    const relevant = await pipeline({ text: "query", text_pair: "relevant" }, settings);
    const unrelated = await pipeline({ text: "query", text_pair: "unrelated" }, settings);
    expect(relevant).toEqual([{ label: "LABEL_0", score: expect.closeTo(0.952574, 5) }]);
    expect(unrelated).toEqual([{ label: "LABEL_0", score: expect.closeTo(0.119203, 5) }]);
    expect(tokenizer).toHaveBeenCalledWith("query", { text_pair: "relevant", padding: true, truncation: true });
    expect(sdk.AutoTokenizer.from_pretrained).toHaveBeenCalledWith("/models/local", options);
    expect(sdk.AutoModelForSequenceClassification.from_pretrained).toHaveBeenCalledWith("/models/local", options);
  });
  it("retains classifier labels and rejects malformed or nonfinite logits", async () => {
    const classify = vi.fn(async () => ({ logits: { dims: [1, 2], data: [-2, 2] } }));
    const model = Object.assign(classify, { config: { id2label: { "0": "irrelevant", "1": "relevant" } } });
    const pipeline = await loadCrossEncoder(
      {
        AutoTokenizer: { from_pretrained: async () => () => ({}) },
        AutoModelForSequenceClassification: { from_pretrained: async () => model },
      },
      "local",
      { local_files_only: true },
    );
    const input = { text: "query", text_pair: "doc" };
    const settings = { top_k: null, function_to_apply: "sigmoid" as const };
    expect(await pipeline(input, settings)).toEqual([
      { label: "irrelevant", score: expect.closeTo(0.119203, 5) },
      { label: "relevant", score: expect.closeTo(0.880797, 5) },
    ]);
    classify.mockResolvedValueOnce({ logits: { dims: [2, 1], data: [1, 2] } });
    await expect(pipeline(input, settings)).rejects.toThrow(/one sequence/);
    classify.mockResolvedValueOnce({ logits: { dims: [1, 1], data: [NaN] } });
    await expect(pipeline(input, settings)).rejects.toThrow(/nonfinite/);
  });
});
