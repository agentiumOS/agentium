import { createRequire } from "node:module";
import type { ContentPart } from "../../models/types.js";
import type { EmbeddingInput, EmbeddingProvider } from "../types.js";
import { fetchAsBase64 } from "./multimodal-utils.js";

const _require = createRequire(import.meta.url);

export interface GoogleEmbeddingConfig {
  apiKey?: string;
  model?: string;
  dimensions?: number;
}

const MODEL_DIMENSIONS: Record<string, number> = {
  "text-embedding-004": 768,
  "embedding-001": 768,
  "gemini-embedding-001": 3072,
  "gemini-embedding-2": 3072,
};

const SUPPORTED_MM_MIME_PREFIXES = ["image/", "audio/", "video/"];
const SUPPORTED_MM_MIME_EXACT = new Set(["application/pdf"]);

export class GoogleEmbedding implements EmbeddingProvider {
  readonly dimensions: number;
  readonly supportsMultimodal: boolean;
  private ai: any;
  private model: string;

  constructor(config: GoogleEmbeddingConfig = {}) {
    this.model = config.model ?? "text-embedding-004";
    this.dimensions = config.dimensions ?? MODEL_DIMENSIONS[this.model] ?? 768;
    this.supportsMultimodal = this.model.startsWith("gemini-embedding-");

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

  async embedMultimodal(input: EmbeddingInput): Promise<number[]> {
    if (!this.supportsMultimodal) {
      throw new Error(
        `Model "${this.model}" does not support multimodal embeddings. ` +
          'Use "gemini-embedding-2" (or any "gemini-embedding-*" model).',
      );
    }
    const parts = normalizeInput(input);
    const contents = await Promise.all(parts.map((p) => partToGenAIContent(p)));

    const result: any = await this.withRetry(() =>
      this.ai.models.embedContent({
        model: this.model,
        contents,
        ...(this.dimensions !== MODEL_DIMENSIONS[this.model]
          ? { config: { outputDimensionality: this.dimensions } }
          : {}),
      }),
    );
    return result.embeddings[0].values;
  }
}

function normalizeInput(input: EmbeddingInput): ContentPart[] {
  if (typeof input === "string") return [{ type: "text", text: input }];
  if (Array.isArray(input)) return input;
  return [input];
}

async function partToGenAIContent(part: ContentPart): Promise<unknown> {
  if (part.type === "text") {
    return { text: part.text };
  }
  if (part.type === "image") {
    const mimeType = part.mimeType ?? "image/png";
    if (isUrl(part.data)) {
      const fetched = await fetchAsBase64(part.data);
      return { inlineData: { data: fetched.data, mimeType: fetched.mimeType || mimeType } };
    }
    return { inlineData: { data: part.data, mimeType } };
  }
  if (part.type === "audio") {
    const mimeType = part.mimeType ?? "audio/wav";
    return { inlineData: { data: part.data, mimeType } };
  }
  // FilePart
  const mt = part.mimeType;
  const supported = SUPPORTED_MM_MIME_PREFIXES.some((p) => mt.startsWith(p)) || SUPPORTED_MM_MIME_EXACT.has(mt);
  if (!supported) {
    throw new Error(
      `Unsupported MIME type for multimodal embedding: "${mt}". ` +
        `Supported: image/*, audio/*, video/*, application/pdf.`,
    );
  }
  if (isUrl(part.data)) {
    const fetched = await fetchAsBase64(part.data);
    return { inlineData: { data: fetched.data, mimeType: fetched.mimeType || mt } };
  }
  return { inlineData: { data: part.data, mimeType: mt } };
}

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}
