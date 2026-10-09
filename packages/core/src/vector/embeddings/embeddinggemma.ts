import { meteredOperation } from "../../cost/accounting.js";
import type { AccountingContext } from "../../cost/context.js";
import { normalizeOperationUsage } from "../../cost/operation-usage.js";
import type { EmbeddingProvider } from "../types.js";

/** Asymmetric retrieval tasks use a different prefix for queries and documents. */
export type EmbeddingGemmaTask =
  | "retrieval"
  | "code"
  | "qa"
  | "fact-check"
  | "classification"
  | "clustering"
  | "similarity";

export interface EmbeddingGemmaEmbeddingConfig {
  accounting?: AccountingContext;
  /** `ollama` talks to `/api/embed`. `openai` talks to an OpenAI-compatible `/embeddings` server. */
  backend?: "ollama" | "openai";
  /** Ollama tag or server model id. Defaults depend on the backend. */
  model?: string;
  /** Ollama host. Default `http://127.0.0.1:11434`. */
  host?: string;
  /** OpenAI-compatible base URL. Default `http://127.0.0.1:8000/v1`. */
  baseURL?: string;
  /** Sent as a bearer token only when set. Local servers that do not check auth can omit it. */
  apiKey?: string;
  /**
   * Matryoshka length. Native size is 768. Any integer from 128 through 768 is accepted;
   * 768, 512, 256, and 128 are the lengths Google evaluated.
   */
  dimensions?: number;
  /** Task prompt pair. Default `retrieval`. */
  task?: EmbeddingGemmaTask;
  /** Replaces the document prefix from `task`. Include the trailing space. */
  documentPrompt?: string;
  /** Replaces the query prefix from `task`. Include the trailing space. */
  queryPrompt?: string;
  /** Inputs per HTTP request. Default 32. */
  batchSize?: number;
}

const NATIVE_DIMENSIONS = 768;

const TASKS: Record<EmbeddingGemmaTask, { query: string; document: string }> = {
  retrieval: { query: "task: search result | query: ", document: "title: none | text: " },
  code: { query: "task: code retrieval | query: ", document: "title: none | text: " },
  qa: { query: "task: question answering | query: ", document: "title: none | text: " },
  "fact-check": { query: "task: fact checking | query: ", document: "title: none | text: " },
  classification: { query: "task: classification | query: ", document: "task: classification | query: " },
  clustering: { query: "task: clustering | query: ", document: "task: clustering | query: " },
  similarity: { query: "task: sentence similarity | query: ", document: "task: sentence similarity | query: " },
};

/**
 * Local EmbeddingGemma 2 embeddings. Text and code only.
 * The model runs in Ollama or an OpenAI-compatible server (vLLM, llama.cpp, LM Studio).
 * This class does not call the Gemini API and does not load weights in-process.
 */
export class EmbeddingGemmaEmbedding implements EmbeddingProvider {
  readonly dimensions: number;
  readonly supportsMultimodal = false;
  private backend: "ollama" | "openai";
  private model: string;
  private endpoint: string;
  private apiKey?: string;
  private documentPrompt: string;
  private queryPrompt: string;
  private batchSize: number;
  private accounting?: AccountingContext;

  constructor(config: EmbeddingGemmaEmbeddingConfig = {}) {
    this.accounting = config.accounting;
    this.backend = config.backend ?? "ollama";
    if (this.backend !== "ollama" && this.backend !== "openai") {
      throw new Error('EmbeddingGemma backend must be "ollama" or "openai"');
    }
    this.model = config.model ?? (this.backend === "ollama" ? "embeddinggemma-2" : "google/embeddinggemma-2");
    if (!this.model) throw new Error("EmbeddingGemma model must be nonempty");
    this.dimensions = assertDimensions(config.dimensions ?? NATIVE_DIMENSIONS);
    const task = config.task ?? "retrieval";
    const prompts = TASKS[task];
    if (!prompts) throw new Error(`Unknown EmbeddingGemma task "${task}"`);
    this.documentPrompt = config.documentPrompt ?? prompts.document;
    this.queryPrompt = config.queryPrompt ?? prompts.query;
    this.batchSize = config.batchSize ?? 32;
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1) {
      throw new Error("EmbeddingGemma batchSize must be a positive integer");
    }
    this.apiKey = config.apiKey;
    this.endpoint =
      this.backend === "ollama"
        ? new URL("/api/embed", config.host ?? "http://127.0.0.1:11434").href
        : `${(config.baseURL ?? "http://127.0.0.1:8000/v1").replace(/\/$/, "")}/embeddings`;
  }

  async embed(text: string): Promise<number[]> {
    const [vector] = await this.embedPrefixed([`${this.documentPrompt}${text}`]);
    return vector!;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embedPrefixed([`${this.queryPrompt}${text}`]);
    return vector!;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return this.embedPrefixed(texts.map((text) => `${this.documentPrompt}${text}`));
  }

  private async embedPrefixed(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) return [];
    const vectors: number[][] = [];
    for (let offset = 0; offset < inputs.length; offset += this.batchSize) {
      const chunk = inputs.slice(offset, offset + this.batchSize);
      vectors.push(...(await this.request(chunk)));
    }
    return vectors;
  }

  private async request(inputs: string[]): Promise<number[][]> {
    const body =
      this.backend === "ollama"
        ? { model: this.model, input: inputs }
        : {
            model: this.model,
            input: inputs,
            ...(this.dimensions !== NATIVE_DIMENSIONS ? { dimensions: this.dimensions } : {}),
          };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const raw = await this.withRetry(() => postJson(this.endpoint, body, headers));
    const vectors = this.backend === "ollama" ? ollamaVectors(raw, inputs.length) : openaiVectors(raw, inputs.length);
    return vectors.map((vector) => fitDimensions(vector, this.dimensions));
  }

  private async withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await meteredOperation(
          {
            accounting: this.accounting,
            context: {
              providerId: "embeddinggemma",
              billingProviderId: "embeddinggemma",
              modelId: this.model,
              api: "embeddings",
              occurredAt: new Date().toISOString(),
            },
            attemptVisibility: "opaque",
          },
          async (capture) => {
            const result = await fn();
            capture(normalizeOperationUsage("embeddinggemma", "embeddings", usageEvidence(result)));
            return result;
          },
        );
      } catch (err: unknown) {
        const status = statusOf(err);
        const code = (err as { code?: string })?.code;
        const retryable =
          status === 429 ||
          status === 500 ||
          status === 502 ||
          status === 503 ||
          code === "ECONNRESET" ||
          code === "ETIMEDOUT";
        if (!retryable || attempt === retries) throw err;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt + Math.random() * 500));
      }
    }
    throw new Error("Unreachable");
  }
}

function assertDimensions(dimensions: number): number {
  if (!Number.isInteger(dimensions) || dimensions < 128 || dimensions > NATIVE_DIMENSIONS) {
    throw new Error("EmbeddingGemma dimensions must be an integer from 128 to 768");
  }
  return dimensions;
}

/** Slice a longer Matryoshka vector and re-normalize. A vector that is already the requested length is kept. */
function fitDimensions(vector: number[], dimensions: number): number[] {
  if (!Array.isArray(vector) || vector.some((value) => typeof value !== "number")) {
    throw new Error("EmbeddingGemma response did not contain a numeric vector");
  }
  if (vector.length === dimensions) return vector;
  if (vector.length < dimensions) {
    throw new Error(`EmbeddingGemma returned ${vector.length} dimensions, which is shorter than ${dimensions}`);
  }
  const sliced = vector.slice(0, dimensions);
  const norm = Math.sqrt(sliced.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return sliced;
  return sliced.map((value) => value / norm);
}

function ollamaVectors(raw: unknown, count: number): number[][] {
  const embeddings = (raw as { embeddings?: unknown })?.embeddings;
  if (!Array.isArray(embeddings) || embeddings.length !== count) {
    throw new Error("EmbeddingGemma Ollama response did not contain one vector per input");
  }
  return embeddings as number[][];
}

function openaiVectors(raw: unknown, count: number): number[][] {
  const data = (raw as { data?: { embedding?: number[]; index?: number }[] })?.data;
  if (!Array.isArray(data) || data.length !== count) {
    throw new Error("EmbeddingGemma embeddings response did not contain one vector per input");
  }
  return [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((item) => item.embedding ?? []);
}

/** Map OpenAI `prompt_tokens` and Ollama `prompt_eval_count` onto the shared embedding meter. */
function usageEvidence(raw: unknown): unknown {
  const data = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const usage = data.usage && typeof data.usage === "object" ? (data.usage as Record<string, unknown>) : {};
  const prompt = usage.promptTokenCount ?? usage.prompt_tokens ?? data.prompt_eval_count;
  if (typeof prompt !== "number") return raw;
  return { usage: { promptTokenCount: prompt } };
}

function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const status =
    (err as { status?: unknown; statusCode?: unknown }).status ?? (err as { statusCode?: unknown }).statusCode;
  return typeof status === "number" ? status : undefined;
}

async function postJson(url: string, body: unknown, headers: Record<string, string>): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (err) {
    const code = (err as { cause?: { code?: string }; code?: string })?.cause?.code ?? (err as { code?: string })?.code;
    const error = err instanceof Error ? err : new Error(String(err));
    if (code && !(error as { code?: string }).code) (error as { code?: string }).code = code;
    throw error;
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const error = new Error(
      `EmbeddingGemma request failed (${response.status})${text ? `: ${text.slice(0, 300)}` : ""}`,
    );
    (error as { status?: number }).status = response.status;
    throw error;
  }
  return response.json();
}
