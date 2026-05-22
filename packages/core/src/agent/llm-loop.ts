import { createRequire } from "node:module";
import type { z } from "zod";
import type { Logger } from "../logger/logger.js";
import type { ModelProvider } from "../models/provider.js";
import {
  type ChatMessage,
  getTextContent,
  type ModelConfig,
  type ReasoningConfig,
  type StreamChunk,
  type ToolDefinition,
} from "../models/types.js";
import type { ToolExecutor } from "../tools/tool-executor.js";
import type { ToolCallResult } from "../tools/types.js";
import { type RetryConfig, withRetry } from "../utils/retry.js";
import { countTokens } from "../utils/token-counter.js";
import { RunCancelledError } from "./errors.js";
import type { RunContext } from "./run-context.js";
import type { LoopHooks, RunOutput, ToolResultLimitConfig } from "./types.js";

const _require = createRequire(import.meta.url);

const DEFAULT_MAX_CHARS = 20_000;

const SUMMARIZE_PROMPT = `Summarize the following tool output concisely, preserving all key data points, totals, and important details. Return structured data (tables, lists, key-value pairs) rather than prose when possible. Do NOT omit numeric values, IDs, or dates that appear in the data.

Tool output:
`;

/**
 * Smart-truncate a tool result string.
 * - JSON arrays: keeps first N items that fit, notes remainder.
 * - JSON objects with array values: truncates each array.
 * - Plain text: hard-cut with note.
 */
function smartTruncate(result: string, maxChars: number): string {
  const parsed = tryParseJson(result);

  if (Array.isArray(parsed)) {
    return truncateArray(parsed, maxChars);
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return truncateObject(parsed as Record<string, unknown>, maxChars);
  }

  return `${result.slice(0, maxChars)}\n\n... [truncated — ${(result.length - maxChars).toLocaleString()} more chars]`;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function truncateArray(arr: unknown[], maxChars: number): string {
  const total = arr.length;
  const kept: unknown[] = [];
  let size = 2; // "[]"

  for (const item of arr) {
    const itemStr = JSON.stringify(item);
    if (size + itemStr.length + 2 > maxChars && kept.length > 0) break;
    kept.push(item);
    size += itemStr.length + 2;
  }

  const omitted = total - kept.length;
  const result = JSON.stringify(kept, null, 2);
  if (omitted > 0) {
    return `${result}\n\n[Showing ${kept.length} of ${total} items — ${omitted} more omitted]`;
  }
  return result;
}

function truncateObject(obj: Record<string, unknown>, maxChars: number): string {
  const result: Record<string, unknown> = {};
  let hasArrays = false;

  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value) && value.length > 0) {
      hasArrays = true;
      const perKey = Math.floor(maxChars / Object.keys(obj).length);
      const truncated = truncateArray(value, perKey);
      const parsed = tryParseJson(truncated.split("\n\n[Showing")[0]);
      result[key] = parsed ?? value.slice(0, 5);
      if (value.length > (Array.isArray(parsed) ? (parsed as unknown[]).length : 5)) {
        result[`_${key}_note`] =
          `Showing ${Array.isArray(parsed) ? (parsed as unknown[]).length : 5} of ${value.length} items`;
      }
    } else {
      result[key] = value;
    }
  }

  if (!hasArrays) {
    const str = JSON.stringify(obj, null, 2);
    if (str.length <= maxChars) return str;
    return `${str.slice(0, maxChars)}\n\n... [truncated — ${(str.length - maxChars).toLocaleString()} more chars]`;
  }

  return JSON.stringify(result, null, 2);
}

export class LLMLoop {
  private provider: ModelProvider;
  private toolExecutor: ToolExecutor | null;
  private maxToolRoundtrips: number;
  private temperature?: number;
  private maxTokens?: number;
  private structuredOutput?: z.ZodSchema;
  private logger?: Logger;
  private reasoning?: ReasoningConfig;
  private retry?: Partial<RetryConfig>;
  private toolResultLimit?: ToolResultLimitConfig;
  private loopHooks?: LoopHooks;

  constructor(
    provider: ModelProvider,
    toolExecutor: ToolExecutor | null,
    options: {
      maxToolRoundtrips: number;
      temperature?: number;
      maxTokens?: number;
      structuredOutput?: z.ZodSchema;
      logger?: Logger;
      reasoning?: ReasoningConfig;
      retry?: Partial<RetryConfig>;
      toolResultLimit?: ToolResultLimitConfig;
      loopHooks?: LoopHooks;
    },
  ) {
    this.provider = provider;
    this.toolExecutor = toolExecutor;
    this.maxToolRoundtrips = options.maxToolRoundtrips;
    this.temperature = options.temperature;
    this.maxTokens = options.maxTokens;
    this.structuredOutput = options.structuredOutput;
    this.logger = options.logger;
    this.reasoning = options.reasoning;
    this.retry = options.retry;
    this.toolResultLimit = options.toolResultLimit;
    this.loopHooks = options.loopHooks;
  }

  private async limitToolResult(content: string, toolName: string): Promise<string> {
    if (!this.toolResultLimit) return content;

    const maxChars = this.toolResultLimit.maxChars ?? DEFAULT_MAX_CHARS;
    if (content.length <= maxChars) return content;

    const strategy = this.toolResultLimit.strategy ?? "truncate";
    this.logger?.info(
      `Tool "${toolName}" result ${content.length} chars exceeds limit ${maxChars}, applying ${strategy}`,
    );

    if (strategy === "summarize" && this.toolResultLimit.model) {
      try {
        const response = await this.toolResultLimit.model.generate(
          [
            { role: "system", content: SUMMARIZE_PROMPT },
            { role: "user", content: content.slice(0, 200_000) },
          ],
          { maxTokens: 4096, temperature: 0 },
        );
        const summary = getTextContent(response.message.content);
        if (summary) {
          this.logger?.info(`Summarized ${content.length} chars → ${summary.length} chars`);
          return summary;
        }
      } catch (e) {
        this.logger?.warn?.(`Summarization failed, falling back to truncation: ${(e as Error)?.message}`);
      }
    }

    return smartTruncate(content, maxChars);
  }

  async run(messages: ChatMessage[], ctx: RunContext, apiKey?: string): Promise<RunOutput> {
    const allToolCalls: ToolCallResult[] = [];
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalReasoningTokens = 0;
    let totalCachedTokens = 0;
    let totalAudioInputTokens = 0;
    let totalAudioOutputTokens = 0;
    let thinkingContent = "";
    let timeToFirstTokenMs: number | undefined;
    let responseId: string | undefined;
    let lastProviderMetrics: Record<string, unknown> | undefined;
    const loopStartTime = Date.now();
    const currentMessages = [...messages];
    const toolDefs = this.toolExecutor?.getToolDefinitions() ?? [];

    const toolDefsJson = JSON.stringify(toolDefs);
    console.log(
      `[LLMLoop] ${toolDefs.length} tool defs, serialized size: ${toolDefsJson.length} chars (~${countTokens(toolDefsJson)} tokens)`,
    );
    if (toolDefs.length > 0) {
      console.log(`[LLMLoop] Tool names: ${toolDefs.map((t) => t.name).join(", ")}`);
    }

    for (let roundtrip = 0; roundtrip <= this.maxToolRoundtrips; roundtrip++) {
      if (ctx.signal?.aborted) throw new RunCancelledError();

      // Hook: beforeLLMCall — allows message modification (e.g. context compaction, PII scrubbing)
      if (this.loopHooks?.beforeLLMCall) {
        const modified = await this.loopHooks.beforeLLMCall(currentMessages, roundtrip);
        if (modified) {
          currentMessages.length = 0;
          currentMessages.push(...modified);
        }
      }

      const modelConfig: ModelConfig & { tools?: ToolDefinition[] } = {};
      if (apiKey) modelConfig.apiKey = apiKey;
      if (this.temperature !== undefined) modelConfig.temperature = this.temperature;
      if (this.maxTokens !== undefined) modelConfig.maxTokens = this.maxTokens;
      if (toolDefs.length > 0) modelConfig.tools = toolDefs;
      if (this.reasoning) modelConfig.reasoning = this.reasoning;

      if (this.structuredOutput) {
        modelConfig.responseFormat = {
          type: "json_schema",
          schema: this.zodToJsonSchema(this.structuredOutput),
          name: "structured_response",
        };
      }

      const response = await withRetry(() => this.provider.generate(currentMessages, modelConfig), this.retry);

      if (roundtrip === 0) {
        timeToFirstTokenMs = Date.now() - loopStartTime;
        if (response.raw && typeof response.raw === "object" && "id" in (response.raw as any)) {
          responseId = (response.raw as any).id;
        }
      }

      // Hook: afterLLMCall
      if (this.loopHooks?.afterLLMCall) {
        await this.loopHooks.afterLLMCall({ finishReason: response.finishReason, usage: response.usage }, roundtrip);
      }

      if (roundtrip === 0) {
        console.log(
          `[LLMLoop] Roundtrip 0 usage — prompt: ${response.usage.promptTokens}, completion: ${response.usage.completionTokens}, reasoning: ${response.usage.reasoningTokens ?? 0}`,
        );
      }

      totalPromptTokens += response.usage.promptTokens;
      totalCompletionTokens += response.usage.completionTokens;
      if (response.usage.reasoningTokens) totalReasoningTokens += response.usage.reasoningTokens;
      if (response.usage.cachedTokens) totalCachedTokens += response.usage.cachedTokens;
      if (response.usage.audioInputTokens) totalAudioInputTokens += response.usage.audioInputTokens;
      if (response.usage.audioOutputTokens) totalAudioOutputTokens += response.usage.audioOutputTokens;
      if (response.usage.providerMetrics) lastProviderMetrics = response.usage.providerMetrics;

      if ((response as any).thinking) {
        thinkingContent += (thinkingContent ? "\n" : "") + (response as any).thinking;
      }

      currentMessages.push(response.message);

      if (response.finishReason !== "tool_calls" || !response.message.toolCalls?.length || !this.toolExecutor) {
        const text = getTextContent(response.message.content);

        const usage = {
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          totalTokens: totalPromptTokens + totalCompletionTokens + totalReasoningTokens,
          ...(totalReasoningTokens > 0 ? { reasoningTokens: totalReasoningTokens } : {}),
          ...(totalCachedTokens > 0 ? { cachedTokens: totalCachedTokens } : {}),
          ...(totalAudioInputTokens > 0 ? { audioInputTokens: totalAudioInputTokens } : {}),
          ...(totalAudioOutputTokens > 0 ? { audioOutputTokens: totalAudioOutputTokens } : {}),
          ...(lastProviderMetrics ? { providerMetrics: lastProviderMetrics } : {}),
        };

        const output: RunOutput = {
          text,
          toolCalls: allToolCalls,
          usage,
          ...(timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : {}),
          ...(responseId ? { responseId } : {}),
        };

        if (thinkingContent) output.thinking = thinkingContent;

        if (this.structuredOutput && text) {
          try {
            const jsonStr = this.extractJson(text);
            const parsed = JSON.parse(jsonStr);
            output.structured = this.structuredOutput.parse(parsed);
          } catch {
            // structured parsing failed, raw text is still available
          }
        }

        return output;
      }

      if (ctx.signal?.aborted) throw new RunCancelledError();

      // Hook: beforeToolExec — per-tool interception (skip individual tools)
      const toolCalls = response.message.toolCalls!;
      const filteredToolCalls: typeof toolCalls = [];
      for (const tc of toolCalls) {
        if (this.loopHooks?.beforeToolExec) {
          const hookResult = await this.loopHooks.beforeToolExec(tc.name, tc.arguments);
          if (hookResult?.skip) {
            allToolCalls.push({
              toolCallId: tc.id,
              toolName: tc.name,
              result: hookResult.result ?? "[skipped by hook]",
            });
            currentMessages.push({
              role: "tool",
              content: hookResult.result ?? "[skipped by hook]",
              toolCallId: tc.id,
              name: tc.name,
            });
            continue;
          }
        }
        filteredToolCalls.push(tc);
      }

      const toolResults = await this.toolExecutor.executeAll(filteredToolCalls, ctx);

      allToolCalls.push(...toolResults);

      for (const result of toolResults) {
        let content = typeof result.result === "string" ? result.result : result.result.content;

        this.logger?.toolCall(result.toolName, {});
        this.logger?.toolResult(result.toolName, typeof content === "string" ? content : JSON.stringify(content));

        if (typeof content === "string") {
          content = await this.limitToolResult(content, result.toolName);
        }

        // Hook: afterToolExec — allows transforming tool results
        if (this.loopHooks?.afterToolExec && typeof content === "string") {
          const transformed = await this.loopHooks.afterToolExec(result.toolName, content);
          if (transformed !== undefined) {
            content = transformed;
          }
        }

        currentMessages.push({
          role: "tool",
          content,
          toolCallId: result.toolCallId,
          name: result.toolName,
        });
      }

      // Hook: onRoundtripComplete — enables cost auto-stop, checkpointing
      if (this.loopHooks?.onRoundtripComplete) {
        const tokensSoFar = {
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          totalTokens: totalPromptTokens + totalCompletionTokens + totalReasoningTokens,
          ...(totalReasoningTokens > 0 ? { reasoningTokens: totalReasoningTokens } : {}),
          ...(totalCachedTokens > 0 ? { cachedTokens: totalCachedTokens } : {}),
          ...(totalAudioInputTokens > 0 ? { audioInputTokens: totalAudioInputTokens } : {}),
          ...(totalAudioOutputTokens > 0 ? { audioOutputTokens: totalAudioOutputTokens } : {}),
          ...(lastProviderMetrics ? { providerMetrics: lastProviderMetrics } : {}),
        };
        const hookResult = await this.loopHooks.onRoundtripComplete(roundtrip, tokensSoFar);
        if (hookResult?.stop) {
          const lastAssistant = currentMessages.filter((m) => m.role === "assistant").pop();
          const text = getTextContent(lastAssistant?.content ?? null);
          return {
            text,
            toolCalls: allToolCalls,
            usage: tokensSoFar,
            status: "stopped" as const,
            ...(thinkingContent ? { thinking: thinkingContent } : {}),
            ...(timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : {}),
            ...(responseId ? { responseId } : {}),
          };
        }
      }
    }

    const lastAssistantMsg = currentMessages.reverse().find((m) => m.role === "assistant");

    const text = getTextContent(lastAssistantMsg?.content ?? null);

    return {
      text,
      toolCalls: allToolCalls,
      usage: {
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        totalTokens: totalPromptTokens + totalCompletionTokens + totalReasoningTokens,
        ...(totalReasoningTokens > 0 ? { reasoningTokens: totalReasoningTokens } : {}),
        ...(totalCachedTokens > 0 ? { cachedTokens: totalCachedTokens } : {}),
        ...(totalAudioInputTokens > 0 ? { audioInputTokens: totalAudioInputTokens } : {}),
        ...(totalAudioOutputTokens > 0 ? { audioOutputTokens: totalAudioOutputTokens } : {}),
        ...(lastProviderMetrics ? { providerMetrics: lastProviderMetrics } : {}),
      },
      ...(thinkingContent ? { thinking: thinkingContent } : {}),
      ...(timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : {}),
      ...(responseId ? { responseId } : {}),
    };
  }

  async *stream(messages: ChatMessage[], ctx: RunContext, apiKey?: string): AsyncGenerator<StreamChunk> {
    const currentMessages = [...messages];
    const toolDefs = this.toolExecutor?.getToolDefinitions() ?? [];

    const toolDefsJsonStream = JSON.stringify(toolDefs);
    console.log(
      `[LLMLoop:stream] ${toolDefs.length} tool defs, serialized size: ${toolDefsJsonStream.length} chars (~${countTokens(toolDefsJsonStream)} tokens)`,
    );
    if (toolDefs.length > 0) {
      console.log(`[LLMLoop:stream] Tool names: ${toolDefs.map((t) => t.name).join(", ")}`);
    }

    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalReasoningTokens = 0;
    let totalCachedTokens = 0;
    let totalAudioInputTokens = 0;
    let totalAudioOutputTokens = 0;
    let lastProviderMetrics: Record<string, unknown> | undefined;

    for (let roundtrip = 0; roundtrip <= this.maxToolRoundtrips; roundtrip++) {
      if (ctx.signal?.aborted) throw new RunCancelledError();

      // Hook: beforeLLMCall
      if (this.loopHooks?.beforeLLMCall) {
        const modified = await this.loopHooks.beforeLLMCall(currentMessages, roundtrip);
        if (modified) {
          currentMessages.length = 0;
          currentMessages.push(...modified);
        }
      }

      const modelConfig: ModelConfig & { tools?: ToolDefinition[] } = {};
      if (apiKey) modelConfig.apiKey = apiKey;
      if (this.temperature !== undefined) modelConfig.temperature = this.temperature;
      if (this.maxTokens !== undefined) modelConfig.maxTokens = this.maxTokens;
      if (toolDefs.length > 0) modelConfig.tools = toolDefs;
      if (this.reasoning) modelConfig.reasoning = this.reasoning;

      let fullText = "";
      const pendingToolCalls: Array<{
        id: string;
        name: string;
        args: string;
      }> = [];
      let finishReason = "stop";
      let chunkUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

      const streamGen = this.provider.stream(currentMessages, modelConfig);

      for await (const chunk of streamGen) {
        yield chunk;

        if (chunk.type === "text") {
          fullText += chunk.text;
          ctx.eventBus.emit("run.stream.chunk", {
            runId: ctx.runId,
            chunk: chunk.text,
          });
        } else if (chunk.type === "tool_call_start") {
          pendingToolCalls.push({
            id: chunk.toolCall.id,
            name: chunk.toolCall.name,
            args: "",
          });
        } else if (chunk.type === "tool_call_delta") {
          const tc = pendingToolCalls.find((t) => t.id === chunk.toolCallId);
          if (tc) {
            tc.args += chunk.argumentsDelta;
          }
        } else if (chunk.type === "finish") {
          finishReason = chunk.finishReason;
          if (chunk.usage) chunkUsage = chunk.usage;
        }
      }

      totalPromptTokens += chunkUsage.promptTokens;
      totalCompletionTokens += chunkUsage.completionTokens;
      if ((chunkUsage as any).reasoningTokens) totalReasoningTokens += (chunkUsage as any).reasoningTokens;
      if ((chunkUsage as any).cachedTokens) totalCachedTokens += (chunkUsage as any).cachedTokens;
      if ((chunkUsage as any).audioInputTokens) totalAudioInputTokens += (chunkUsage as any).audioInputTokens;
      if ((chunkUsage as any).audioOutputTokens) totalAudioOutputTokens += (chunkUsage as any).audioOutputTokens;
      if ((chunkUsage as any).providerMetrics) lastProviderMetrics = (chunkUsage as any).providerMetrics;

      // Hook: afterLLMCall
      if (this.loopHooks?.afterLLMCall) {
        await this.loopHooks.afterLLMCall({ finishReason, usage: chunkUsage }, roundtrip);
      }

      if (finishReason !== "tool_calls" || pendingToolCalls.length === 0 || !this.toolExecutor) {
        return;
      }

      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: fullText || null,
        toolCalls: pendingToolCalls.map((tc) => {
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(tc.args || "{}");
          } catch {
            console.warn(`[LLMLoop] Failed to parse tool call args for "${tc.name}", using empty object`);
          }
          return { id: tc.id, name: tc.name, arguments: parsed };
        }),
      };
      currentMessages.push(assistantMsg);

      // Hook: beforeToolExec
      const allCalls = assistantMsg.toolCalls!;
      const filteredCalls: typeof allCalls = [];
      for (const tc of allCalls) {
        if (this.loopHooks?.beforeToolExec) {
          const hookResult = await this.loopHooks.beforeToolExec(tc.name, tc.arguments);
          if (hookResult?.skip) {
            currentMessages.push({
              role: "tool",
              content: hookResult.result ?? "[skipped by hook]",
              toolCallId: tc.id,
              name: tc.name,
            });
            continue;
          }
        }
        filteredCalls.push(tc);
      }

      const toolResults = await this.toolExecutor.executeAll(filteredCalls, ctx);

      for (const result of toolResults) {
        let content = typeof result.result === "string" ? result.result : result.result.content;

        const originalSize = typeof content === "string" ? content.length : JSON.stringify(content).length;
        console.log(
          `[LLMLoop:stream] Tool "${result.toolName}" result size: ${originalSize} chars (~${countTokens(typeof content === "string" ? content : JSON.stringify(content))} tokens)`,
        );

        if (typeof content === "string") {
          content = await this.limitToolResult(content, result.toolName);
          if (content.length < originalSize) {
            console.log(
              `[LLMLoop:stream] Tool "${result.toolName}" result limited: ${originalSize} → ${content.length} chars (~${countTokens(content)} tokens)`,
            );
          }
        }

        // Hook: afterToolExec
        if (this.loopHooks?.afterToolExec && typeof content === "string") {
          const transformed = await this.loopHooks.afterToolExec(result.toolName, content);
          if (transformed !== undefined) content = transformed;
        }

        currentMessages.push({
          role: "tool",
          content,
          toolCallId: result.toolCallId,
          name: result.toolName,
        });
      }

      // Hook: onRoundtripComplete
      if (this.loopHooks?.onRoundtripComplete) {
        const tokensSoFar = {
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          totalTokens: totalPromptTokens + totalCompletionTokens + totalReasoningTokens,
          ...(totalReasoningTokens > 0 ? { reasoningTokens: totalReasoningTokens } : {}),
          ...(totalCachedTokens > 0 ? { cachedTokens: totalCachedTokens } : {}),
          ...(totalAudioInputTokens > 0 ? { audioInputTokens: totalAudioInputTokens } : {}),
          ...(totalAudioOutputTokens > 0 ? { audioOutputTokens: totalAudioOutputTokens } : {}),
          ...(lastProviderMetrics ? { providerMetrics: lastProviderMetrics } : {}),
        };
        const hookResult = await this.loopHooks.onRoundtripComplete(roundtrip, tokensSoFar);
        if (hookResult?.stop) return;
      }

      const totalMsgText = currentMessages
        .map((m) => (typeof m.content === "string" ? (m.content ?? "") : ""))
        .join("");
      const totalMsgSize = totalMsgText.length;
      console.log(
        `[LLMLoop:stream] Roundtrip ${roundtrip + 1}: sending ${currentMessages.length} messages, total size: ${totalMsgSize} chars (~${countTokens(totalMsgText)} tokens)`,
      );
    }
  }

  private extractJson(text: string): string {
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) return fenceMatch[1].trim();

    const braceStart = text.indexOf("{");
    const braceEnd = text.lastIndexOf("}");
    if (braceStart !== -1 && braceEnd > braceStart) {
      return text.slice(braceStart, braceEnd + 1);
    }

    return text.trim();
  }

  private zodToJsonSchema(schema: z.ZodSchema): Record<string, unknown> {
    try {
      const { zodToJsonSchema } = _require("zod-to-json-schema");
      const result = zodToJsonSchema(schema, {
        target: "jsonSchema7",
        $refStrategy: "none",
      }) as Record<string, unknown>;
      delete result.$schema;
      return result;
    } catch (e: any) {
      if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error(
          "zod-to-json-schema is required for structured output. Install it: npm install zod-to-json-schema",
        );
      }
      throw e;
    }
  }
}
