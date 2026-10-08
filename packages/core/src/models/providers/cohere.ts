import { createRequire } from "node:module";
import { generateOpenAIStyle, streamOpenAIStyle } from "../openai-api.js";
import type { ModelProvider } from "../provider.js";
import {
  type ChatMessage,
  getTextContent,
  isMultiModal,
  type ModelConfig,
  type ModelResponse,
  type StreamChunk,
  type ToolCall,
  type ToolDefinition,
} from "../types.js";
import { providerTokenUsage, safeResponseContext } from "../usage-normalizers.js";

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
    if (options?.reasoning) {
      params.thinking = {
        type: options.reasoning.enabled && options.reasoning.effort !== "none" ? "enabled" : "disabled",
        ...(options.reasoning.budgetTokens ? { tokenBudget: options.reasoning.budgetTokens } : {}),
      };
    }

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
    if (options?.reasoning) {
      params.thinking = {
        type: options.reasoning.enabled && options.reasoning.effort !== "none" ? "enabled" : "disabled",
        ...(options.reasoning.budgetTokens ? { tokenBudget: options.reasoning.budgetTokens } : {}),
      };
    }

    const stream = await this.client.chatStream(params);

    const toolCallsAcc: { id: string; name: string; args: string }[] = [];

    for await (const event of stream) {
      if (event.type === "content-delta") {
        const text = event.delta?.message?.content?.text;
        if (text) yield { type: "text", text };
        const thought = event.delta?.message?.content?.thinking;
        if (thought) yield { type: "thinking", text: thought };
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
          usage: usage ? providerTokenUsage(this.providerId, "chat-v2", usage, { modelId: this.modelId }) : undefined,
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
    const usage = providerTokenUsage(
      this.providerId,
      "chat-v2",
      response.usage ??
        (response.meta
          ? { tokens: response.meta.tokens, billedUnits: response.meta.billedUnits ?? response.meta.billed_units }
          : undefined),
      { modelId: this.modelId, ...safeResponseContext(response) },
    );
    const msg = response.message ?? response;
    let thinking = "";
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part?.thinking === "string") thinking += part.thinking;
      }
    }
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

    const result: ModelResponse & { thinking?: string } = {
      message: { role: "assistant", content, toolCalls: toolCalls.length > 0 ? toolCalls : undefined },
      usage,
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
      raw: response,
    };
    if (thinking) result.thinking = thinking;
    return result;
  }

  // ── OpenAI-compat fallback ──────────────────────────────────────────

  private async generateOpenAI(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): Promise<ModelResponse> {
    return generateOpenAIStyle(this.client, this.modelId, messages, options, undefined, {
      providerId: this.providerId,
    });
  }

  private async *streamOpenAI(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): AsyncGenerator<StreamChunk> {
    yield* streamOpenAIStyle(this.client, this.modelId, messages, options, undefined, { providerId: this.providerId });
  }
}
