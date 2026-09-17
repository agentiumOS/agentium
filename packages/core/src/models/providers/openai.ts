import { createRequire } from "node:module";
import { generateOpenAIStyle, streamOpenAIStyle } from "../openai-api.js";
import type { ModelProvider } from "../provider.js";
import type { ChatMessage, ModelConfig, ModelResponse, StreamChunk, ToolDefinition } from "../types.js";

const _require = createRequire(import.meta.url);

interface OpenAIConfig {
  apiKey?: string;
  baseURL?: string;
}

export class OpenAIProvider implements ModelProvider {
  readonly providerId = "openai";
  readonly modelId: string;
  private client: any;
  private OpenAICtor: any;
  private baseURL?: string;
  private clientCache = new Map<string, any>();

  constructor(modelId: string, config?: OpenAIConfig) {
    this.modelId = modelId;
    this.baseURL = config?.baseURL;
    try {
      const mod = _require("openai");
      this.OpenAICtor = mod.default ?? mod;
      const key = config?.apiKey ?? process.env.OPENAI_API_KEY;
      if (key) {
        this.client = new this.OpenAICtor({ apiKey: key, baseURL: config?.baseURL });
      }
    } catch (e: any) {
      if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error("openai package is required for OpenAIProvider. Install it: npm install openai");
      }
      throw e;
    }
  }

  private getClient(apiKey?: string): any {
    if (apiKey) {
      let cached = this.clientCache.get(apiKey);
      if (!cached) {
        cached = new this.OpenAICtor({ apiKey, baseURL: this.baseURL });
        this.clientCache.set(apiKey, cached);
        if (this.clientCache.size > 50) {
          const oldest = this.clientCache.keys().next().value;
          if (oldest) this.clientCache.delete(oldest);
        }
      }
      return cached;
    }
    if (this.client) return this.client;
    const envKey = process.env.OPENAI_API_KEY;
    if (envKey) {
      this.client = new this.OpenAICtor({ apiKey: envKey, baseURL: this.baseURL });
      return this.client;
    }
    throw new Error(
      "No OpenAI API key provided. Pass it via the x-openai-api-key header, apiKey in request body, or set OPENAI_API_KEY env var.",
    );
  }

  private async withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        const status = err?.status ?? err?.statusCode ?? err?.code;
        const isRetryable =
          status === 429 ||
          status === 500 ||
          status === 502 ||
          status === 503 ||
          err?.code === "ECONNRESET" ||
          err?.code === "ETIMEDOUT" ||
          err?.message?.includes("rate limit");
        if (!isRetryable || attempt === retries) throw err;
        const delay = Math.min(1000 * 2 ** attempt + Math.random() * 500, 10000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw new Error("Unreachable");
  }

  async generate(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): Promise<ModelResponse> {
    return generateOpenAIStyle(
      this.getClient(options?.apiKey),
      this.modelId,
      messages,
      options,
      this.withRetry.bind(this),
      { maxTokensField: "max_completion_tokens" },
    );
  }

  async *stream(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): AsyncGenerator<StreamChunk> {
    yield* streamOpenAIStyle(
      this.getClient(options?.apiKey),
      this.modelId,
      messages,
      options,
      this.withRetry.bind(this),
      { maxTokensField: "max_completion_tokens" },
    );
  }
}
