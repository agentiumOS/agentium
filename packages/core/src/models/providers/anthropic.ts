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

interface AnthropicConfig {
  apiKey?: string;
}

/**
 * Newer Claude models with extended thinking on by default have deprecated
 * arbitrary `temperature`. Sending any value (including 0) returns a 400:
 *   "temperature is deprecated for this model"
 *
 * Detected families (covers current + forward-compatible aliases):
 *   - claude-opus-4*       (4, 4.1, 4.5, 4.6, 4.7, ...)
 *   - claude-sonnet-4.5+   (4.5 and later 4.x)
 *   - claude-haiku-4.5+    (4.5 and later 4.x)
 *   - claude-*-5.x         (whole Claude 5 family)
 */
function isAnthropicReasoningOnlyTempModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  if (id.startsWith("claude-opus-4")) return true;
  if (/^claude-sonnet-4\.(?:[5-9]|\d{2,})/.test(id)) return true;
  if (/^claude-haiku-4\.(?:[5-9]|\d{2,})/.test(id)) return true;
  if (/^claude-(opus|sonnet|haiku)-5/.test(id)) return true;
  return false;
}

export class AnthropicProvider implements ModelProvider {
  readonly providerId = "anthropic";
  readonly modelId: string;
  private client: any;
  private AnthropicCtor: any;
  private clientCache = new Map<string, any>();

  constructor(modelId: string, config?: AnthropicConfig) {
    this.modelId = modelId;
    try {
      const mod = _require("@anthropic-ai/sdk");
      this.AnthropicCtor = mod.default ?? mod;
      const key = config?.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (key) {
        this.client = new this.AnthropicCtor({ apiKey: key });
      }
    } catch (e: any) {
      if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error(
          "@anthropic-ai/sdk is required for AnthropicProvider. Install it: npm install @anthropic-ai/sdk",
        );
      }
      throw e;
    }
  }

  private getClient(apiKey?: string): any {
    if (apiKey) {
      let cached = this.clientCache.get(apiKey);
      if (!cached) {
        cached = new this.AnthropicCtor({ apiKey });
        this.clientCache.set(apiKey, cached);
        if (this.clientCache.size > 50) {
          const oldest = this.clientCache.keys().next().value;
          if (oldest) this.clientCache.delete(oldest);
        }
      }
      return cached;
    }
    if (this.client) return this.client;
    const envKey = process.env.ANTHROPIC_API_KEY;
    if (envKey) {
      this.client = new this.AnthropicCtor({ apiKey: envKey });
      return this.client;
    }
    throw new Error(
      "No Anthropic API key provided. Pass it via the x-anthropic-api-key header, apiKey in request body, or set ANTHROPIC_API_KEY env var.",
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
    const { systemMsg, anthropicMessages } = this.toAnthropicMessages(messages);

    let maxTokens = options?.maxTokens ?? 4096;
    const thinkingBudget = options?.reasoning?.enabled ? (options.reasoning.budgetTokens ?? 10000) : 0;
    if (thinkingBudget > 0 && maxTokens < thinkingBudget + 1024) {
      maxTokens = thinkingBudget + 4096;
    }

    const params: Record<string, unknown> = {
      model: this.modelId,
      messages: anthropicMessages,
      max_tokens: maxTokens,
    };

    // Newer Claude models (Opus 4.x, Sonnet 4.5+, Haiku 4.5+) have deprecated
    // arbitrary temperature — only the default is accepted. Detect by ID and
    // drop the field so callers can keep passing temperature: 0 elsewhere.
    const supportsTemperature = !isAnthropicReasoningOnlyTempModel(this.modelId);

    if (systemMsg) params.system = systemMsg;
    if (supportsTemperature && options?.temperature !== undefined) params.temperature = options.temperature;
    if (options?.topP !== undefined) params.top_p = options.topP;
    if (options?.stop) params.stop_sequences = options.stop;
    if (options?.tools?.length) {
      params.tools = this.toAnthropicTools(options.tools);
    }
    if (options?.reasoning?.enabled) {
      params.thinking = {
        type: "enabled",
        budget_tokens: thinkingBudget,
      };
      delete params.temperature;
    }

    const client = this.getClient(options?.apiKey);
    const response = await this.withRetry(() => client.messages.create(params));
    return this.normalizeResponse(response);
  }

  async *stream(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): AsyncGenerator<StreamChunk> {
    const { systemMsg, anthropicMessages } = this.toAnthropicMessages(messages);

    let maxTokens = options?.maxTokens ?? 4096;
    const thinkingBudget = options?.reasoning?.enabled ? (options.reasoning.budgetTokens ?? 10000) : 0;
    if (thinkingBudget > 0 && maxTokens < thinkingBudget + 1024) {
      maxTokens = thinkingBudget + 4096;
    }

    const params: Record<string, unknown> = {
      model: this.modelId,
      messages: anthropicMessages,
      max_tokens: maxTokens,
      stream: true,
    };

    const supportsTemperature = !isAnthropicReasoningOnlyTempModel(this.modelId);

    if (systemMsg) params.system = systemMsg;
    if (supportsTemperature && options?.temperature !== undefined) params.temperature = options.temperature;
    if (options?.topP !== undefined) params.top_p = options.topP;
    if (options?.stop) params.stop_sequences = options.stop;
    if (options?.tools?.length) {
      params.tools = this.toAnthropicTools(options.tools);
    }
    if (options?.reasoning?.enabled) {
      params.thinking = {
        type: "enabled",
        budget_tokens: thinkingBudget,
      };
      delete params.temperature;
    }

    const client = this.getClient(options?.apiKey);
    const stream = await this.withRetry<any>(() => client.messages.create(params));

    let currentToolId = "";
    let inThinkingBlock = false;
    let inputTokens = 0;

    for await (const event of stream) {
      switch (event.type) {
        case "content_block_start": {
          if (event.content_block?.type === "tool_use") {
            currentToolId = event.content_block.id;
            yield {
              type: "tool_call_start",
              toolCall: {
                id: event.content_block.id,
                name: event.content_block.name,
              },
            };
          } else if (event.content_block?.type === "thinking") {
            inThinkingBlock = true;
          }
          break;
        }
        case "content_block_delta": {
          if (event.delta?.type === "thinking_delta") {
            yield { type: "thinking", text: event.delta.thinking };
          } else if (event.delta?.type === "text_delta") {
            yield { type: "text", text: event.delta.text };
          } else if (event.delta?.type === "input_json_delta") {
            yield {
              type: "tool_call_delta",
              toolCallId: currentToolId,
              argumentsDelta: event.delta.partial_json,
            };
          }
          break;
        }
        case "content_block_stop": {
          if (inThinkingBlock) {
            inThinkingBlock = false;
          } else if (currentToolId) {
            yield { type: "tool_call_end", toolCallId: currentToolId };
            currentToolId = "";
          }
          break;
        }
        case "message_delta": {
          const usage: TokenUsage | undefined = event.usage
            ? {
                promptTokens: inputTokens,
                completionTokens: event.usage.output_tokens ?? 0,
                totalTokens: inputTokens + (event.usage.output_tokens ?? 0),
                providerMetrics: { input_tokens: inputTokens, ...event.usage },
              }
            : undefined;

          let finishReason = event.delta?.stop_reason ?? "stop";
          if (finishReason === "tool_use") finishReason = "tool_calls";
          if (finishReason === "end_turn") finishReason = "stop";

          yield { type: "finish", finishReason, usage };
          break;
        }
        case "message_start": {
          if (event.message?.usage) {
            inputTokens = event.message.usage.input_tokens ?? 0;
          }
          break;
        }
      }
    }
  }

  private toAnthropicMessages(messages: ChatMessage[]): {
    systemMsg: string | undefined;
    anthropicMessages: unknown[];
  } {
    let systemMsg: string | undefined;
    const anthropicMessages: unknown[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        systemMsg = getTextContent(msg.content) || undefined;
        continue;
      }

      if (msg.role === "user") {
        if (isMultiModal(msg.content)) {
          anthropicMessages.push({
            role: "user",
            content: msg.content.map((p) => this.partToAnthropic(p)),
          });
        } else {
          anthropicMessages.push({
            role: "user",
            content: [{ type: "text", text: msg.content ?? "" }],
          });
        }
        continue;
      }

      if (msg.role === "assistant") {
        const content: unknown[] = [];
        if (msg.content) {
          content.push({ type: "text", text: msg.content });
        }
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            content.push({
              type: "tool_use",
              id: tc.id,
              name: tc.name,
              input: tc.arguments,
            });
          }
        }
        anthropicMessages.push({
          role: "assistant",
          content: content.length > 0 ? content : [{ type: "text", text: "" }],
        });
        continue;
      }

      if (msg.role === "tool") {
        anthropicMessages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.toolCallId,
              content: msg.content ?? "",
            },
          ],
        });
      }
    }

    return { systemMsg, anthropicMessages };
  }

  private partToAnthropic(part: ContentPart): unknown {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text };
      case "image": {
        const isUrl = part.data.startsWith("http://") || part.data.startsWith("https://");
        if (isUrl) {
          return { type: "image", source: { type: "url", url: part.data } };
        }
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: part.mimeType ?? "image/png",
            data: part.data,
          },
        };
      }
      case "audio":
        console.warn("[agentium/anthropic] Audio input is not supported by Anthropic. Skipping audio content.");
        return { type: "text", text: "[Audio content not supported by this model]" };
      case "file": {
        const isFileUrl = part.data.startsWith("http://") || part.data.startsWith("https://");
        if (isFileUrl) {
          return {
            type: "document",
            source: { type: "url", url: part.data },
          };
        }
        const mediaType = part.mimeType?.startsWith("text/") ? "text" : "base64";
        return {
          type: "document",
          source: { type: mediaType, media_type: part.mimeType, data: part.data },
        };
      }
    }
  }

  private toAnthropicTools(tools: ToolDefinition[]): unknown[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  private normalizeResponse(response: any): ModelResponse & { thinking?: string } {
    const toolCalls: ToolCall[] = [];
    let textContent = "";
    let thinkingContent = "";

    for (const block of response.content ?? []) {
      if (block.type === "text") {
        textContent += block.text;
      } else if (block.type === "thinking") {
        thinkingContent += block.thinking;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input ?? {},
        });
      }
    }

    const cachedTokens = (response.usage as any)?.cache_read_input_tokens ?? 0;
    const usage: TokenUsage = {
      promptTokens: response.usage?.input_tokens ?? 0,
      completionTokens: response.usage?.output_tokens ?? 0,
      totalTokens: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
      ...(cachedTokens > 0 ? { cachedTokens } : {}),
      providerMetrics: response.usage ? { ...response.usage } : undefined,
    };

    let finishReason: ModelResponse["finishReason"] = "stop";
    if (response.stop_reason === "tool_use") finishReason = "tool_calls";
    else if (response.stop_reason === "max_tokens") finishReason = "length";

    const result: ModelResponse & { thinking?: string } = {
      message: {
        role: "assistant",
        content: textContent || null,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      usage,
      finishReason,
      raw: response,
    };

    if (thinkingContent) {
      result.thinking = thinkingContent;
    }

    return result;
  }
}
