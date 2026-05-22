import { createRequire } from "node:module";
import type { ModelProvider } from "../provider.js";
import type {
  ChatMessage,
  ModelConfig,
  ModelResponse,
  StreamChunk,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from "../types.js";
import { getTextContent, isMultiModal } from "../types.js";

const _require = createRequire(import.meta.url);

interface OllamaConfig {
  host?: string;
}

export class OllamaProvider implements ModelProvider {
  readonly providerId = "ollama";
  readonly modelId: string;
  private client: any;

  constructor(modelId: string, config?: OllamaConfig) {
    this.modelId = modelId;
    try {
      const { Ollama } = _require("ollama");
      this.client = new Ollama({
        host: config?.host ?? "http://localhost:11434",
      });
    } catch (e: any) {
      if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error("ollama package is required for OllamaProvider. Install it: npm install ollama");
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
      messages: this.toOllamaMessages(messages),
      stream: false,
    };

    const ollamaOptions: Record<string, unknown> = {};
    if (options?.temperature !== undefined) ollamaOptions.temperature = options.temperature;
    if (options?.topP !== undefined) ollamaOptions.top_p = options.topP;
    if (options?.stop) ollamaOptions.stop = options.stop;
    if (options?.maxTokens !== undefined) ollamaOptions.num_predict = options.maxTokens;

    if (Object.keys(ollamaOptions).length > 0) params.options = ollamaOptions;

    if (options?.tools?.length) {
      params.tools = this.toOllamaTools(options.tools);
    }

    if (options?.responseFormat === "json") {
      params.format = "json";
    }

    const response = await this.withRetry(() => this.client.chat(params));
    return this.normalizeResponse(response);
  }

  async *stream(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): AsyncGenerator<StreamChunk> {
    const params: Record<string, unknown> = {
      model: this.modelId,
      messages: this.toOllamaMessages(messages),
      stream: true,
    };

    const ollamaOptions: Record<string, unknown> = {};
    if (options?.temperature !== undefined) ollamaOptions.temperature = options.temperature;
    if (options?.topP !== undefined) ollamaOptions.top_p = options.topP;
    if (options?.stop) ollamaOptions.stop = options.stop;
    if (options?.maxTokens !== undefined) ollamaOptions.num_predict = options.maxTokens;

    if (Object.keys(ollamaOptions).length > 0) params.options = ollamaOptions;

    if (options?.tools?.length) {
      params.tools = this.toOllamaTools(options.tools);
    }

    if (options?.responseFormat === "json") {
      params.format = "json";
    }

    const stream = await this.withRetry<any>(() => this.client.chat(params));

    let toolCallCounter = 0;

    for await (const chunk of stream) {
      if (chunk.message?.content) {
        yield { type: "text", text: chunk.message.content };
      }

      if (chunk.message?.tool_calls) {
        for (const tc of chunk.message.tool_calls) {
          const id = `ollama_tc_${toolCallCounter++}`;
          yield {
            type: "tool_call_start",
            toolCall: {
              id,
              name: tc.function?.name ?? "",
            },
          };
          yield {
            type: "tool_call_delta",
            toolCallId: id,
            argumentsDelta: JSON.stringify(tc.function?.arguments ?? {}),
          };
          yield { type: "tool_call_end", toolCallId: id };
        }
      }

      if (chunk.done) {
        const hasToolCalls = chunk.message?.tool_calls?.length > 0;
        yield {
          type: "finish",
          finishReason: hasToolCalls ? "tool_calls" : "stop",
          usage: {
            promptTokens: chunk.prompt_eval_count ?? 0,
            completionTokens: chunk.eval_count ?? 0,
            totalTokens: (chunk.prompt_eval_count ?? 0) + (chunk.eval_count ?? 0),
            providerMetrics: {
              prompt_eval_count: chunk.prompt_eval_count,
              eval_count: chunk.eval_count,
              prompt_eval_duration: chunk.prompt_eval_duration,
              eval_duration: chunk.eval_duration,
              total_duration: chunk.total_duration,
              load_duration: chunk.load_duration,
            },
          },
        };
      }
    }
  }

  private toOllamaMessages(messages: ChatMessage[]): unknown[] {
    return messages.map((msg) => {
      if (msg.role === "assistant" && msg.toolCalls?.length) {
        return {
          role: "assistant",
          content: getTextContent(msg.content) ?? "",
          tool_calls: msg.toolCalls.map((tc) => ({
            function: {
              name: tc.name,
              arguments: tc.arguments,
            },
          })),
        };
      }

      if (msg.role === "tool") {
        return {
          role: "tool",
          content: getTextContent(msg.content) ?? "",
        };
      }

      if (isMultiModal(msg.content)) {
        const images: string[] = [];
        const textParts: string[] = [];
        for (const part of msg.content) {
          switch (part.type) {
            case "text":
              textParts.push(part.text);
              break;
            case "image":
              images.push(part.data);
              break;
            case "audio":
            case "file":
              console.warn(`[agentium/ollama] ${part.type} input is not natively supported by Ollama. Skipping.`);
              break;
          }
        }
        return {
          role: msg.role,
          content: textParts.join("\n"),
          ...(images.length > 0 ? { images } : {}),
        };
      }

      return {
        role: msg.role,
        content: msg.content ?? "",
      };
    });
  }

  private toOllamaTools(tools: ToolDefinition[]): unknown[] {
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
    const toolCalls: ToolCall[] = (response.message?.tool_calls ?? []).map((tc: any, i: number) => ({
      id: `ollama_tc_${i}`,
      name: tc.function?.name ?? "",
      arguments: tc.function?.arguments ?? {},
    }));

    const usage: TokenUsage = {
      promptTokens: response.prompt_eval_count ?? 0,
      completionTokens: response.eval_count ?? 0,
      totalTokens: (response.prompt_eval_count ?? 0) + (response.eval_count ?? 0),
      providerMetrics: {
        prompt_eval_count: response.prompt_eval_count,
        eval_count: response.eval_count,
        prompt_eval_duration: response.prompt_eval_duration,
        eval_duration: response.eval_duration,
        total_duration: response.total_duration,
        load_duration: response.load_duration,
      },
    };

    const hasToolCalls = toolCalls.length > 0;

    return {
      message: {
        role: "assistant",
        content: response.message?.content ?? null,
        toolCalls: hasToolCalls ? toolCalls : undefined,
      },
      usage,
      finishReason: hasToolCalls ? "tool_calls" : "stop",
      raw: response,
    };
  }
}
