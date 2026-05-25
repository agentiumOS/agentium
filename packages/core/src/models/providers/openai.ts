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
    const params: Record<string, unknown> = {
      model: this.modelId,
      messages: this.toOpenAIMessages(messages),
    };

    if (options?.reasoning?.enabled) {
      params.reasoning_effort = options.reasoning.effort ?? "medium";
    } else {
      if (options?.temperature !== undefined) params.temperature = options.temperature;
    }
    if (options?.maxTokens !== undefined) {
      // OpenAI Chat Completions accepts max_completion_tokens for ALL models
      // (both reasoning and non-reasoning) on current API versions. The
      // legacy max_tokens parameter is rejected by reasoning models like
      // o1/o3/o4/o5/gpt-5/gpt-5-mini. Always use the new name.
      params.max_completion_tokens = options.maxTokens;
    }
    if (options?.topP !== undefined) params.top_p = options.topP;
    if (options?.stop) params.stop = options.stop;
    this.applyResponseFormat(params, options);
    if (options?.tools?.length) {
      params.tools = this.toOpenAITools(options.tools);
    }

    const client = this.getClient(options?.apiKey);
    const response = await this.withRetry(() => client.chat.completions.create(params));
    return this.normalizeResponse(response);
  }

  async *stream(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): AsyncGenerator<StreamChunk> {
    const params: Record<string, unknown> = {
      model: this.modelId,
      messages: this.toOpenAIMessages(messages),
      stream: true,
      stream_options: { include_usage: true },
    };

    if (options?.reasoning?.enabled) {
      params.reasoning_effort = options.reasoning.effort ?? "medium";
    } else {
      if (options?.temperature !== undefined) params.temperature = options.temperature;
    }
    if (options?.maxTokens !== undefined) {
      // OpenAI Chat Completions accepts max_completion_tokens for ALL models
      // (both reasoning and non-reasoning) on current API versions. The
      // legacy max_tokens parameter is rejected by reasoning models like
      // o1/o3/o4/o5/gpt-5/gpt-5-mini. Always use the new name.
      params.max_completion_tokens = options.maxTokens;
    }
    if (options?.topP !== undefined) params.top_p = options.topP;
    if (options?.stop) params.stop = options.stop;
    this.applyResponseFormat(params, options);
    if (options?.tools?.length) {
      params.tools = this.toOpenAITools(options.tools);
    }

    const client = this.getClient(options?.apiKey);
    const stream = await this.withRetry<any>(() => client.chat.completions.create(params));

    const activeToolCalls = new Map<number, { id: string; name: string; args: string }>();

    let finishReason: string | null = null;

    for await (const chunk of stream) {
      // OpenAI sends usage in a final chunk with empty choices when
      // stream_options.include_usage is true. Emit the deferred finish
      // with the usage data.
      const choice = chunk.choices?.[0];
      if (!choice) {
        if (chunk.usage && finishReason) {
          const reasoningTkns = chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0;
          const cachedTkns = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
          const audioInTkns = chunk.usage.prompt_tokens_details?.audio_tokens ?? 0;
          const audioOutTkns = chunk.usage.completion_tokens_details?.audio_tokens ?? 0;
          yield {
            type: "finish",
            finishReason: finishReason === "tool_calls" ? "tool_calls" : finishReason,
            usage: {
              promptTokens: chunk.usage.prompt_tokens ?? 0,
              completionTokens: chunk.usage.completion_tokens ?? 0,
              totalTokens: chunk.usage.total_tokens ?? 0,
              ...(reasoningTkns > 0 ? { reasoningTokens: reasoningTkns } : {}),
              ...(cachedTkns > 0 ? { cachedTokens: cachedTkns } : {}),
              ...(audioInTkns > 0 ? { audioInputTokens: audioInTkns } : {}),
              ...(audioOutTkns > 0 ? { audioOutputTokens: audioOutTkns } : {}),
              providerMetrics: { ...chunk.usage },
            },
          };
        }
        continue;
      }

      const delta = choice.delta;

      if (delta?.content) {
        yield { type: "text", text: delta.content };
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;

          if (tc.id) {
            activeToolCalls.set(idx, {
              id: tc.id,
              name: tc.function?.name ?? "",
              args: tc.function?.arguments ?? "",
            });
            yield {
              type: "tool_call_start",
              toolCall: {
                id: tc.id,
                name: tc.function?.name ?? "",
              },
            };
          } else if (tc.function?.arguments) {
            const existing = activeToolCalls.get(idx);
            if (existing) {
              existing.args += tc.function.arguments;
              yield {
                type: "tool_call_delta",
                toolCallId: existing.id,
                argumentsDelta: tc.function.arguments,
              };
            }
          }

          if (tc.function?.name && !tc.id) {
            const existing = activeToolCalls.get(idx);
            if (existing) {
              existing.name = tc.function.name;
            }
          }
        }
      }

      if (delta?.reasoning_content) {
        yield { type: "thinking", text: delta.reasoning_content };
      }

      if (choice.finish_reason) {
        for (const [, tc] of activeToolCalls) {
          yield { type: "tool_call_end", toolCallId: tc.id };
        }
        const reason: string = choice.finish_reason;
        finishReason = reason;

        // If usage arrived on the same chunk (some providers), emit finish now
        if (chunk.usage) {
          const reasoningTkns = chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0;
          yield {
            type: "finish",
            finishReason: reason === "tool_calls" ? "tool_calls" : reason,
            usage: {
              promptTokens: chunk.usage.prompt_tokens ?? 0,
              completionTokens: chunk.usage.completion_tokens ?? 0,
              totalTokens: chunk.usage.total_tokens ?? 0,
              ...(reasoningTkns > 0 ? { reasoningTokens: reasoningTkns } : {}),
              providerMetrics: { ...chunk.usage },
            },
          };
          finishReason = null;
        }
      }
    }

    // Fallback: if we got finish_reason but never got a usage chunk
    if (finishReason) {
      yield { type: "finish" as const, finishReason, usage: undefined };
    }
  }

  private applyResponseFormat(params: Record<string, unknown>, options?: ModelConfig): void {
    if (!options?.responseFormat) return;
    if (options.responseFormat === "json") {
      params.response_format = { type: "json_object" };
    } else if (options.responseFormat === "text") {
      // default
    } else if (typeof options.responseFormat === "object") {
      params.response_format = {
        type: "json_schema",
        json_schema: {
          name: options.responseFormat.name ?? "response",
          schema: options.responseFormat.schema,
          strict: true,
        },
      };
    }
  }

  private toOpenAIMessages(messages: ChatMessage[]): unknown[] {
    return messages.map((msg) => {
      if (msg.role === "assistant" && msg.toolCalls?.length) {
        return {
          role: "assistant",
          content: getTextContent(msg.content),
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        };
      }

      if (msg.role === "tool") {
        return {
          role: "tool",
          tool_call_id: msg.toolCallId,
          content: getTextContent(msg.content),
        };
      }

      if (isMultiModal(msg.content)) {
        return {
          role: msg.role,
          content: msg.content.map((part) => this.partToOpenAI(part)),
        };
      }

      return {
        role: msg.role,
        content: msg.content ?? "",
      };
    });
  }

  private partToOpenAI(part: ContentPart): unknown {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text };
      case "image": {
        const isUrl = part.data.startsWith("http://") || part.data.startsWith("https://");
        return {
          type: "image_url",
          image_url: {
            url: isUrl ? part.data : `data:${part.mimeType ?? "image/png"};base64,${part.data}`,
          },
        };
      }
      case "audio":
        return {
          type: "input_audio",
          input_audio: {
            data: part.data,
            format: part.mimeType?.split("/")[1] ?? "mp3",
          },
        };
      case "file": {
        const isFileUrl = part.data.startsWith("http://") || part.data.startsWith("https://");
        return {
          type: "file",
          file: {
            filename: part.filename ?? "attachment",
            file_data: isFileUrl ? part.data : `data:${part.mimeType};base64,${part.data}`,
          },
        };
      }
    }
  }

  private toOpenAITools(tools: ToolDefinition[]): unknown[] {
    return tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        ...(t.strict ? { strict: true } : {}),
      },
    }));
  }

  private normalizeResponse(response: any): ModelResponse & { thinking?: string } {
    const choice = response.choices[0];
    const msg = choice.message;

    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc: any) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch (err) {
        console.warn("[agentium/openai] Error:", err instanceof Error ? err.message : err);
      }
      return {
        id: tc.id,
        name: tc.function.name,
        arguments: args,
      };
    });

    const reasoningTokens = response.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const audioInputTokens = response.usage?.prompt_tokens_details?.audio_tokens ?? 0;
    const audioOutputTokens = response.usage?.completion_tokens_details?.audio_tokens ?? 0;
    const usage: TokenUsage = {
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0,
      ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
      ...(cachedTokens > 0 ? { cachedTokens } : {}),
      ...(audioInputTokens > 0 ? { audioInputTokens } : {}),
      ...(audioOutputTokens > 0 ? { audioOutputTokens } : {}),
      providerMetrics: response.usage ? { ...response.usage } : undefined,
    };

    let finishReason: ModelResponse["finishReason"] = "stop";
    if (choice.finish_reason === "tool_calls") finishReason = "tool_calls";
    else if (choice.finish_reason === "length") finishReason = "length";
    else if (choice.finish_reason === "content_filter") finishReason = "content_filter";

    const result: ModelResponse & { thinking?: string } = {
      message: {
        role: "assistant",
        content: msg.content ?? null,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      usage,
      finishReason,
      raw: response,
    };

    if (msg.reasoning_content) {
      result.thinking = msg.reasoning_content;
    }

    return result;
  }
}
