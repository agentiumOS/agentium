import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { BillingContext } from "../../cost/accounting-types.js";
import { captureRetryFailure } from "../../cost/context.js";
import type { ModelProvider } from "../provider.js";
import { anthropicReplayContent, applyAnthropicThinking, extrasFromAnthropicContent } from "../thinking-replay.js";
import {
  type ChatMessage,
  type ContentPart,
  getTextContent,
  isMultiModal,
  type ModelConfig,
  type ModelResponse,
  type StreamChunk,
  type ToolCall,
  type ToolDefinition,
} from "../types.js";
import { mergeResponseContext, providerTokenUsage, safeResponseContext } from "../usage-normalizers.js";

const _require = createRequire(import.meta.url);

export interface AwsClaudeConfig {
  awsAccessKey?: string;
  awsSecretKey?: string;
  awsRegion?: string;
  awsSessionToken?: string;
}

/**
 * Claude models on AWS Bedrock via the `@anthropic-ai/bedrock-sdk`.
 *
 * Uses the Anthropic Messages API routed through AWS Bedrock — same message
 * format as the direct Anthropic API but authenticated with AWS credentials.
 */
export class AwsClaudeProvider implements ModelProvider {
  readonly providerId = "aws-claude";
  readonly modelId: string;
  readonly communicationCapabilities = { messagePhases: "inferred", reasoningSummaries: "conditional" } as const;
  private client: any;
  private readonly region: string;
  private BedrockCtor: any;

  constructor(modelId: string, config?: AwsClaudeConfig) {
    this.modelId = modelId;
    this.region = config?.awsRegion ?? process.env.AWS_REGION ?? "us-east-1";
    try {
      const mod = _require("@anthropic-ai/bedrock-sdk");
      this.BedrockCtor = mod.AnthropicBedrock ?? mod.default ?? mod;
      this.client = new this.BedrockCtor({
        awsAccessKey: config?.awsAccessKey ?? process.env.AWS_ACCESS_KEY_ID,
        awsSecretKey: config?.awsSecretKey ?? process.env.AWS_SECRET_ACCESS_KEY,
        awsRegion: config?.awsRegion ?? process.env.AWS_REGION ?? "us-east-1",
        awsSessionToken: config?.awsSessionToken ?? process.env.AWS_SESSION_TOKEN,
      });
    } catch (e: any) {
      if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error(
          "@anthropic-ai/bedrock-sdk is required for AwsClaudeProvider. Install it: npm install @anthropic-ai/bedrock-sdk",
        );
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
          err?.message?.includes("rate limit") ||
          err?.message?.includes("ThrottlingException");
        if (!isRetryable || attempt === retries) throw err;
        await captureRetryFailure(err);
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

    const maxTokens = options?.maxTokens ?? 4096;

    const params: Record<string, unknown> = {
      model: this.modelId,
      messages: anthropicMessages,
      max_tokens: maxTokens,
    };

    if (systemMsg) params.system = systemMsg;
    if (options?.temperature !== undefined) params.temperature = options.temperature;
    if (options?.topP !== undefined) params.top_p = options.topP;
    if (options?.stop) params.stop_sequences = options.stop;
    if (options?.tools?.length) {
      params.tools = this.toAnthropicTools(options.tools);
    }
    const betaHeaders = applyAnthropicThinking(params, this.modelId, options);

    const response = await this.withRetry(() =>
      this.client.messages.create(params, betaHeaders ? { headers: betaHeaders } : undefined),
    );
    return this.normalizeResponse(response, options?.reasoning?.enabled === true);
  }

  async *stream(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): AsyncGenerator<StreamChunk> {
    const { systemMsg, anthropicMessages } = this.toAnthropicMessages(messages);

    const maxTokens = options?.maxTokens ?? 4096;

    const params: Record<string, unknown> = {
      model: this.modelId,
      messages: anthropicMessages,
      max_tokens: maxTokens,
      stream: true,
    };

    if (systemMsg) params.system = systemMsg;
    if (options?.temperature !== undefined) params.temperature = options.temperature;
    if (options?.topP !== undefined) params.top_p = options.topP;
    if (options?.stop) params.stop_sequences = options.stop;
    if (options?.tools?.length) {
      params.tools = this.toAnthropicTools(options.tools);
    }
    const betaHeaders = applyAnthropicThinking(params, this.modelId, options);

    const stream = await this.withRetry<any>(() =>
      this.client.messages.create(params, betaHeaders ? { headers: betaHeaders } : undefined),
    );

    let currentToolId = "";
    let inThinkingBlock = false;
    let streamUsage: Record<string, unknown> = {};
    let streamContext: Partial<BillingContext> = { modelId: this.modelId, region: this.region };
    const replayContent: unknown[] = [];
    let currentBlock: Record<string, unknown> | null = null;
    let toolInputJson = "";

    for await (const event of stream) {
      switch (event.type) {
        case "content_block_start": {
          const block = event.content_block;
          if (block?.type === "tool_use") {
            currentToolId = block.id;
            toolInputJson = "";
            currentBlock = { type: "tool_use", id: block.id, name: block.name, input: block.input ?? {} };
            replayContent.push(currentBlock);
            yield {
              type: "tool_call_start",
              toolCall: { id: block.id, name: block.name },
            };
          } else if (block?.type === "thinking") {
            inThinkingBlock = true;
            currentBlock = { type: "thinking", thinking: block.thinking ?? "", signature: block.signature ?? "" };
            replayContent.push(currentBlock);
          } else if (block?.type === "redacted_thinking") {
            currentBlock = { type: "redacted_thinking", data: block.data };
            replayContent.push(currentBlock);
          } else if (block?.type === "text") {
            currentBlock = { type: "text", text: block.text ?? "" };
            replayContent.push(currentBlock);
          }
          break;
        }
        case "content_block_delta": {
          if (event.delta?.type === "thinking_delta") {
            if (currentBlock?.type === "thinking") {
              currentBlock.thinking = `${currentBlock.thinking ?? ""}${event.delta.thinking ?? ""}`;
            }
            yield { type: "thinking", text: event.delta.thinking };
            // This adapter explicitly requests display: summarized when reasoning is enabled.
            if (options?.reasoning?.enabled) yield { type: "reasoning_summary", text: event.delta.thinking };
          } else if (event.delta?.type === "signature_delta") {
            if (currentBlock?.type === "thinking") {
              currentBlock.signature = `${currentBlock.signature ?? ""}${event.delta.signature ?? ""}`;
            }
          } else if (event.delta?.type === "text_delta") {
            if (currentBlock?.type === "text") {
              currentBlock.text = `${currentBlock.text ?? ""}${event.delta.text ?? ""}`;
            }
            yield { type: "text", text: event.delta.text };
          } else if (event.delta?.type === "input_json_delta") {
            toolInputJson += event.delta.partial_json ?? "";
            yield {
              type: "tool_call_delta",
              toolCallId: currentToolId,
              argumentsDelta: event.delta.partial_json,
            };
          }
          break;
        }
        case "content_block_stop": {
          if (currentBlock?.type === "tool_use" && toolInputJson) {
            try {
              currentBlock.input = JSON.parse(toolInputJson);
            } catch {
              /* keep start-event input */
            }
          }
          if (inThinkingBlock) {
            inThinkingBlock = false;
          } else if (currentToolId) {
            yield { type: "tool_call_end", toolCallId: currentToolId };
            currentToolId = "";
          }
          currentBlock = null;
          break;
        }
        case "message_delta": {
          if (event.usage) streamUsage = { ...streamUsage, ...event.usage };
          const usage = providerTokenUsage(this.providerId, "messages", streamUsage, streamContext);

          let finishReason = event.delta?.stop_reason ?? "stop";
          if (finishReason === "tool_use") finishReason = "tool_calls";
          if (finishReason === "end_turn") finishReason = "stop";

          yield {
            type: "finish",
            finishReason,
            usage,
            providerExtras: extrasFromAnthropicContent(replayContent),
          };
          break;
        }
        case "message_start": {
          if (event.message?.usage) {
            streamUsage = { ...event.message.usage };
            streamContext = mergeResponseContext(streamContext, event.message);
            providerTokenUsage(this.providerId, "messages", streamUsage, streamContext);
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
        const replay = anthropicReplayContent(msg);
        if (replay) {
          anthropicMessages.push({ role: "assistant", content: replay });
          continue;
        }
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
          source: { type: "base64", media_type: part.mimeType ?? "image/png", data: part.data },
        };
      }
      case "audio":
        console.warn("[agentium/aws-claude] Audio input is not supported by Anthropic Claude. Skipping.");
        return { type: "text", text: "[Audio content not supported by this model]" };
      case "file": {
        const isFileUrl = part.data.startsWith("http://") || part.data.startsWith("https://");
        if (isFileUrl) {
          return { type: "document", source: { type: "url", url: part.data } };
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

  private normalizeResponse(response: any, summarized = false): ModelResponse & { thinking?: string } {
    const usage = providerTokenUsage(this.providerId, "messages", response.usage, {
      modelId: this.modelId,
      region: this.region,
      ...safeResponseContext(response),
    });
    const toolCalls: ToolCall[] = [];
    let textContent = "";
    let thinkingContent = "";

    for (const block of response.content ?? []) {
      if (block.type === "text") textContent += block.text;
      else if (block.type === "thinking") thinkingContent += block.thinking;
      else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, name: block.name, arguments: block.input ?? {} });
      }
    }

    let finishReason: ModelResponse["finishReason"] = "stop";
    if (response.stop_reason === "tool_use") finishReason = "tool_calls";
    else if (response.stop_reason === "max_tokens") finishReason = "length";

    const extras = extrasFromAnthropicContent(response.content);
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

    if (thinkingContent) result.thinking = thinkingContent;

    if (summarized && thinkingContent)
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
    return result;
  }
}
