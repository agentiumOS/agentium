import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { BillingContext } from "../../cost/accounting-types.js";
import type { ModelProvider } from "../provider.js";
import {
  abortableStream,
  createRequestScope,
  type ProviderRequestControls,
  validateRequestControls,
} from "../request-controls.js";
import {
  applyGoogleRequestExtras,
  applyGoogleThinkingConfig,
  extrasFromGoogleParts,
  googleReplayParts,
  validateGoogleArgonOptions,
} from "../thinking-replay.js";
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
import {
  ModelUsageError,
  mergeResponseContext,
  providerTokenUsage,
  safeResponseContext,
} from "../usage-normalizers.js";

const _require = createRequire(import.meta.url);
type GoogleStreamChunk = {
  usageMetadata?: unknown;
  candidates?: {
    finishReason?: string;
    continuationToken?: string;
    content?: {
      parts?: {
        thought?: boolean;
        text?: string;
        functionCall?: { id?: string; name: string; args?: unknown };
      }[];
    };
  }[];
};

function billingDimensions(messages: ChatMessage[], options?: ModelConfig): Record<string, string> {
  const textOnly = messages.every(
    (message) =>
      !message.providerExtras &&
      (message.content === null ||
        typeof message.content === "string" ||
        message.content.every((part) => part.type === "text")),
  );
  return {
    ...(textOnly ? { modality: "text" } : {}),
    ...(options?.providerOptions?.googleSearch ? { hostedTools: "google-search" } : {}),
  };
}

export interface GoogleConfig extends ProviderRequestControls {
  apiKey?: string;
  baseURL?: string;
}

export class GoogleProvider implements ModelProvider {
  readonly providerId = "google";
  readonly modelId: string;
  readonly communicationCapabilities = { messagePhases: "inferred", reasoningSummaries: "conditional" } as const;
  readonly attemptVisibility: "physical" | "opaque";
  private readonly config: GoogleConfig;
  private ai: any;
  private GoogleGenAICtor: any;
  private clientCache = new Map<string, any>();

  constructor(modelId: string, config?: GoogleConfig) {
    this.modelId = modelId;
    this.config = { ...config };
    validateRequestControls(this.config);
    this.attemptVisibility = config?.sdkMaxRetries === 0 ? "physical" : "opaque";
    try {
      const { GoogleGenAI } = _require("@google/genai");
      this.GoogleGenAICtor = GoogleGenAI;
      const key = config?.apiKey ?? process.env.GOOGLE_API_KEY;
      if (key) {
        this.ai = new GoogleGenAI(this.clientOptions(key));
      }
    } catch (e: any) {
      if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error("@google/genai is required for GoogleProvider. Install it: npm install @google/genai");
      }
      throw e;
    }
  }

  private getClient(apiKey?: string): any {
    if (apiKey) {
      let cached = this.clientCache.get(apiKey);
      if (!cached) {
        cached = new this.GoogleGenAICtor(this.clientOptions(apiKey));
        this.clientCache.set(apiKey, cached);
        if (this.clientCache.size > 50) {
          const oldest = this.clientCache.keys().next().value;
          if (oldest) this.clientCache.delete(oldest);
        }
      }
      return cached;
    }
    if (this.ai) return this.ai;
    const envKey = process.env.GOOGLE_API_KEY;
    if (envKey) {
      this.ai = new this.GoogleGenAICtor(this.clientOptions(envKey));
      return this.ai;
    }
    throw new Error(
      "No Google API key provided. Pass it via the x-google-api-key header, apiKey in request body, or set GOOGLE_API_KEY env var.",
    );
  }

  private clientOptions(apiKey: string) {
    return {
      apiKey,
      httpOptions: {
        ...(this.config.baseURL ? { baseUrl: this.config.baseURL } : {}),
        ...(this.config.timeoutMs !== undefined ? { timeout: this.config.timeoutMs } : {}),
        ...(this.config.sdkMaxRetries !== undefined
          ? { retryOptions: { attempts: this.config.sdkMaxRetries + 1 } }
          : {}),
      },
    };
  }

  async generate(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): Promise<ModelResponse> {
    validateGoogleArgonOptions(this.modelId, options);
    const scope = createRequestScope(this.config ?? {}, options);
    try {
      const { systemInstruction, contents } = this.toGoogleMessages(messages);
      const usageDimensions = billingDimensions(messages, options);

      const config: Record<string, unknown> = {};
      if (options?.temperature !== undefined) config.temperature = options.temperature;
      if (options?.maxTokens !== undefined) config.maxOutputTokens = options.maxTokens;
      if (options?.topP !== undefined) config.topP = options.topP;
      if (options?.stop) config.stopSequences = options.stop;

      if (options?.responseFormat) {
        config.responseMimeType = "application/json";
        const rf = options.responseFormat;
        if (
          typeof rf === "object" &&
          rf !== null &&
          "type" in rf &&
          rf.type === "json_schema" &&
          "schema" in rf &&
          rf.schema
        ) {
          config.responseSchema = this.cleanJsonSchema(rf.schema as Record<string, unknown>);
        }
      }

      if (options?.reasoning?.enabled) {
        applyGoogleThinkingConfig(config, this.modelId, options);
      }

      if (systemInstruction) config.systemInstruction = systemInstruction;
      if (options?.tools?.length) {
        config.tools = [
          {
            functionDeclarations: this.toGoogleTools(options.tools),
          },
        ];
      }
      applyGoogleRequestExtras(config, this.modelId, options);
      config.abortSignal = scope.signal;

      const params: Record<string, unknown> = {
        model: this.modelId,
        contents,
        config,
      };

      const client = this.getClient(options?.apiKey);
      const response = await scope.retry(() => client.models.generateContent(params));
      return this.normalizeResponse(response, usageDimensions);
    } finally {
      scope.dispose();
    }
  }

  async *stream(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): AsyncGenerator<StreamChunk> {
    validateGoogleArgonOptions(this.modelId, options);
    const scope = createRequestScope(this.config ?? {}, options);
    try {
      const { systemInstruction, contents } = this.toGoogleMessages(messages);
      const usageDimensions = billingDimensions(messages, options);

      const config: Record<string, unknown> = {};
      if (options?.temperature !== undefined) config.temperature = options.temperature;
      if (options?.maxTokens !== undefined) config.maxOutputTokens = options.maxTokens;
      if (options?.topP !== undefined) config.topP = options.topP;
      if (options?.stop) config.stopSequences = options.stop;

      if (options?.reasoning?.enabled) {
        applyGoogleThinkingConfig(config, this.modelId, options);
      }

      if (systemInstruction) config.systemInstruction = systemInstruction;
      if (options?.tools?.length) {
        config.tools = [
          {
            functionDeclarations: this.toGoogleTools(options.tools),
          },
        ];
      }
      applyGoogleRequestExtras(config, this.modelId, options);
      config.abortSignal = scope.signal;

      const params: Record<string, unknown> = {
        model: this.modelId,
        contents,
        config,
      };

      const client = this.getClient(options?.apiKey);
      const streamResult = await scope.retry<AsyncIterable<GoogleStreamChunk>>(() =>
        client.models.generateContentStream(params),
      );

      let toolCallCounter = 0;
      const replayParts: unknown[] = [];
      let lastFinishReason = "stop";
      let context: Partial<BillingContext> = {
        modelId: this.modelId,
        requestedModelId: this.modelId,
        dimensions: usageDimensions,
      };
      let lastUsage: TokenUsage | undefined;
      let usagePending = false;

      for await (const chunk of abortableStream(streamResult, scope.signal)) {
        context = mergeResponseContext(context, chunk);
        if (chunk.usageMetadata) {
          lastUsage = providerTokenUsage(this.providerId, "generate-content", chunk.usageMetadata, context);
          usagePending = true;
        }
        const candidate = chunk.candidates?.[0];
        if (candidate?.finishReason === "CONTINUATION" || candidate?.continuationToken) {
          throw new ModelUsageError(
            "Google returned an incomplete answer requiring continuation, which this adapter does not support. Reduce maxTokens or use a separate long-decode integration.",
            lastUsage ?? providerTokenUsage(this.providerId, "generate-content", undefined, context),
          );
        }
        const parts = candidate?.content?.parts ?? [];
        replayParts.push(...parts);

        for (const part of parts) {
          if (part.thought) {
            yield { type: "thinking", text: part.text ?? "" };
            if (part.text) yield { type: "reasoning_summary", text: part.text };
          } else if (part.text) {
            yield { type: "text", text: part.text };
          }

          if (part.functionCall) {
            const fallbackId = `google_tc_${toolCallCounter++}`;
            const id = part.functionCall.id ?? fallbackId;
            yield {
              type: "tool_call_start",
              toolCall: { id, name: part.functionCall.name },
            };
            yield {
              type: "tool_call_delta",
              toolCallId: id,
              argumentsDelta: JSON.stringify(part.functionCall.args ?? {}),
            };
            yield { type: "tool_call_end", toolCallId: id };
          }
        }

        if (candidate?.finishReason) {
          let finishReason = "stop";
          if (candidate.finishReason === "STOP" || candidate.finishReason === "END_TURN") {
            finishReason = "stop";
          } else if (candidate.finishReason === "MAX_TOKENS") {
            finishReason = "length";
          } else if (candidate.finishReason === "SAFETY") {
            finishReason = "content_filter";
          }

          if (toolCallCounter > 0) finishReason = "tool_calls";

          lastFinishReason = finishReason;
          yield {
            type: "finish",
            finishReason,
            usage: lastUsage,
            providerExtras: extrasFromGoogleParts(replayParts),
          };
          usagePending = false;
        }
      }
      if (usagePending) {
        yield {
          type: "finish",
          finishReason: lastFinishReason,
          usage: lastUsage,
          providerExtras: extrasFromGoogleParts(replayParts),
        };
      }
    } finally {
      scope.dispose();
    }
  }

  private toGoogleMessages(messages: ChatMessage[]): {
    systemInstruction: string | undefined;
    contents: unknown[];
  } {
    let systemInstruction: string | undefined;
    const contents: unknown[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        systemInstruction = getTextContent(msg.content) || undefined;
        continue;
      }

      if (msg.role === "user") {
        if (isMultiModal(msg.content)) {
          contents.push({
            role: "user",
            parts: msg.content.map((p) => this.partToGoogle(p)),
          });
        } else {
          contents.push({
            role: "user",
            parts: [{ text: msg.content ?? "" }],
          });
        }
        continue;
      }

      if (msg.role === "assistant") {
        const replay = googleReplayParts(msg);
        if (replay) {
          contents.push({ role: "model", parts: replay });
          continue;
        }
        const parts: unknown[] = [];
        if (msg.content) {
          if (typeof msg.content === "string") {
            parts.push({ text: msg.content });
          } else if (Array.isArray(msg.content)) {
            const text = msg.content
              .filter((p: any) => p.type === "text")
              .map((p: any) => p.text)
              .join("");
            if (text) parts.push({ text });
          }
        }
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            parts.push({
              functionCall: { name: tc.name, args: tc.arguments, id: tc.id },
            });
          }
        }
        if (parts.length === 0) {
          parts.push({ text: "" });
        }
        contents.push({ role: "model", parts });
        continue;
      }

      if (msg.role === "tool") {
        contents.push({
          role: "function",
          parts: [
            {
              functionResponse: {
                name: msg.name ?? "unknown",
                id: msg.toolCallId,
                response: { result: msg.content ?? "" },
              },
            },
          ],
        });
      }
    }

    return { systemInstruction, contents };
  }

  private partToGoogle(part: ContentPart): unknown {
    switch (part.type) {
      case "text":
        return { text: part.text };
      case "image":
      case "audio":
      case "file": {
        const isUrl = part.data.startsWith("http://") || part.data.startsWith("https://");
        if (isUrl) {
          return {
            fileData: {
              fileUri: part.data,
              mimeType: part.mimeType ?? (part.type === "image" ? "image/png" : "application/octet-stream"),
            },
          };
        }
        return {
          inlineData: {
            data: part.data,
            mimeType:
              part.mimeType ??
              (part.type === "image" ? "image/png" : part.type === "audio" ? "audio/mp3" : "application/octet-stream"),
          },
        };
      }
    }
  }

  private toGoogleTools(tools: ToolDefinition[]): unknown[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  private cleanJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
    const cleaned = { ...schema };
    delete cleaned.$schema;
    delete cleaned.$ref;
    delete cleaned.additionalProperties;

    if (cleaned.properties && typeof cleaned.properties === "object") {
      const props: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(cleaned.properties as Record<string, unknown>)) {
        props[key] = typeof val === "object" && val ? this.cleanJsonSchema(val as Record<string, unknown>) : val;
      }
      cleaned.properties = props;
    }

    if (cleaned.items && typeof cleaned.items === "object") {
      cleaned.items = this.cleanJsonSchema(cleaned.items as Record<string, unknown>);
    }

    return cleaned;
  }

  private normalizeResponse(
    response: any,
    usageDimensions: Record<string, string> = {},
  ): ModelResponse & { thinking?: string } {
    const usage = providerTokenUsage(this.providerId, "generate-content", response.usageMetadata, {
      modelId: this.modelId,
      requestedModelId: this.modelId,
      ...safeResponseContext(response),
      dimensions: usageDimensions,
    });
    const candidate = response.candidates?.[0];
    if (candidate?.finishReason === "CONTINUATION" || candidate?.continuationToken) {
      throw new ModelUsageError(
        "Google returned an incomplete answer requiring continuation, which this adapter does not support. Reduce maxTokens or use a separate long-decode integration.",
        usage,
      );
    }
    const parts = candidate?.content?.parts ?? [];

    let textContent = "";
    let thinkingContent = "";
    const toolCalls: ToolCall[] = [];
    let toolCallCounter = 0;

    for (const part of parts) {
      if (part.thought && part.text) {
        thinkingContent += part.text;
      } else if (part.text) {
        textContent += part.text;
      }
      if (part.functionCall) {
        const fallbackId = `google_tc_${toolCallCounter++}`;
        toolCalls.push({
          id: part.functionCall.id ?? fallbackId,
          name: part.functionCall.name,
          arguments: part.functionCall.args ?? {},
        });
      }
    }

    let finishReason: ModelResponse["finishReason"] = "stop";
    if (toolCalls.length > 0) finishReason = "tool_calls";
    else if (candidate?.finishReason === "MAX_TOKENS") finishReason = "length";
    else if (candidate?.finishReason === "SAFETY") finishReason = "content_filter";

    const extras = extrasFromGoogleParts(parts);
    const result: ModelResponse & { thinking?: string } = {
      message: {
        role: "assistant",
        content: textContent || null,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        ...(extras ? { providerExtras: extras } : {}),
      },
      usage,
      finishReason,
      raw: response,
    };

    if (thinkingContent) {
      result.thinking = thinkingContent;
      result.publicMessages = [
        { id: randomUUID(), phase: "reasoning_summary", text: thinkingContent },
        ...(textContent
          ? [
              {
                id: randomUUID(),
                phase: toolCalls.length ? ("commentary" as const) : ("final" as const),
                text: textContent,
              },
            ]
          : []),
      ];
    }

    return result;
  }
}
