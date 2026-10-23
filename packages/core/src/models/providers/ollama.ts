import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import type { ModelProvider } from "../provider.js";
import {
  abortableStream,
  createRequestScope,
  type ProviderRequestControls,
  validateRequestControls,
} from "../request-controls.js";
import type { ChatMessage, ModelConfig, ModelResponse, StreamChunk, ToolCall, ToolDefinition } from "../types.js";
import { getTextContent, isMultiModal } from "../types.js";
import { providerTokenUsage, safeResponseContext } from "../usage-normalizers.js";

const _require = createRequire(import.meta.url);
type OllamaStreamChunk = {
  message?: { content?: string; tool_calls?: { function?: { name?: string; arguments?: unknown } }[] };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
};

export interface OllamaConfig extends ProviderRequestControls {
  host?: string;
  fetch?: typeof globalThis.fetch;
}

export class OllamaProvider implements ModelProvider {
  readonly providerId = "ollama";
  readonly modelId: string;
  readonly attemptVisibility: "physical" | "opaque";
  private readonly config: OllamaConfig;
  private readonly requests = new AsyncLocalStorage<AbortSignal>();
  private client: any;

  constructor(modelId: string, config?: OllamaConfig) {
    this.modelId = modelId;
    this.config = { ...config };
    validateRequestControls(this.config);
    if ((config?.sdkMaxRetries ?? 0) !== 0) throw new TypeError("Ollama has no SDK retry setting; use maxRetries");
    this.attemptVisibility = config?.maxRetries === 0 ? "physical" : "opaque";
    try {
      const { Ollama } = _require("ollama");
      this.client = new Ollama({
        host: config?.host ?? "http://localhost:11434",
        fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const requestSignal = this.requests.getStore();
          const signals = [
            init?.signal,
            requestSignal,
            this.config.timeoutMs === undefined ? undefined : AbortSignal.timeout(this.config.timeoutMs),
          ].filter((value): value is AbortSignal => value != null);
          return (this.config.fetch ?? globalThis.fetch)(input, {
            ...init,
            ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
          });
        },
      });
    } catch (e: any) {
      if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error("ollama package is required for OllamaProvider. Install it: npm install ollama");
      }
      throw e;
    }
  }

  async generate(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): Promise<ModelResponse> {
    const scope = createRequestScope(this.config ?? {}, options);
    try {
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

      const response = await scope.retry(() => this.requests.run(scope.signal, () => this.client.chat(params)));
      return this.normalizeResponse(response);
    } finally {
      scope.dispose();
    }
  }

  async *stream(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): AsyncGenerator<StreamChunk> {
    const scope = createRequestScope(this.config ?? {}, options);
    try {
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

      const stream = await scope.retry<AsyncIterable<OllamaStreamChunk>>(() =>
        this.requests.run(scope.signal, () => this.client.chat(params)),
      );

      let toolCallCounter = 0;

      for await (const chunk of abortableStream(stream, scope.signal)) {
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
          const hasToolCalls = (chunk.message?.tool_calls?.length ?? 0) > 0;
          yield {
            type: "finish",
            finishReason: hasToolCalls ? "tool_calls" : "stop",
            usage: providerTokenUsage(
              this.providerId,
              "ollama-chat",
              {
                prompt_eval_count: chunk.prompt_eval_count,
                eval_count: chunk.eval_count,
                total_duration: chunk.total_duration,
                load_duration: chunk.load_duration,
                prompt_eval_duration: chunk.prompt_eval_duration,
                eval_duration: chunk.eval_duration,
              },
              { modelId: this.modelId },
            ),
          };
        }
      }
    } finally {
      scope.dispose();
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
    const usage = providerTokenUsage(
      this.providerId,
      "ollama-chat",
      {
        prompt_eval_count: response.prompt_eval_count,
        eval_count: response.eval_count,
        total_duration: response.total_duration,
        load_duration: response.load_duration,
        prompt_eval_duration: response.prompt_eval_duration,
        eval_duration: response.eval_duration,
      },
      { modelId: this.modelId, ...safeResponseContext(response) },
    );
    const toolCalls: ToolCall[] = (response.message?.tool_calls ?? []).map((tc: any, i: number) => ({
      id: `ollama_tc_${i}`,
      name: tc.function?.name ?? "",
      arguments: tc.function?.arguments ?? {},
    }));

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
