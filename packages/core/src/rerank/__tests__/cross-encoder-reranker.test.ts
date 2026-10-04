import { describe, expect, it, vi } from "vitest";
import {
  type CrossEncoderPipeline,
  CrossEncoderReranker,
  type CrossEncoderRerankerConfig,
} from "../providers/cross-encoder-reranker.js";

describe("local cross-encoder migration", () => {
  it("loads the supplied local artifact once and ranks positive relevance rather than highest label confidence", async () => {
    const pipeline = vi.fn<CrossEncoderPipeline>(async ({ text_pair }) => [
      { label: "irrelevant", score: text_pair === "wrong" ? 0.99 : 0.1 },
      { label: "relevant", score: text_pair === "wrong" ? 0.01 : 0.9 },
    ]);
    const factory = vi.fn(async () => pipeline);
    const reranker = new CrossEncoderReranker({
      model: "/models/fixture",
      cacheDir: "/cache",
      dtype: "q8",
      positiveLabel: "relevant",
      pipelineFactory: factory,
    });
    expect(factory).not.toHaveBeenCalled();
    const result = await reranker.rerank("query", [
      { id: "no", content: "wrong" },
      { id: "yes", content: "right", metadata: { keep: true } },
    ]);
    expect(result.map((item) => item.id)).toEqual(["yes", "no"]);
    expect(result[0]).toMatchObject({ score: 0.9, index: 1, metadata: { keep: true } });
    expect(factory).toHaveBeenCalledWith("text-classification", "/models/fixture", {
      local_files_only: true,
      cache_dir: "/cache",
      dtype: "q8",
    });
    expect(pipeline.mock.calls[0][1]).toEqual({ top_k: null, function_to_apply: "sigmoid" });
    await reranker.ready();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(await reranker.rerank("q", ["wrong", "right"], { minScore: 0.5, topK: 1 })).toHaveLength(1);
  });
  it("does no work for empty selections and rejects malformed scores", async () => {
    const factory = vi.fn(async () => async () => [{ label: "bad", score: NaN }]);
    const reranker = new CrossEncoderReranker({ pipelineFactory: factory });
    expect(await reranker.rerank("q", [])).toEqual([]);
    expect(await reranker.rerank("q", ["doc"], { topK: 0 })).toEqual([]);
    expect(factory).not.toHaveBeenCalled();
    await expect(reranker.rerank("q", ["doc"])).rejects.toThrow(/finite/);
  });
  it.runIf(!!process.env.AGENTIUM_TRANSFORMERS_MODEL)(
    "loads preinstalled SDK and local model weights without network downloads",
    async () => {
      const dtype = process.env.AGENTIUM_TRANSFORMERS_DTYPE ?? "fp32";
      if (!["fp32", "fp16", "q8", "q4"].includes(dtype)) throw new Error("Unsupported fixture precision");
      const reranker = new CrossEncoderReranker({
        model: process.env.AGENTIUM_TRANSFORMERS_MODEL,
        localFilesOnly: true,
        dtype: dtype as CrossEncoderRerankerConfig["dtype"],
      });
      const result = await reranker.rerank("What is the capital of France?", [
        "Paris is the capital of France.",
        "A toaster heats bread.",
      ]);
      expect(result[0].index).toBe(0);
      expect(result[0].score).toBeGreaterThan(result[1].score);
      await expect(
        new CrossEncoderReranker({
          model: `${process.env.AGENTIUM_TRANSFORMERS_MODEL}/missing`,
          localFilesOnly: true,
        }).ready(),
      ).rejects.toThrow();
    },
    60000,
  );
});
