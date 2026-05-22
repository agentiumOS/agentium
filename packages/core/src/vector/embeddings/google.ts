import { createRequire } from "node:module";
import type { EmbeddingProvider } from "../types.js";

const _require = createRequire(import.meta.url);

export interface GoogleEmbeddingConfig {
  apiKey?: string;
  model?: string;
  dimensions?: number;
}

const MODEL_DIMENSIONS: Record<string, number> = {
  "text-embedding-004": 768,
  "embedding-001": 768,
};

export class GoogleEmbedding implements EmbeddingProvider {
  readonly dimensions: number;
  private ai: any;
  private model: string;

  constructor(config: GoogleEmbeddingConfig = {}) {
    this.model = config.model ?? "text-embedding-004";
    this.dimensions = config.dimensions ?? MODEL_DIMENSIONS[this.model] ?? 768;

    try {
      const { GoogleGenAI } = _require("@google/genai");
      this.ai = new GoogleGenAI({
        apiKey: config.apiKey ?? process.env.GOOGLE_API_KEY,
      });
    } catch (e: any) {
      if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error("@google/genai is required for GoogleEmbedding. Install it: npm install @google/genai");
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

  async embed(text: string): Promise<number[]> {
    const result: any = await this.withRetry(() =>
      this.ai.models.embedContent({
        model: this.model,
        contents: text,
        ...(this.dimensions !== MODEL_DIMENSIONS[this.model]
          ? { config: { outputDimensionality: this.dimensions } }
          : {}),
      }),
    );
    return result.embeddings[0].values;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const BATCH_SIZE = 20;
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const chunk = texts.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        chunk.map((text) =>
          this.withRetry(() =>
            this.ai.models.embedContent({
              model: this.model,
              contents: text,
              ...(this.dimensions !== MODEL_DIMENSIONS[this.model]
                ? { config: { outputDimensionality: this.dimensions } }
                : {}),
            }),
          ),
        ),
      );
      results.push(...batchResults.map((r: any) => r.embeddings[0].values));
    }
    return results;
  }
}
