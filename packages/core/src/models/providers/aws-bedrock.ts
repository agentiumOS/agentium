import { createRequire } from "node:module";
import type { ModelProvider } from "../provider.js";
import {
  type ChatMessage,
  getTextContent,
  type ModelConfig,
  type ModelResponse,
  type StreamChunk,
  type TokenUsage,
  type ToolCall,
  type ToolDefinition,
} from "../types.js";

const _require = createRequire(import.meta.url);

export interface AwsBedrockConfig {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

/**
 * Generic AWS Bedrock provider using the Converse API from
 * `@aws-sdk/client-bedrock-runtime`. Works with any model available on
 * Bedrock (Anthropic, Meta, Mistral, Amazon Titan, etc.).
 *
 * For Claude-specific features (like extended thinking) prefer `AwsClaudeProvider`.
 */
export class AwsBedrockProvider implements ModelProvider {
  readonly providerId = "aws-bedrock";
  readonly modelId: string;
  private client: any;
  private Cmds: any;

  constructor(modelId: string, config?: AwsBedrockConfig) {
    this.modelId = modelId;
    try {
      const mod = _require("@aws-sdk/client-bedrock-runtime");
      this.Cmds = mod;

      const region = config?.region ?? process.env.AWS_REGION ?? "us-east-1";
      const credentials =
        config?.accessKeyId || config?.secretAccessKey
          ? {
              accessKeyId: config.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID ?? "",
              secretAccessKey: config.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY ?? "",
              ...(config?.sessionToken ? { sessionToken: config.sessionToken } : {}),
            }
          : undefined;

      this.client = new mod.BedrockRuntimeClient({ region, ...(credentials ? { credentials } : {}) });
    } catch (e: any) {
      if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error(
          "@aws-sdk/client-bedrock-runtime is required for AwsBedrockProvider. " +
            "Install it: npm install @aws-sdk/client-bedrock-runtime",
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
        const status = err?.$metadata?.httpStatusCode ?? err?.statusCode;
        const isRetryable =
          status === 429 ||
          status === 500 ||
          status === 502 ||
          status === 503 ||
          err?.name === "ThrottlingException" ||
          err?.name === "ServiceUnavailableException" ||
          err?.code === "ECONNRESET" ||
          err?.code === "ETIMEDOUT";
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
    const { system, converseMessages } = this.toConverseMessages(messages);

    const input: Record<string, unknown> = {
      modelId: this.modelId,
      messages: converseMessages,
    };

    if (system.length > 0) input.system = system;

    const inferenceConfig: Record<string, unknown> = {};
    if (options?.maxTokens !== undefined) inferenceConfig.maxTokens = options.maxTokens;
    if (options?.temperature !== undefined) inferenceConfig.temperature = options.temperature;
    if (options?.topP !== undefined) inferenceConfig.topP = options.topP;
    if (options?.stop) inferenceConfig.stopSequences = options.stop;
    if (Object.keys(inferenceConfig).length > 0) input.inferenceConfig = inferenceConfig;

    if (options?.tools?.length) {
      input.toolConfig = {
        tools: options.tools.map((t) => ({
          toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.parameters } },
        })),
      };
    }

    const { ConverseCommand } = this.Cmds;
    const response = await this.withRetry(() => this.client.send(new ConverseCommand(input)));
    return this.normalizeResponse(response);
  }

  async *stream(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): AsyncGenerator<StreamChunk> {
    const { system, converseMessages } = this.toConverseMessages(messages);

    const input: Record<string, unknown> = {
      modelId: this.modelId,
      messages: converseMessages,
    };

    if (system.length > 0) input.system = system;

    const inferenceConfig: Record<string, unknown> = {};
    if (options?.maxTokens !== undefined) inferenceConfig.maxTokens = options.maxTokens;
    if (options?.temperature !== undefined) inferenceConfig.temperature = options.temperature;
    if (options?.topP !== undefined) inferenceConfig.topP = options.topP;
    if (options?.stop) inferenceConfig.stopSequences = options.stop;
    if (Object.keys(inferenceConfig).length > 0) input.inferenceConfig = inferenceConfig;

    if (options?.tools?.length) {
      input.toolConfig = {
        tools: options.tools.map((t) => ({
          toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.parameters } },
        })),
      };
    }

    const { ConverseStreamCommand } = this.Cmds;
    const response = await this.withRetry<any>(() => this.client.send(new ConverseStreamCommand(input)));

    let currentToolId = "";
    let currentToolName = "";

    for await (const event of response.stream ?? []) {
      if (event.contentBlockStart?.start?.toolUse) {
        const tu = event.contentBlockStart.start.toolUse;
        currentToolId = tu.toolUseId ?? "";
        currentToolName = tu.name ?? "";
        yield { type: "tool_call_start", toolCall: { id: currentToolId, name: currentToolName } };
      } else if (event.contentBlockDelta?.delta?.toolUse?.input) {
        yield {
          type: "tool_call_delta",
          toolCallId: currentToolId,
          argumentsDelta: event.contentBlockDelta.delta.toolUse.input,
        };
      } else if (event.contentBlockDelta?.delta?.text) {
        yield { type: "text", text: event.contentBlockDelta.delta.text };
      } else if (event.contentBlockStop && currentToolId) {
        yield { type: "tool_call_end", toolCallId: currentToolId };
        currentToolId = "";
      } else if (event.messageStop) {
        const reason = event.messageStop.stopReason;
        let finishReason: string = "stop";
        if (reason === "tool_use") finishReason = "tool_calls";
        else if (reason === "max_tokens") finishReason = "length";
        else if (reason === "end_turn") finishReason = "stop";
        yield { type: "finish", finishReason, usage: undefined };
      } else if (event.metadata?.usage) {
        const u = event.metadata.usage;
        const usage: TokenUsage = {
          promptTokens: u.inputTokens ?? 0,
          completionTokens: u.outputTokens ?? 0,
          totalTokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
          providerMetrics: { ...u, ...event.metadata },
        };
        yield { type: "finish", finishReason: "stop", usage };
      }
    }
  }

  private toConverseMessages(messages: ChatMessage[]): {
    system: unknown[];
    converseMessages: unknown[];
  } {
    const system: unknown[] = [];
    const converseMessages: unknown[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        const text = getTextContent(msg.content);
        if (text) system.push({ text });
        continue;
      }

      if (msg.role === "user") {
        converseMessages.push({
          role: "user",
          content: [{ text: getTextContent(msg.content) ?? "" }],
        });
        continue;
      }

      if (msg.role === "assistant") {
        const content: unknown[] = [];
        if (msg.content) content.push({ text: msg.content });
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            content.push({ toolUse: { toolUseId: tc.id, name: tc.name, input: tc.arguments } });
          }
        }
        if (content.length === 0) content.push({ text: "" });
        converseMessages.push({ role: "assistant", content });
        continue;
      }

      if (msg.role === "tool") {
        converseMessages.push({
          role: "user",
          content: [
            {
              toolResult: {
                toolUseId: msg.toolCallId,
                content: [{ text: getTextContent(msg.content) ?? "" }],
              },
            },
          ],
        });
      }
    }

    return { system, converseMessages };
  }

  private normalizeResponse(response: any): ModelResponse {
    const output = response.output?.message;
    const toolCalls: ToolCall[] = [];
    let textContent = "";

    for (const block of output?.content ?? []) {
      if (block.text) textContent += block.text;
      else if (block.toolUse) {
        toolCalls.push({
          id: block.toolUse.toolUseId,
          name: block.toolUse.name,
          arguments: block.toolUse.input ?? {},
        });
      }
    }

    const usage: TokenUsage = {
      promptTokens: response.usage?.inputTokens ?? 0,
      completionTokens: response.usage?.outputTokens ?? 0,
      totalTokens: (response.usage?.inputTokens ?? 0) + (response.usage?.outputTokens ?? 0),
      providerMetrics: response.usage ? { ...response.usage } : undefined,
    };

    let finishReason: ModelResponse["finishReason"] = "stop";
    if (response.stopReason === "tool_use") finishReason = "tool_calls";
    else if (response.stopReason === "max_tokens") finishReason = "length";

    return {
      message: {
        role: "assistant",
        content: textContent || null,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      usage,
      finishReason,
      raw: response,
    };
  }
}
