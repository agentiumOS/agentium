import { createRequire } from "node:module";
import type { RerankDocument, Reranker, RerankOptions, RerankResult } from "../types.js";
import { toRerankInput } from "../types.js";

const _require = createRequire(import.meta.url);

export interface CohereRerankerConfig {
  apiKey?: string;
  /** Cohere rerank model. Defaults to `rerank-v3.5`. */
  model?: string;
}

/**
 * Cohere reranker. Requires the `cohere-ai` package as an optional peer dependency.
 *
 * Pricing/availability docs: https://docs.cohere.com/reference/rerank
 */
export class CohereReranker implements Reranker {
  readonly providerId = "cohere";
  private client: any;
  private model: string;

  constructor(config: CohereRerankerConfig = {}) {
    this.model = config.model ?? "rerank-v3.5";
    try {
      const mod = _require("cohere-ai");
      const ClientClass = mod.CohereClient ?? mod.CohereClientV2 ?? mod.default;
      if (!ClientClass) {
        throw new Error("cohere-ai package found but no Client export — upgrade to >=7.x");
      }
      this.client = new ClientClass({ token: config.apiKey ?? process.env.COHERE_API_KEY });
    } catch (e: any) {
      if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error("cohere-ai is required for CohereReranker. Install it: npm install cohere-ai");
      }
      throw e;
    }
  }

  private async withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        const status = err?.status ?? err?.statusCode;
        const isRetryable = status === 429 || status === 500 || status === 502 || status === 503;
        if (!isRetryable || attempt === retries) throw err;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt + Math.random() * 500));
      }
    }
    throw new Error("Unreachable");
  }

  async rerank(query: string, documents: RerankDocument[], options?: RerankOptions): Promise<RerankResult[]> {
    if (documents.length === 0) return [];

    const inputs = documents.map(toRerankInput);
    const response: any = await this.withRetry(() =>
      this.client.rerank({
        model: this.model,
        query,
        documents: inputs.map((d) => d.content),
        topN: options?.topK ?? documents.length,
      }),
    );

    const ranked: RerankResult[] = (response.results ?? []).map((r: any) => {
      const idx: number = r.index;
      const input = inputs[idx];
      return {
        index: idx,
        score: r.relevanceScore ?? r.relevance_score,
        content: input.content,
        id: input.id,
        metadata: input.metadata,
      };
    });

    return options?.minScore != null ? ranked.filter((r) => r.score >= options.minScore!) : ranked;
  }
}
