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
 * Azure AI Foundry exposes an OpenAI-compatible API.
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
    const params: Record<string, unknown> = {
      model: this.modelId,
      messages: this.toMessages(messages),
    };

    if (options?.temperature !== undefined) params.temperature = options.temperature;
    if (options?.maxTokens !== undefined) params.max_tokens = options.maxTokens;
    if (options?.topP !== undefined) params.top_p = options.topP;
    if (options?.stop) params.stop = options.stop;
    if (options?.responseFormat === "json") {
      params.response_format = { type: "json_object" };
    }
    if (options?.tools?.length) {
      params.tools = this.toTools(options.tools);
    }

    const response = await this.withRetry(() => this.client.chat.completions.create(params));
    return this.normalizeResponse(response);
  }

  async *stream(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): AsyncGenerator<StreamChunk> {
    const params: Record<string, unknown> = {
      model: this.modelId,
      messages: this.toMessages(messages),
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
    if (options?.tools?.length) {
      params.tools = this.toTools(options.tools);
    }

    const stream = await this.withRetry<any>(() => this.client.chat.completions.create(params));

    const activeToolCalls = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: string | null = null;

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      if (!choice) {
        if (chunk.usage && finishReason) {
          yield {
            type: "finish",
            finishReason: finishReason === "tool_calls" ? "tool_calls" : finishReason,
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

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (tc.id) {
            activeToolCalls.set(idx, { id: tc.id, name: tc.function?.name ?? "", args: tc.function?.arguments ?? "" });
            yield { type: "tool_call_start", toolCall: { id: tc.id, name: tc.function?.name ?? "" } };
          } else if (tc.function?.arguments) {
            const existing = activeToolCalls.get(idx);
            if (existing) {
              existing.args += tc.function.arguments;
              yield { type: "tool_call_delta", toolCallId: existing.id, argumentsDelta: tc.function.arguments };
            }
          }
        }
      }

      if (choice.finish_reason) {
        for (const [, tc] of activeToolCalls) {
          yield { type: "tool_call_end", toolCallId: tc.id };
        }
        finishReason = choice.finish_reason;
        if (chunk.usage) {
          const reason = finishReason!;
          yield {
            type: "finish",
            finishReason: reason === "tool_calls" ? "tool_calls" : reason,
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

    if (finishReason) {
      yield { type: "finish" as const, finishReason, usage: undefined };
    }
  }

  private toMessages(messages: ChatMessage[]): unknown[] {
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
        return { role: msg.role, content: msg.content.map((part) => this.partToMessage(part)) };
      }
      return { role: msg.role, content: msg.content ?? "" };
    });
  }

  private partToMessage(part: ContentPart): unknown {
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
      case "audio":
        console.warn("[agentium/azure-foundry] Audio input may not be supported by all Azure AI Foundry models.");
        return { type: "text", text: "[Audio content — model may not support audio input]" };
      case "file":
        console.warn("[agentium/azure-foundry] File input may not be supported by all Azure AI Foundry models.");
        return { type: "text", text: `[File: ${part.filename ?? "attachment"}]` };
    }
  }

  private toTools(tools: ToolDefinition[]): unknown[] {
    return tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  private normalizeResponse(response: any): ModelResponse {
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
    else if (choice.finish_reason === "content_filter") finishReason = "content_filter";

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
