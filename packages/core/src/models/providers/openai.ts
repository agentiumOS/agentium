import { createRequire } from "node:module";
import {
  type ModelCapabilities,
  type UnknownCapabilityPolicy,
  validateModelCapabilities,
  validateModelRequest,
} from "../capabilities.js";
import { generateOpenAIStyle, streamOpenAIStyle } from "../openai-api.js";
import type { ModelProvider } from "../provider.js";
import {
  abortable,
  createRequestScope,
  type ProviderRequestControls,
  validateRequestControls,
} from "../request-controls.js";
import type { ChatMessage, ModelConfig, ModelResponse, StreamChunk, ToolDefinition } from "../types.js";

const _require = createRequire(import.meta.url);

export interface OpenAIConfig extends ProviderRequestControls {
  capabilities?: ModelCapabilities;
  unknownCapabilities?: UnknownCapabilityPolicy;
  apiKey?: string;
  baseURL?: string;
  /** responses requires Responses; chat_completions rejects incompatible semantics. Default auto. */
  endpoint?: "auto" | "responses" | "chat_completions";
  /** Default compatible: never drop reasoning, tools or continuation to fall back. */
  fallback?: "compatible" | "error";
}

export class OpenAIProvider implements ModelProvider {
  readonly providerId = "openai";
  readonly modelId: string;
  readonly capabilities?: ModelCapabilities;
  readonly unknownCapabilities?: UnknownCapabilityPolicy;
  readonly communicationCapabilities = { messagePhases: "conditional", reasoningSummaries: "conditional" } as const;
  readonly attemptVisibility: "physical" | "opaque";
  private config: OpenAIConfig;
  private client: any;
  private OpenAICtor: any;
  private clientCache = new Map<string, any>();

  constructor(modelId: string, config?: OpenAIConfig) {
    this.modelId = modelId;
    this.config = { ...config };
    this.capabilities = { historyEviction: "closed_turns", ...structuredClone(config?.capabilities ?? {}) };
    this.unknownCapabilities = config?.unknownCapabilities;
    validateModelCapabilities(this.capabilities);
    validateRequestControls(this.config);
    this.attemptVisibility = config?.sdkMaxRetries === 0 ? "physical" : "opaque";
    try {
      const mod = _require("openai");
      this.OpenAICtor = mod.default ?? mod;
      const key = config?.apiKey ?? process.env.OPENAI_API_KEY;
      if (key) {
        this.client = new this.OpenAICtor(this.clientOptions(key));
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
        cached = new this.OpenAICtor(this.clientOptions(apiKey));
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
      this.client = new this.OpenAICtor(this.clientOptions(envKey));
      return this.client;
    }
    throw new Error(
      "No OpenAI API key provided. Pass it via the x-openai-api-key header, apiKey in request body, or set OPENAI_API_KEY env var.",
    );
  }

  private clientOptions(apiKey: string) {
    return {
      apiKey,
      baseURL: this.config.baseURL,
      ...(this.config.sdkMaxRetries !== undefined ? { maxRetries: this.config.sdkMaxRetries } : {}),
      ...(this.config.timeoutMs !== undefined ? { timeout: this.config.timeoutMs } : {}),
    };
  }

  async generate(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): Promise<ModelResponse> {
    if (options?.maxTokens === undefined && this.capabilities?.maxOutputTokens !== undefined)
      options = { ...options, maxTokens: this.capabilities.maxOutputTokens };
    validateModelRequest(this.capabilities, messages, options, this.unknownCapabilities);
    const scope = createRequestScope(this.config, options);
    try {
      return await generateOpenAIStyle(
        this.getClient(options?.apiKey),
        this.modelId,
        messages,
        { ...options, signal: scope.signal },
        scope.retry,
        {
          maxTokensField: "max_completion_tokens",
          providerId: this.providerId,
          endpoint: this.config.endpoint,
          fallback: this.config.fallback,
        },
      );
    } finally {
      scope.dispose();
    }
  }

  async *stream(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): AsyncGenerator<StreamChunk> {
    if (options?.maxTokens === undefined && this.capabilities?.maxOutputTokens !== undefined)
      options = { ...options, maxTokens: this.capabilities.maxOutputTokens };
    validateModelRequest(this.capabilities, messages, options, this.unknownCapabilities);
    const scope = createRequestScope(this.config, options);
    try {
      const iterator = streamOpenAIStyle(
        this.getClient(options?.apiKey),
        this.modelId,
        messages,
        { ...options, signal: scope.signal },
        scope.retry,
        {
          maxTokensField: "max_completion_tokens",
          providerId: this.providerId,
          endpoint: this.config.endpoint,
          fallback: this.config.fallback,
        },
      );
      try {
        while (true) {
          const next = await abortable(iterator.next(), scope.signal);
          if (next.done) return;
          yield next.value;
        }
      } finally {
        scope.dispose();
        await iterator.return(undefined);
      }
    } finally {
      scope.dispose();
    }
  }
}
