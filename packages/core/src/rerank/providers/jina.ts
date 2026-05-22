import type { RerankDocument, Reranker, RerankOptions, RerankResult } from "../types.js";
import { toRerankInput } from "../types.js";

export interface JinaRerankerConfig {
  apiKey?: string;
  /** Jina rerank model. Defaults to `jina-reranker-v2-base-multilingual`. */
  model?: string;
  /** Optional override for the Jina base URL. */
  baseURL?: string;
}

/**
 * Jina AI reranker. Uses Jina's HTTPS API directly (no SDK required).
 *
 * Docs: https://jina.ai/reranker
 */
export class JinaReranker implements Reranker {
  readonly providerId = "jina";
  private apiKey: string | undefined;
  private model: string;
  private baseURL: string;

  constructor(config: JinaRerankerConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.JINA_API_KEY;
    this.model = config.model ?? "jina-reranker-v2-base-multilingual";
    this.baseURL = (config.baseURL ?? "https://api.jina.ai/v1").replace(/\/$/, "");
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
    if (!this.apiKey) {
      throw new Error("JinaReranker: missing API key. Set JINA_API_KEY or pass `apiKey` in config.");
    }

    const inputs = documents.map(toRerankInput);

    const json: any = await this.withRetry(async () => {
      const res = await fetch(`${this.baseURL}/rerank`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          query,
          documents: inputs.map((d) => d.content),
          top_n: options?.topK ?? documents.length,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        const err: any = new Error(`Jina rerank failed (${res.status}): ${text}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    });

    const ranked: RerankResult[] = (json.results ?? []).map((r: any) => {
      const idx: number = r.index;
      const input = inputs[idx];
      return {
        index: idx,
        score: r.relevance_score,
        content: input.content,
        id: input.id,
        metadata: input.metadata,
      };
    });

    return options?.minScore != null ? ranked.filter((r) => r.score >= options.minScore!) : ranked;
  }
}
