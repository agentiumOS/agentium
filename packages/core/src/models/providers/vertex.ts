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

export interface VertexAIConfig {
  project?: string;
  location?: string;
  /** Service account key JSON string or path (optional — uses ADC by default). */
  credentials?: string;
}

/**
 * Vertex AI provider using Google's @google/genai SDK in Vertex mode.
 *
 * Authentication (in order of precedence):
 *   1. Explicit `project` + `location` in config
 *   2. GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION env vars
 *   3. Application Default Credentials (gcloud auth)
 */
export class VertexAIProvider implements ModelProvider {
  readonly providerId = "vertex";
  readonly modelId: string;
  private ai: any = null;
  private GoogleGenAICtor: any;
  private project: string;
  private location: string;

  constructor(modelId: string, config?: VertexAIConfig) {
    this.modelId = modelId;
    this.project = config?.project ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? "";
    this.location =
      config?.location ?? process.env.GOOGLE_CLOUD_LOCATION ?? process.env.GOOGLE_CLOUD_REGION ?? "us-central1";

    if (!this.project) {
      throw new Error(
        "VertexAIProvider: 'project' is required. Pass it in config or set GOOGLE_CLOUD_PROJECT env var.",
      );
    }

    try {
      const { GoogleGenAI } = _require("@google/genai");
      this.GoogleGenAICtor = GoogleGenAI;
    } catch (e: any) {
      if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error("@google/genai is required for VertexAIProvider. Install it: npm install @google/genai");
      }
      throw e;
    }
  }

  private getClient(): any {
    if (this.ai) return this.ai;
    this.ai = new this.GoogleGenAICtor({
      vertexai: true,
      project: this.project,
      location: this.location,
    });
    return this.ai;
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
    const { systemInstruction, contents } = this.toGoogleMessages(messages);

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
      config.thinkingConfig = {
        thinkingBudget: options.reasoning.budgetTokens ?? 10000,
      };
    }

    if (systemInstruction) config.systemInstruction = systemInstruction;
    if (options?.tools?.length) {
      config.tools = [{ functionDeclarations: this.toGoogleTools(options.tools) }];
    }

    const params: Record<string, unknown> = {
      model: this.modelId,
      contents,
      config,
    };

    const client = this.getClient();
    const response = await this.withRetry(() => client.models.generateContent(params));

    return this.normalizeResponse(response);
  }

  async *stream(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): AsyncGenerator<StreamChunk> {
    const { systemInstruction, contents } = this.toGoogleMessages(messages);

    const config: Record<string, unknown> = {};
    if (options?.temperature !== undefined) config.temperature = options.temperature;
    if (options?.maxTokens !== undefined) config.maxOutputTokens = options.maxTokens;
    if (options?.topP !== undefined) config.topP = options.topP;
    if (options?.stop) config.stopSequences = options.stop;

    if (options?.reasoning?.enabled) {
      config.thinkingConfig = {
        thinkingBudget: options.reasoning.budgetTokens ?? 10000,
      };
    }

    if (systemInstruction) config.systemInstruction = systemInstruction;
    if (options?.tools?.length) {
      config.tools = [{ functionDeclarations: this.toGoogleTools(options.tools) }];
    }

    const params: Record<string, unknown> = {
      model: this.modelId,
      contents,
      config,
    };

    const client = this.getClient();
    const streamResult = await this.withRetry<any>(() => client.models.generateContentStream(params));

    let toolCallCounter = 0;

    for await (const chunk of streamResult) {
      const candidate = chunk.candidates?.[0];
      if (!candidate?.content?.parts) continue;

      for (const part of candidate.content.parts) {
        if (part.thought) {
          yield { type: "thinking", text: part.text ?? "" };
        } else if (part.text) {
          yield { type: "text", text: part.text };
        }

        if (part.functionCall) {
          const id = `vertex_tc_${toolCallCounter++}`;
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

      if (candidate.finishReason) {
        let finishReason = "stop";
        if (candidate.finishReason === "STOP" || candidate.finishReason === "END_TURN") finishReason = "stop";
        else if (candidate.finishReason === "MAX_TOKENS") finishReason = "length";
        else if (candidate.finishReason === "SAFETY") finishReason = "content_filter";

        const hasToolCalls = candidate.content?.parts?.some((p: any) => p.functionCall);
        if (hasToolCalls) finishReason = "tool_calls";

        const cum = chunk.usageMetadata;
        yield {
          type: "finish",
          finishReason,
          usage: cum
            ? {
                promptTokens: cum.promptTokenCount ?? 0,
                completionTokens: cum.candidatesTokenCount ?? 0,
                totalTokens: cum.totalTokenCount ?? 0,
                ...(cum.thoughtsTokenCount > 0 ? { reasoningTokens: cum.thoughtsTokenCount } : {}),
                ...(cum.cachedContentTokenCount > 0 ? { cachedTokens: cum.cachedContentTokenCount } : {}),
                providerMetrics: this.extractProviderMetrics(cum),
              }
            : undefined,
        };
      }
    }
  }

  // ── Message conversion (identical to GoogleProvider) ─────────────────────

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
              functionCall: { name: tc.name, args: tc.arguments },
            });
          }
        }
        if (parts.length === 0) parts.push({ text: "" });
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

  private extractProviderMetrics(um: any): Record<string, unknown> {
    const m: Record<string, unknown> = {};
    if (um.promptTokenCount != null) m.prompt_token_count = um.promptTokenCount;
    if (um.candidatesTokenCount != null) m.candidates_token_count = um.candidatesTokenCount;
    if (um.thoughtsTokenCount != null) m.thoughts_token_count = um.thoughtsTokenCount;
    if (um.totalTokenCount != null) m.total_token_count = um.totalTokenCount;
    if (um.cachedContentTokenCount != null) m.cached_content_token_count = um.cachedContentTokenCount;
    if (um.toolUsePromptTokenCount != null) m.tool_use_prompt_token_count = um.toolUsePromptTokenCount;
    if (um.promptTokensDetails) m.prompt_tokens_details = um.promptTokensDetails;
    if (um.candidatesTokensDetails) m.candidates_tokens_details = um.candidatesTokensDetails;
    if (um.cacheTokensDetails) m.cache_tokens_details = um.cacheTokensDetails;
    if (um.trafficType ?? um.traffic_type) m.traffic_type = um.trafficType ?? um.traffic_type;
    return m;
  }

  private normalizeResponse(response: any): ModelResponse & { thinking?: string } {
    const candidate = response.candidates?.[0];
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
        toolCalls.push({
          id: `vertex_tc_${toolCallCounter++}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args ?? {},
        });
      }
    }

    const um = response.usageMetadata;
    const thinkingTokens = um?.thoughtsTokenCount ?? 0;
    const cachedTokens = um?.cachedContentTokenCount ?? 0;
    const usage: TokenUsage = {
      promptTokens: um?.promptTokenCount ?? 0,
      completionTokens: um?.candidatesTokenCount ?? 0,
      totalTokens: um?.totalTokenCount ?? 0,
      ...(thinkingTokens > 0 ? { reasoningTokens: thinkingTokens } : {}),
      ...(cachedTokens > 0 ? { cachedTokens } : {}),
      providerMetrics: um ? this.extractProviderMetrics(um) : undefined,
    };

    let finishReason: ModelResponse["finishReason"] = "stop";
    if (toolCalls.length > 0) finishReason = "tool_calls";
    else if (candidate?.finishReason === "MAX_TOKENS") finishReason = "length";
    else if (candidate?.finishReason === "SAFETY") finishReason = "content_filter";

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
