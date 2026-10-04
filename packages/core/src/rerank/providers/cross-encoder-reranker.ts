import type { RerankDocument, Reranker, RerankOptions, RerankResult } from "../types.js";
import { toRerankInput } from "../types.js";
import { loadCrossEncoder } from "./cross-encoder.js";

export type CrossEncoderPipeline = (
  input: { text: string; text_pair: string },
  options: { top_k: null; function_to_apply: "sigmoid" },
) => Promise<Array<{ label: string; score: number }> | { label: string; score: number }>;

export interface CrossEncoderRerankerConfig {
  /** Model ID or local artifact directory. This adapter is a cross-encoder, not ColBERT late interaction. */
  model?: string;
  prewarm?: boolean;
  /** Defaults true: ordinary calls never silently download model weights. */
  localFilesOnly?: boolean;
  cacheDir?: string;
  dtype?: "fp32" | "fp16" | "q8" | "q4";
  /** Required when a classifier returns multiple labels; defaults LABEL_1. */
  positiveLabel?: string;
  /** Host-owned loader for custom devices, artifact stores and deterministic tests. */
  pipelineFactory?: (
    task: "text-classification",
    model: string,
    options: {
      local_files_only: boolean;
      cache_dir?: string;
      dtype?: string;
    },
  ) => Promise<CrossEncoderPipeline>;
}

/** Local cross-encoder via the optional @huggingface/transformers package.
 * Scores paired query/document sequences using sequence-classification logits. */
export class CrossEncoderReranker implements Reranker {
  readonly providerId = "cross-encoder-local";
  private pipelinePromise: Promise<CrossEncoderPipeline> | null = null;

  constructor(private readonly config: CrossEncoderRerankerConfig = {}) {
    if (config.prewarm)
      void this.ready().catch(() => {
        /* Failure is observed by ready()/rerank(). */
      });
  }

  async ready(): Promise<void> {
    await this.pipeline();
  }

  private pipeline(): Promise<CrossEncoderPipeline> {
    if (this.pipelinePromise) return this.pipelinePromise;
    this.pipelinePromise = (async () => {
      let factory = this.config.pipelineFactory;
      if (!factory) {
        try {
          // Variable optional import keeps this SDK out of root imports and bundles.
          const packageName = "@huggingface/transformers";
          const mod = await import(packageName);
          factory = (_task, model, options) => loadCrossEncoder(mod, model, options);
        } catch (error: any) {
          if (error?.code === "MODULE_NOT_FOUND" || error?.code === "ERR_MODULE_NOT_FOUND") {
            throw new Error(
              "CrossEncoderReranker requires @huggingface/transformers (^4.3.0); install it or supply pipelineFactory",
            );
          }
          throw error;
        }
      }
      return factory!("text-classification", this.config.model ?? "Xenova/ms-marco-MiniLM-L-6-v2", {
        local_files_only: this.config.localFilesOnly ?? true,
        cache_dir: this.config.cacheDir,
        dtype: this.config.dtype,
      });
    })();
    return this.pipelinePromise;
  }

  async rerank(query: string, documents: RerankDocument[], options?: RerankOptions): Promise<RerankResult[]> {
    if (options?.topK !== undefined && (!Number.isSafeInteger(options.topK) || options.topK < 0))
      throw new Error("topK must be a nonnegative integer");
    if (options?.minScore !== undefined && !Number.isFinite(options.minScore))
      throw new Error("minScore must be finite");
    if (documents.length === 0 || options?.topK === 0) return [];
    const inputs = documents.map(toRerankInput);
    const pipeline = await this.pipeline();
    const scored: RerankResult[] = [];
    for (let index = 0; index < inputs.length; index++) {
      const input = inputs[index];
      const raw = await pipeline(
        { text: query, text_pair: input.content },
        { top_k: null, function_to_apply: "sigmoid" },
      );
      const labels = Array.isArray(raw) ? raw : [raw];
      const selected =
        labels.length === 1
          ? labels[0]
          : labels.find((item) => item.label === (this.config.positiveLabel ?? "LABEL_1"));
      if (!selected || !Number.isFinite(selected.score))
        throw new Error(
          "Cross-encoder returned no finite relevance score; configure positiveLabel for multi-label models",
        );
      scored.push({ index, score: selected.score, ...input });
    }
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    const filtered =
      options?.minScore !== undefined ? scored.filter((result) => result.score >= options.minScore!) : scored;
    return options?.topK !== undefined ? filtered.slice(0, options.topK) : filtered;
  }
}
