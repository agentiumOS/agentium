import { createRequire } from "node:module";
import { generateOpenAIStyle, streamOpenAIStyle } from "../openai-api.js";
import type { ModelProvider } from "../provider.js";
import type { ChatMessage, ModelConfig, ModelResponse, StreamChunk, ToolDefinition } from "../types.js";

const _require = createRequire(import.meta.url);

export interface AzureOpenAIConfig {
  apiKey?: string;
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
}

/**
 * OpenAI models hosted on Azure via the `openai` SDK's `AzureOpenAI` class.
 *
 * GPT-5.4+ / GPT-6 tool calls go through Azure's Responses API when available,
 * and fall back to Chat Completions with `reasoning_effort: "none"`.
 *
 * Requires: `npm install openai`
 */
export class AzureOpenAIProvider implements ModelProvider {
  readonly providerId = "azure-openai";
  readonly modelId: string;
  private client: any;
  private AzureOpenAICtor: any;

  constructor(modelId: string, config?: AzureOpenAIConfig) {
    this.modelId = modelId;
    try {
      const mod = _require("openai");
      this.AzureOpenAICtor = mod.AzureOpenAI;
      if (!this.AzureOpenAICtor) {
        throw new Error("AzureOpenAI class not found in the openai package. Ensure you have openai >= 4.28.0");
      }

      const apiKey = config?.apiKey ?? process.env.AZURE_OPENAI_API_KEY;
      const endpoint = config?.endpoint ?? process.env.AZURE_OPENAI_ENDPOINT;
      const deployment = config?.deployment ?? process.env.AZURE_OPENAI_DEPLOYMENT;
      const apiVersion = config?.apiVersion ?? process.env.AZURE_OPENAI_API_VERSION ?? "2024-10-21";

      this.client = new this.AzureOpenAICtor({
        apiKey,
        endpoint,
        deployment,
        apiVersion,
      });
    } catch (e: any) {
      if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error("openai package is required for AzureOpenAIProvider. Install it: npm install openai");
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
    return generateOpenAIStyle(
      this.client,
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
      this.client,
      this.modelId,
      messages,
      options,
      this.withRetry.bind(this),
      { maxTokensField: "max_completion_tokens" },
    );
  }
}
