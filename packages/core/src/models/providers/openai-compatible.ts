import { createRequire } from "node:module";
import { generateOpenAIStyle, streamOpenAIStyle } from "../openai-api.js";
import type { ModelProvider } from "../provider.js";
import type { ChatMessage, ModelConfig, ModelResponse, StreamChunk, ToolDefinition } from "../types.js";

const _require = createRequire(import.meta.url);

export interface OpenAICompatibleConfig {
  apiKey?: string;
  baseURL?: string;
}

interface ProviderDefaults {
  baseURL: string;
  apiKeyEnvVar: string;
}

/**
 * Generic provider for any API that follows the OpenAI Chat Completions
 * format. Subclasses only need to supply a `providerId`, default `baseURL`,
 * and the environment-variable name that holds the API key.
 *
 * GPT-5.4+ / GPT-6 with tools use `/v1/responses` when the gateway exposes it
 * (LiteLLM, OpenRouter, Azure). Otherwise Chat Completions gets
 * `reasoning_effort: "none"` so function tools do not 400.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly providerId: string;
  readonly modelId: string;
  private client: any;
  private OpenAICtor: any;
  private baseURL: string;

  constructor(providerId: string, modelId: string, defaults: ProviderDefaults, config?: OpenAICompatibleConfig) {
    this.providerId = providerId;
    this.modelId = modelId;
    this.baseURL = config?.baseURL ?? defaults.baseURL;

    try {
      const mod = _require("openai");
      this.OpenAICtor = mod.default ?? mod;
      const apiKey = config?.apiKey ?? process.env[defaults.apiKeyEnvVar];
      this.client = new this.OpenAICtor({ apiKey, baseURL: this.baseURL });
    } catch (e: any) {
      if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error(`openai package is required for ${providerId} provider. Install it: npm install openai`);
      }
      throw e;
    }
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
    return generateOpenAIStyle(this.client, this.modelId, messages, options, this.withRetry.bind(this));
  }

  async *stream(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): AsyncGenerator<StreamChunk> {
    yield* streamOpenAIStyle(this.client, this.modelId, messages, options, this.withRetry.bind(this));
  }
}
