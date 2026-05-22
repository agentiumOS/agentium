import { createRequire } from "node:module";
import type { EmbeddingProvider } from "../types.js";

const _require = createRequire(import.meta.url);

export interface OpenAIEmbeddingConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  dimensions?: number;
}

const MODEL_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

export class OpenAIEmbedding implements EmbeddingProvider {
  readonly dimensions: number;
  readonly supportsMultimodal = false;
  private client: any;
  private model: string;

  constructor(config: OpenAIEmbeddingConfig = {}) {
    this.model = config.model ?? "text-embedding-3-small";
    this.dimensions = config.dimensions ?? MODEL_DIMENSIONS[this.model] ?? 1536;

    try {
      const mod = _require("openai");
      const OpenAI = mod.default ?? mod;
      this.client = new OpenAI({
        apiKey: config.apiKey ?? process.env.OPENAI_API_KEY,
        baseURL: config.baseURL,
      });
    } catch (e: any) {
      if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error("openai package is required for OpenAIEmbedding. Install it: npm install openai");
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
    const response: any = await this.withRetry(() =>
      this.client.embeddings.create({
        model: this.model,
        input: text,
        ...(this.dimensions !== MODEL_DIMENSIONS[this.model] ? { dimensions: this.dimensions } : {}),
      }),
    );
    return response.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response: any = await this.withRetry(() =>
      this.client.embeddings.create({
        model: this.model,
        input: texts,
        ...(this.dimensions !== MODEL_DIMENSIONS[this.model] ? { dimensions: this.dimensions } : {}),
      }),
    );
    return response.data.sort((a: any, b: any) => a.index - b.index).map((d: any) => d.embedding);
  }
}
