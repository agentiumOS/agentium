import { createRequire } from "node:module";
import type { ModelProvider } from "../provider.js";
import {
  type ChatMessage,
  type ContentPart,
  getTextContent,
  isMultiModal,
  type ModelConfig,
  type ModelResponse,
  type StreamChunk,
  type TokenUsage,
  type ToolCall,
  type ToolDefinition,
} from "../types.js";

const _require = createRequire(import.meta.url);

export interface PerplexitySearchOptions {
  /** Search mode: web (default), academic, or SEC filings. */
  searchMode?: "web" | "academic" | "sec";
  /** Restrict search to specific domains. */
  searchDomainFilter?: string[];
  /** Restrict search to a recent time window. */
  searchRecencyFilter?: "hour" | "day" | "week" | "month" | "year";
  /** Only return results after this date (YYYY-MM-DD). */
  searchAfterDate?: string;
  /** Only return results before this date (YYYY-MM-DD). */
  searchBeforeDate?: string;
  /** Return images in the response. */
  returnImages?: boolean;
  /** Return related questions. */
  returnRelatedQuestions?: boolean;
  /** Disable search entirely (use model as a pure LLM). */
  disableSearch?: boolean;
  /** Web search context size: low (default), medium, or high. */
  searchContextSize?: "low" | "medium" | "high";
}

export interface PerplexityConfig {
  apiKey?: string;
  baseURL?: string;
  /** Search-specific options (only available with the native SDK). */
  search?: PerplexitySearchOptions;
}

/**
 * Perplexity provider using the `@perplexity-ai/perplexity_ai` SDK.
 *
 * Falls back to the `openai` SDK pointed at Perplexity's OpenAI-compatible
 * endpoint (https://api.perplexity.ai) if the native SDK is not installed.
 *
 * The native SDK unlocks search-specific parameters (domain filtering,
 * recency, academic mode) and typed citation/source responses.
 */
export class PerplexityProvider implements ModelProvider {
  readonly providerId = "perplexity";
  readonly modelId: string;
  private client: any;
  private mode: "native" | "openai-compat";
  private searchOptions?: PerplexitySearchOptions;

  constructor(modelId: string, config?: PerplexityConfig) {
    this.modelId = modelId;
    this.searchOptions = config?.search;
    const apiKey = config?.apiKey ?? process.env.PERPLEXITY_API_KEY;

    try {
      const mod = _require("@perplexity-ai/perplexity_ai");
      const Perplexity = mod.default ?? mod;
      this.client = new Perplexity({ apiKey });
      this.mode = "native";
    } catch {
      try {
        const omod = _require("openai");
        const OpenAI = omod.default ?? omod;
        this.client = new OpenAI({
          apiKey,
          baseURL: config?.baseURL ?? "https://api.perplexity.ai",
        });
        this.mode = "openai-compat";
      } catch {
        throw new Error(
          "Either @perplexity-ai/perplexity_ai or openai package is required for PerplexityProvider. " +
            "Install one: npm install @perplexity-ai/perplexity_ai  or  npm install openai",
        );
      }
    }
  }

  async generate(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): Promise<ModelResponse> {
    if (this.mode === "openai-compat") return this.generateOpenAI(messages, options);
    return this.generateNative(messages, options);
  }

  async *stream(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): AsyncGenerator<StreamChunk> {
    if (this.mode === "openai-compat") yield* this.streamOpenAI(messages, options);
    else yield* this.streamNative(messages, options);
  }

  // ── Native Perplexity SDK ──────────────────────────────────────────

  private buildNativeParams(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): Record<string, unknown> {
    const params: Record<string, unknown> = {
      model: this.modelId,
      messages: this.toPerplexityMessages(messages),
    };

    if (options?.temperature !== undefined) params.temperature = options.temperature;
    if (options?.maxTokens !== undefined) params.max_tokens = options.maxTokens;
    if (options?.topP !== undefined) params.top_p = options.topP;
    if (options?.stop) params.stop = options.stop;
    if (options?.responseFormat === "json") {
      params.response_format = { type: "json_schema", json_schema: { schema: { type: "object" }, name: "response" } };
    } else if (typeof options?.responseFormat === "object") {
      params.response_format = {
        type: "json_schema",
        json_schema: {
          name: options.responseFormat.name ?? "response",
          schema: options.responseFormat.schema,
          strict: true,
        },
      };
    }

    const search = this.searchOptions;
    if (search) {
      if (search.searchMode) params.search_mode = search.searchMode;
      if (search.searchDomainFilter?.length) params.search_domain_filter = search.searchDomainFilter;
      if (search.searchRecencyFilter) params.search_recency_filter = search.searchRecencyFilter;
      if (search.searchAfterDate) params.search_after_date_filter = search.searchAfterDate;
      if (search.searchBeforeDate) params.search_before_date_filter = search.searchBeforeDate;
      if (search.returnImages !== undefined) params.return_images = search.returnImages;
      if (search.returnRelatedQuestions !== undefined) params.return_related_questions = search.returnRelatedQuestions;
      if (search.disableSearch !== undefined) params.disable_search = search.disableSearch;
      if (search.searchContextSize) {
        params.web_search_options = { search_context_size: search.searchContextSize };
      }
    }

    return params;
  }

  private async generateNative(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): Promise<ModelResponse> {
    const params = this.buildNativeParams(messages, options);
    const response = await this.client.chat.completions.create(params);
    return this.normalizeNative(response);
  }

  private async *streamNative(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): AsyncGenerator<StreamChunk> {
    const params = this.buildNativeParams(messages, options);
    params.stream = true;

    const stream = await this.client.chat.completions.create(params);

    let finishReason: string | null = null;

    for await (const chunk of stream as any) {
      const choice = chunk.choices?.[0];
      if (!choice) {
        if (chunk.usage && finishReason) {
          yield {
            type: "finish",
            finishReason: finishReason ?? "stop",
            usage: {
              promptTokens: chunk.usage.prompt_tokens ?? 0,
              completionTokens: chunk.usage.completion_tokens ?? 0,
              totalTokens: chunk.usage.total_tokens ?? 0,
              providerMetrics: { ...chunk.usage },
            },
          };
        }
        continue;
      }

      const delta = choice.delta;
      if (delta?.content) yield { type: "text", text: delta.content };

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
        if (chunk.usage) {
          yield {
            type: "finish",
            finishReason: finishReason ?? "stop",
            usage: {
              promptTokens: chunk.usage.prompt_tokens ?? 0,
              completionTokens: chunk.usage.completion_tokens ?? 0,
              totalTokens: chunk.usage.total_tokens ?? 0,
              providerMetrics: { ...chunk.usage },
            },
          };
          finishReason = null;
        }
      }
    }

    if (finishReason) yield { type: "finish" as const, finishReason, usage: undefined };
  }

  private toPerplexityMessages(messages: ChatMessage[]): unknown[] {
    return messages.map((msg) => {
      if (msg.role === "assistant" && msg.toolCalls?.length) {
        return {
          role: "assistant",
          content: getTextContent(msg.content),
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        };
      }
      if (msg.role === "tool") {
        return { role: "tool", tool_call_id: msg.toolCallId, content: getTextContent(msg.content) };
      }
      if (isMultiModal(msg.content)) {
        return { role: msg.role, content: msg.content.map((p) => this.partToPerplexity(p)) };
      }
      return { role: msg.role, content: msg.content ?? "" };
    });
  }

  private partToPerplexity(part: ContentPart): unknown {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text };
      case "image": {
        const isUrl = part.data.startsWith("http://") || part.data.startsWith("https://");
        return {
          type: "image_url",
          image_url: { url: isUrl ? part.data : `data:${part.mimeType ?? "image/png"};base64,${part.data}` },
        };
      }
      default:
        return { type: "text", text: `[${part.type} content — not supported by Perplexity]` };
    }
  }

  private normalizeNative(response: any): ModelResponse {
    const choice = response.choices?.[0];
    const msg = choice?.message;

    const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((tc: any) => {
      const fn = tc.function ?? {};
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(fn.arguments || "{}");
      } catch {
        /* ignore */
      }
      return { id: tc.id, name: fn.name, arguments: args };
    });

    const u = response.usage;
    const usage: TokenUsage = {
      promptTokens: u?.prompt_tokens ?? 0,
      completionTokens: u?.completion_tokens ?? 0,
      totalTokens: u?.total_tokens ?? 0,
      providerMetrics: u ? { ...u } : undefined,
    };

    const fr = choice?.finish_reason;
    let finishReason: ModelResponse["finishReason"] = "stop";
    if (fr === "tool_calls") finishReason = "tool_calls";
    else if (fr === "length") finishReason = "length";

    return {
      message: {
        role: "assistant",
        content: msg?.content ?? null,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      usage,
      finishReason,
      raw: response,
    };
  }

  // ── OpenAI-compat fallback ──────────────────────────────────────────

  private async generateOpenAI(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): Promise<ModelResponse> {
    const params: Record<string, unknown> = {
      model: this.modelId,
      messages: this.toPerplexityMessages(messages),
    };
    if (options?.temperature !== undefined) params.temperature = options.temperature;
    if (options?.maxTokens !== undefined) params.max_tokens = options.maxTokens;
    if (options?.topP !== undefined) params.top_p = options.topP;
    if (options?.stop) params.stop = options.stop;
    if (options?.responseFormat === "json") {
      params.response_format = { type: "json_object" };
    }

    const response = await this.client.chat.completions.create(params);
    return this.normalizeOpenAI(response);
  }

  private async *streamOpenAI(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): AsyncGenerator<StreamChunk> {
    const params: Record<string, unknown> = {
      model: this.modelId,
      messages: this.toPerplexityMessages(messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (options?.temperature !== undefined) params.temperature = options.temperature;
    if (options?.maxTokens !== undefined) params.max_tokens = options.maxTokens;
    if (options?.topP !== undefined) params.top_p = options.topP;
    if (options?.stop) params.stop = options.stop;
    if (options?.responseFormat === "json") {
      params.response_format = { type: "json_object" };
    }

    const stream = await this.client.chat.completions.create(params);
    let finishReason: string | null = null;

    for await (const chunk of stream as any) {
      const choice = chunk.choices?.[0];
      if (!choice) {
        if (chunk.usage && finishReason) {
          yield {
            type: "finish",
            finishReason: finishReason ?? "stop",
            usage: {
              promptTokens: chunk.usage.prompt_tokens ?? 0,
              completionTokens: chunk.usage.completion_tokens ?? 0,
              totalTokens: chunk.usage.total_tokens ?? 0,
              providerMetrics: { ...chunk.usage },
            },
          };
        }
        continue;
      }

      const delta = choice.delta;
      if (delta?.content) yield { type: "text", text: delta.content };

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
        if (chunk.usage) {
          yield {
            type: "finish",
            finishReason: finishReason ?? "stop",
            usage: {
              promptTokens: chunk.usage.prompt_tokens ?? 0,
              completionTokens: chunk.usage.completion_tokens ?? 0,
              totalTokens: chunk.usage.total_tokens ?? 0,
              providerMetrics: { ...chunk.usage },
            },
          };
          finishReason = null;
        }
      }
    }

    if (finishReason) yield { type: "finish" as const, finishReason, usage: undefined };
  }

  private normalizeOpenAI(response: any): ModelResponse {
    const choice = response.choices[0];
    const msg = choice.message;

    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc: any) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        /* ignore */
      }
      return { id: tc.id, name: tc.function.name, arguments: args };
    });

    const usage: TokenUsage = {
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0,
      providerMetrics: response.usage ? { ...response.usage } : undefined,
    };

    let finishReason: ModelResponse["finishReason"] = "stop";
    if (choice.finish_reason === "tool_calls") finishReason = "tool_calls";
    else if (choice.finish_reason === "length") finishReason = "length";

    return {
      message: {
        role: "assistant",
        content: msg.content ?? null,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      usage,
      finishReason,
      raw: response,
    };
  }
}
