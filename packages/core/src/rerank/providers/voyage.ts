import type { RerankDocument, Reranker, RerankOptions, RerankResult } from "../types.js";
import { toRerankInput } from "../types.js";

export interface VoyageRerankerConfig {
  apiKey?: string;
  /** Voyage rerank model. Defaults to `rerank-2`. */
  model?: string;
  /** Optional override for the Voyage base URL. */
  baseURL?: string;
}

/**
 * Voyage AI reranker. Uses Voyage's HTTPS API directly (no SDK required).
 *
 * Docs: https://docs.voyageai.com/reference/reranker-api
 */
export class VoyageReranker implements Reranker {
  readonly providerId = "voyage";
  private apiKey: string | undefined;
  private model: string;
  private baseURL: string;

  constructor(config: VoyageRerankerConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.VOYAGE_API_KEY;
    this.model = config.model ?? "rerank-2";
    this.baseURL = (config.baseURL ?? "https://api.voyageai.com/v1").replace(/\/$/, "");
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
      throw new Error("VoyageReranker: missing API key. Set VOYAGE_API_KEY or pass `apiKey` in config.");
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
          query,
          documents: inputs.map((d) => d.content),
          model: this.model,
          top_k: options?.topK ?? documents.length,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        const err: any = new Error(`Voyage rerank failed (${res.status}): ${text}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    });

    const ranked: RerankResult[] = (json.data ?? []).map((r: any) => {
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
