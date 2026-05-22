import { createRequire } from "node:module";
import type { ModelProvider } from "../provider.js";
import {
  type ChatMessage,
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

export interface CohereConfig {
  apiKey?: string;
}

/**
 * Cohere provider using the `cohere-ai` SDK (v2 Chat API).
 *
 * Falls back to the `openai` SDK pointed at Cohere's OpenAI-compatible
 * endpoint if the native SDK is not installed.
 */
export class CohereProvider implements ModelProvider {
  readonly providerId = "cohere";
  readonly modelId: string;
  private client: any;
  private mode: "native" | "openai-compat";

  constructor(modelId: string, config?: CohereConfig) {
    this.modelId = modelId;
    const apiKey = config?.apiKey ?? process.env.CO_API_KEY;

    try {
      const mod = _require("cohere-ai");
      const CohereClientV2 = mod.CohereClientV2 ?? mod.CohereClient ?? mod.default ?? mod;
      this.client = new CohereClientV2({ token: apiKey });
      this.mode = "native";
    } catch {
      try {
        const omod = _require("openai");
        const OpenAI = omod.default ?? omod;
        this.client = new OpenAI({ apiKey, baseURL: "https://api.cohere.com/compatibility/v1" });
        this.mode = "openai-compat";
      } catch {
        throw new Error(
          "Either cohere-ai or openai package is required for CohereProvider. " +
            "Install one: npm install cohere-ai  or  npm install openai",
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

  // ── Native Cohere v2 API ────────────────────────────────────────────

  private async generateNative(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): Promise<ModelResponse> {
    const params: Record<string, unknown> = {
      model: this.modelId,
      messages: this.toCohereMessages(messages),
    };
    if (options?.temperature !== undefined) params.temperature = options.temperature;
    if (options?.maxTokens !== undefined) params.maxTokens = options.maxTokens;
    if (options?.topP !== undefined) params.p = options.topP;
    if (options?.tools?.length) params.tools = this.toCohereTools(options.tools);

    const response = await this.client.chat(params);
    return this.normalizeNative(response);
  }

  private async *streamNative(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): AsyncGenerator<StreamChunk> {
    const params: Record<string, unknown> = {
      model: this.modelId,
      messages: this.toCohereMessages(messages),
    };
    if (options?.temperature !== undefined) params.temperature = options.temperature;
    if (options?.maxTokens !== undefined) params.maxTokens = options.maxTokens;
    if (options?.topP !== undefined) params.p = options.topP;
    if (options?.tools?.length) params.tools = this.toCohereTools(options.tools);

    const stream = await this.client.chatStream(params);

    const toolCallsAcc: { id: string; name: string; args: string }[] = [];

    for await (const event of stream) {
      if (event.type === "content-delta") {
        const text = event.delta?.message?.content?.text;
        if (text) yield { type: "text", text };
      }

      if (event.type === "tool-call-start") {
        const tc = event.delta?.message?.toolCalls;
        if (tc) {
          const call = {
            id: tc.id ?? `tc_${toolCallsAcc.length}`,
            name: tc.function?.name ?? "",
            args: tc.function?.arguments ?? "",
          };
          toolCallsAcc.push(call);
          yield { type: "tool_call_start", toolCall: { id: call.id, name: call.name } };
        }
      }

      if (event.type === "tool-call-delta") {
        const args = event.delta?.message?.toolCalls?.function?.arguments;
        if (args && toolCallsAcc.length) {
          const last = toolCallsAcc[toolCallsAcc.length - 1];
          last.args += args;
          yield { type: "tool_call_delta", toolCallId: last.id, argumentsDelta: args };
        }
      }

      if (event.type === "tool-call-end") {
        if (toolCallsAcc.length) {
          yield { type: "tool_call_end", toolCallId: toolCallsAcc[toolCallsAcc.length - 1].id };
        }
      }

      if (event.type === "message-end") {
        const usage = event.delta?.usage;
        yield {
          type: "finish",
          finishReason: toolCallsAcc.length > 0 ? "tool_calls" : "stop",
          usage: usage
            ? {
                promptTokens: usage.tokens?.inputTokens ?? 0,
                completionTokens: usage.tokens?.outputTokens ?? 0,
                totalTokens: (usage.tokens?.inputTokens ?? 0) + (usage.tokens?.outputTokens ?? 0),
                providerMetrics: usage.tokens ? { ...usage.tokens } : undefined,
              }
            : undefined,
        };
      }
    }
  }

  private toCohereMessages(messages: ChatMessage[]): unknown[] {
    return messages.map((msg) => {
      if (msg.role === "system") return { role: "system", content: getTextContent(msg.content) ?? "" };
      if (msg.role === "assistant" && msg.toolCalls?.length) {
        return {
          role: "assistant",
          content: getTextContent(msg.content) ?? "",
          toolCalls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        };
      }
      if (msg.role === "tool") {
        return { role: "tool", toolCallId: msg.toolCallId, content: getTextContent(msg.content) ?? "" };
      }
      if (isMultiModal(msg.content)) {
        return {
          role: msg.role,
          content: msg.content.map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join("\n"),
        };
      }
      return { role: msg.role, content: getTextContent(msg.content) ?? "" };
    });
  }

  private toCohereTools(tools: ToolDefinition[]): unknown[] {
    return tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  private normalizeNative(response: any): ModelResponse {
    const msg = response.message ?? response;
    const content = msg.content?.[0]?.text ?? msg.text ?? null;
    const rawToolCalls = msg.toolCalls ?? msg.tool_calls ?? [];

    const toolCalls: ToolCall[] = rawToolCalls.map((tc: any) => {
      const fn = tc.function ?? {};
      let args: Record<string, unknown> = {};
      try {
        args = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : (fn.arguments ?? {});
      } catch {
        /* ignore */
      }
      return { id: tc.id, name: fn.name, arguments: args };
    });

    const u = response.meta?.tokens ?? response.usage ?? {};
    const usage: TokenUsage = {
      promptTokens: u.inputTokens ?? u.prompt_tokens ?? 0,
      completionTokens: u.outputTokens ?? u.completion_tokens ?? 0,
      totalTokens: (u.inputTokens ?? u.prompt_tokens ?? 0) + (u.outputTokens ?? u.completion_tokens ?? 0),
      providerMetrics: { ...u },
    };

    return {
      message: { role: "assistant", content, toolCalls: toolCalls.length > 0 ? toolCalls : undefined },
      usage,
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
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
    if (options?.tools?.length) {
      params.tools = options.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const response = await this.client.chat.completions.create(params);
    const choice = response.choices[0];
    const m = choice.message;

    const toolCalls: ToolCall[] = (m.tool_calls ?? []).map((tc: any) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        /* ignore */
      }
      return { id: tc.id, name: tc.function.name, arguments: args };
    });

    return {
      message: {
        role: "assistant",
        content: m.content ?? null,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
        providerMetrics: response.usage ? { ...response.usage } : undefined,
      },
      finishReason: choice.finish_reason === "tool_calls" ? "tool_calls" : "stop",
      raw: response,
    };
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
      if (msg.role === "tool")
        return { role: "tool", tool_call_id: msg.toolCallId, content: getTextContent(msg.content) };
      return { role: msg.role, content: getTextContent(msg.content) ?? "" };
    });
  }
}
