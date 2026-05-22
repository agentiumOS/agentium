import { createRequire } from "node:module";
import type { RerankDocument, Reranker, RerankOptions, RerankResult } from "../types.js";
import { toRerankInput } from "../types.js";

const _require = createRequire(import.meta.url);

export interface ColbertRerankerConfig {
  /**
   * HuggingFace model ID. Defaults to a small cross-encoder
   * (`Xenova/ms-marco-MiniLM-L-6-v2`) that runs locally via `@xenova/transformers`.
   *
   * For true ColBERT-style late interaction at production scale, swap to a
   * dedicated ColBERT v2 endpoint by composing this with another `Reranker`.
   */
  model?: string;
  /** Optional pre-warm: load the model on construction instead of on first call. */
  prewarm?: boolean;
}

/**
 * Local cross-encoder reranker via `@xenova/transformers` (no API key required).
 *
 * "ColBERT-style" in the sense of late-interaction-on-top-of-bi-encoder; for
 * highest quality the recommendation is to combine a fast bi-encoder retrieval
 * (Cohere/Voyage/Jina) with this for the final pass.
 */
export class ColbertReranker implements Reranker {
  readonly providerId = "colbert-local";
  private model: string;
  private pipelinePromise: Promise<any> | null = null;

  constructor(config: ColbertRerankerConfig = {}) {
    this.model = config.model ?? "Xenova/ms-marco-MiniLM-L-6-v2";
    if (config.prewarm) {
      void this.pipeline();
    }
  }

  private async pipeline(): Promise<any> {
    if (this.pipelinePromise) return this.pipelinePromise;
    this.pipelinePromise = (async () => {
      try {
        const mod = _require("@xenova/transformers");
        // The pipeline factory is exposed as `pipeline`.
        return await mod.pipeline("text-classification", this.model);
      } catch (e: any) {
        if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
          throw new Error(
            "@xenova/transformers is required for ColbertReranker. Install it: npm install @xenova/transformers",
          );
        }
        throw e;
      }
    })();
    return this.pipelinePromise;
  }

  async rerank(query: string, documents: RerankDocument[], options?: RerankOptions): Promise<RerankResult[]> {
    if (documents.length === 0) return [];
    const inputs = documents.map(toRerankInput);

    const pipeline = await this.pipeline();
    // Cross-encoder: feed query + each document as a pair, take the positive-class score.
    const scored: RerankResult[] = [];
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      const out: any = await pipeline({ text: query, text_pair: input.content });
      const score: number = Array.isArray(out) ? (out[0]?.score ?? 0) : (out?.score ?? 0);
      scored.push({
        index: i,
        score,
        content: input.content,
        id: input.id,
        metadata: input.metadata,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    const filtered = options?.minScore != null ? scored.filter((r) => r.score >= options.minScore!) : scored;
    return options?.topK ? filtered.slice(0, options.topK) : filtered;
  }
}
