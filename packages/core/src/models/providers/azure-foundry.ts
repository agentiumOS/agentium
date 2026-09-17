import { createRequire } from "node:module";
import { generateOpenAIStyle, streamOpenAIStyle } from "../openai-api.js";
import type { ModelProvider } from "../provider.js";
import type { ChatMessage, ModelConfig, ModelResponse, StreamChunk, ToolDefinition } from "../types.js";

const _require = createRequire(import.meta.url);

export interface AzureFoundryConfig {
  apiKey?: string;
  endpoint?: string;
  apiVersion?: string;
}

/**
 * Azure AI Foundry provider — access Phi, Llama, Mistral, Cohere and other
 * open-source models hosted on Azure's model catalog.
 *
 * Uses the standard OpenAI SDK pointed at the Azure AI Foundry endpoint, since
 * Azure AI Foundry exposes an OpenAI-compatible API. GPT-5.4+ / GPT-6 tool
 * calls use Responses when the endpoint supports it.
 *
 * Requires: `npm install openai`
 */
export class AzureFoundryProvider implements ModelProvider {
  readonly providerId = "azure-foundry";
  readonly modelId: string;
  private client: any;
  private OpenAICtor: any;

  constructor(modelId: string, config?: AzureFoundryConfig) {
    this.modelId = modelId;
    try {
      const mod = _require("openai");
      this.OpenAICtor = mod.default ?? mod;

      const apiKey = config?.apiKey ?? process.env.AZURE_API_KEY;
      const endpoint = config?.endpoint ?? process.env.AZURE_ENDPOINT;

      if (!endpoint) {
        throw new Error(
          "Azure AI Foundry endpoint is required. Pass it via config.endpoint or set AZURE_ENDPOINT env var. " +
            "Format: https://<host>.<region>.models.ai.azure.com",
        );
      }

      this.client = new this.OpenAICtor({
        apiKey,
        baseURL: endpoint,
      });
    } catch (e: any) {
      if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error("openai package is required for AzureFoundryProvider. Install it: npm install openai");
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
