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

export interface MistralConfig {
  apiKey?: string;
  baseURL?: string;
}

/**
 * Mistral provider using the `@mistralai/mistralai` SDK.
 *
 * Falls back to the `openai` SDK pointed at Mistral's OpenAI-compatible
 * endpoint (https://api.mistral.ai/v1) if the native SDK is not installed.
 */
export class MistralProvider implements ModelProvider {
  readonly providerId = "mistral";
  readonly modelId: string;
  private client: any;
  private mode: "native" | "openai-compat";

  constructor(modelId: string, config?: MistralConfig) {
    this.modelId = modelId;
    const apiKey = config?.apiKey ?? process.env.MISTRAL_API_KEY;
    const baseURL = config?.baseURL ?? "https://api.mistral.ai/v1";

    try {
      const mod = _require("@mistralai/mistralai");
      const Mistral = mod.Mistral ?? mod.default ?? mod;
      this.client = new Mistral({ apiKey });
      this.mode = "native";
    } catch {
      try {
        const omod = _require("openai");
        const OpenAI = omod.default ?? omod;
        this.client = new OpenAI({ apiKey, baseURL });
        this.mode = "openai-compat";
      } catch {
        throw new Error(
          "Either @mistralai/mistralai or openai package is required for MistralProvider. " +
            "Install one: npm install @mistralai/mistralai  or  npm install openai",
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

  // ── Native Mistral SDK ──────────────────────────────────────────────

  private async generateNative(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): Promise<ModelResponse> {
    const params: Record<string, unknown> = {
      model: this.modelId,
      messages: this.toMistralMessages(messages),
    };
    if (options?.temperature !== undefined) params.temperature = options.temperature;
    if (options?.maxTokens !== undefined) params.maxTokens = options.maxTokens;
    if (options?.topP !== undefined) params.topP = options.topP;
    if (options?.responseFormat === "json") params.responseFormat = { type: "json_object" };
    if (options?.tools?.length) params.tools = this.toMistralTools(options.tools);

    const response = await this.client.chat.complete(params);
    return this.normalizeNative(response);
  }

  private async *streamNative(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): AsyncGenerator<StreamChunk> {
    const params: Record<string, unknown> = {
      model: this.modelId,
      messages: this.toMistralMessages(messages),
    };
    if (options?.temperature !== undefined) params.temperature = options.temperature;
    if (options?.maxTokens !== undefined) params.maxTokens = options.maxTokens;
    if (options?.topP !== undefined) params.topP = options.topP;
    if (options?.responseFormat === "json") params.responseFormat = { type: "json_object" };
    if (options?.tools?.length) params.tools = this.toMistralTools(options.tools);

    const stream = await this.client.chat.stream(params);

    const activeToolCalls = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: string | null = null;

    for await (const event of stream) {
      const chunk = event.data ?? event;
      const choice = chunk.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta;
      if (delta?.content) yield { type: "text", text: delta.content };

      if (delta?.toolCalls || delta?.tool_calls) {
        for (const tc of delta.toolCalls ?? delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const fn = tc.function ?? {};
          if (tc.id) {
            activeToolCalls.set(idx, { id: tc.id, name: fn.name ?? "", args: fn.arguments ?? "" });
            yield { type: "tool_call_start", toolCall: { id: tc.id, name: fn.name ?? "" } };
          } else if (fn.arguments) {
            const existing = activeToolCalls.get(idx);
            if (existing) {
              existing.args += fn.arguments;
              yield { type: "tool_call_delta", toolCallId: existing.id, argumentsDelta: fn.arguments };
            }
          }
        }
      }

      if (choice.finishReason || choice.finish_reason) {
        for (const [, tc] of activeToolCalls) yield { type: "tool_call_end", toolCallId: tc.id };
        finishReason = choice.finishReason ?? choice.finish_reason;
        if (chunk.usage) {
          yield {
            type: "finish",
            finishReason: finishReason === "tool_calls" ? "tool_calls" : (finishReason ?? "stop"),
            usage: {
              promptTokens: chunk.usage.promptTokens ?? chunk.usage.prompt_tokens ?? 0,
              completionTokens: chunk.usage.completionTokens ?? chunk.usage.completion_tokens ?? 0,
              totalTokens: chunk.usage.totalTokens ?? chunk.usage.total_tokens ?? 0,
              providerMetrics: { ...chunk.usage },
            },
          };
          finishReason = null;
        }
      }
    }

    if (finishReason) yield { type: "finish" as const, finishReason, usage: undefined };
  }

  private toMistralMessages(messages: ChatMessage[]): unknown[] {
    return messages.map((msg) => {
      if (msg.role === "assistant" && msg.toolCalls?.length) {
        return {
          role: "assistant",
          content: getTextContent(msg.content),
          toolCalls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        };
      }
      if (msg.role === "tool") {
        return { role: "tool", toolCallId: msg.toolCallId, content: getTextContent(msg.content) };
      }
      if (isMultiModal(msg.content)) {
        return { role: msg.role, content: msg.content.map((p) => this.partToMistral(p)) };
      }
      return { role: msg.role, content: msg.content ?? "" };
    });
  }

  private partToMistral(part: ContentPart): unknown {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text };
      case "image": {
        const isUrl = part.data.startsWith("http://") || part.data.startsWith("https://");
        return {
          type: "image_url",
          imageUrl: { url: isUrl ? part.data : `data:${part.mimeType ?? "image/png"};base64,${part.data}` },
        };
      }
      default:
        return { type: "text", text: `[${part.type} content — not supported by Mistral]` };
    }
  }

  private toMistralTools(tools: ToolDefinition[]): unknown[] {
    return tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  private normalizeNative(response: any): ModelResponse {
    const choice = response.choices?.[0];
    const msg = choice?.message;

    const toolCalls: ToolCall[] = (msg?.toolCalls ?? msg?.tool_calls ?? []).map((tc: any) => {
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
      promptTokens: u?.promptTokens ?? u?.prompt_tokens ?? 0,
      completionTokens: u?.completionTokens ?? u?.completion_tokens ?? 0,
      totalTokens: u?.totalTokens ?? u?.total_tokens ?? 0,
      providerMetrics: u ? { ...u } : undefined,
    };

    const fr = choice?.finishReason ?? choice?.finish_reason;
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
      messages: this.toOpenAIMessages(messages),
    };
    if (options?.temperature !== undefined) params.temperature = options.temperature;
    if (options?.maxTokens !== undefined) params.max_tokens = options.maxTokens;
    if (options?.topP !== undefined) params.top_p = options.topP;
    if (options?.responseFormat === "json") params.response_format = { type: "json_object" };
    if (options?.tools?.length) {
      params.tools = options.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
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
      messages: this.toOpenAIMessages(messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (options?.temperature !== undefined) params.temperature = options.temperature;
    if (options?.maxTokens !== undefined) params.max_tokens = options.maxTokens;
    if (options?.topP !== undefined) params.top_p = options.topP;
    if (options?.responseFormat === "json") params.response_format = { type: "json_object" };
    if (options?.tools?.length) {
      params.tools = options.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const stream = await this.client.chat.completions.create(params);
    const activeToolCalls = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: string | null = null;

    for await (const chunk of stream as any) {
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
        for (const [, tc] of activeToolCalls) yield { type: "tool_call_end", toolCallId: tc.id };
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

    if (finishReason) yield { type: "finish" as const, finishReason, usage: undefined };
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
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        };
      }
      if (msg.role === "tool") {
        return { role: "tool", tool_call_id: msg.toolCallId, content: getTextContent(msg.content) };
      }
      if (isMultiModal(msg.content)) {
        return { role: msg.role, content: msg.content.map((p) => this.partToMistral(p)) };
      }
      return { role: msg.role, content: msg.content ?? "" };
    });
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
