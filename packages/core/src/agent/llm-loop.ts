import { randomUUID } from "node:crypto";
import type { CheckpointManager } from "../checkpoint/checkpoint-manager.js";
import { validateConversationTransform } from "../context/conversation-transform.js";
import { meteredGenerate, meteredStream } from "../cost/accounting.js";
import { getAccountingContext } from "../cost/context.js";
import { getHandoffControl, setHandoffControl } from "../handoff/control.js";
import type { HandoffSignal } from "../handoff/types.js";
import type { Logger } from "../logger/logger.js";
import type { ModelProvider } from "../models/provider.js";
import {
  type PublicMessage,
  type PublicMessageEvent,
  PublicMessageStream,
  publicMessagesFromResponse,
} from "../models/public-messages.js";
import {
  type ChatMessage,
  getTextContent,
  type ModelConfig,
  type ProviderOptions,
  type ReasoningConfig,
  type StreamChunk,
  type ToolDefinition,
} from "../models/types.js";
import { convertJsonSchema } from "../tools/json-schema.js";
import { type AgentiumSchema, parseSchema } from "../tools/schema.js";
import type { ToolExecutor } from "../tools/tool-executor.js";
import type { ToolCallResult } from "../tools/types.js";
import { type RetryConfig, withRetry } from "../utils/retry.js";
import { RunCancelledError } from "./errors.js";
import type { RunContext } from "./run-context.js";
import type { LoopHooks, RunOutput, ToolResultLimitConfig } from "./types.js";

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
  private structuredOutput?: AgentiumSchema;
  private logger?: Logger;
  private reasoning?: ReasoningConfig;
  private providerOptions?: ProviderOptions;
  private billingContext?: ModelConfig["billingContext"];
  private retry?: Partial<RetryConfig>;
  private toolResultLimit?: ToolResultLimitConfig;
  private loopHooks?: LoopHooks;
  private checkpointManager?: CheckpointManager;
  private controlledExecution: boolean;
  // The Agent creates a fresh loop per run; reflection reuses this same run budget.
  private controlledToolRoundtrips = 0;

  constructor(
    provider: ModelProvider,
    toolExecutor: ToolExecutor | null,
    options: {
      maxToolRoundtrips: number;
      temperature?: number;
      maxTokens?: number;
      structuredOutput?: AgentiumSchema;
      logger?: Logger;
      reasoning?: ReasoningConfig;
      providerOptions?: ProviderOptions;
      billingContext?: ModelConfig["billingContext"];
      retry?: Partial<RetryConfig>;
      toolResultLimit?: ToolResultLimitConfig;
      loopHooks?: LoopHooks;
      checkpointManager?: CheckpointManager;
      controlledExecution?: boolean;
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
    this.providerOptions = options.providerOptions;
    this.billingContext = options.billingContext;
    this.retry = options.retry;
    this.toolResultLimit = options.toolResultLimit;
    this.loopHooks = options.loopHooks;
    this.checkpointManager = options.checkpointManager;
    this.controlledExecution = options.controlledExecution ?? false;
  }

  private modelIdentity(provider: ModelProvider, ctx: RunContext) {
    return { runId: ctx.runId, modelCallId: randomUUID(), modelId: provider.modelId, providerId: provider.providerId };
  }
  private async generateObserved(
    provider: ModelProvider,
    messages: ChatMessage[],
    options: ModelConfig & { tools?: ToolDefinition[] },
    ctx: RunContext,
    purpose = "answer",
    operationId?: string,
  ) {
    const identity = this.modelIdentity(provider, ctx);
    ctx.eventBus.emit("model.start", identity);
    try {
      const response = await meteredGenerate(provider, messages, options, purpose, operationId);
      ctx.eventBus.emit("model.result", {
        ...identity,
        usage: response.usage,
        status: ctx.signal?.aborted ? "cancelled" : "success",
      });
      return response;
    } catch (error) {
      ctx.eventBus.emit("model.error", { ...identity, status: ctx.signal?.aborted ? "cancelled" : "error" });
      throw error;
    }
  }
  private async generateWithRetries(
    messages: ChatMessage[],
    options: ModelConfig & { tools?: ToolDefinition[] },
    ctx: RunContext,
  ) {
    const operationId = randomUUID();
    const tracker = getAccountingContext()?.tracker;
    const lifetime = `model-retry-operation:${operationId}`;
    tracker?.beginPendingAttempt(lifetime);
    try {
      return await withRetry(
        () => this.generateObserved(this.provider, messages, options, ctx, "answer", operationId),
        this.retry,
      );
    } finally {
      tracker?.endPendingAttempt(lifetime);
    }
  }

  private async *streamObserved(
    messages: ChatMessage[],
    options: ModelConfig & { tools?: ToolDefinition[] },
    ctx: RunContext,
  ): AsyncGenerator<StreamChunk> {
    const identity = this.modelIdentity(this.provider, ctx);
    let ended = false;
    let terminal: Extract<StreamChunk, { type: "finish" }> | undefined;
    ctx.eventBus.emit("model.start", identity);
    try {
      for await (const chunk of meteredStream(this.provider, messages, options, "answer")) {
        if (chunk.type === "finish") {
          terminal = { ...chunk, usage: chunk.usage ?? terminal?.usage };
        } else {
          yield chunk;
        }
      }
      ended = true;
      ctx.eventBus.emit("model.result", {
        ...identity,
        usage: terminal?.usage,
        status: ctx.signal?.aborted ? "cancelled" : "success",
      });
      if (terminal) yield terminal;
    } finally {
      if (!ended)
        ctx.eventBus.emit("model.error", {
          ...identity,
          usage: terminal?.usage,
          status: ctx.signal?.aborted ? "cancelled" : "error",
        });
    }
  }

  private publish(ctx: RunContext, event: PublicMessageEvent): void {
    ctx.eventBus.emit("run.message", { runId: ctx.runId, messageEvent: event });
    ctx.executionServices?.publishMessage?.(event);
  }

  private applySteering(ctx: RunContext, append: (message: ChatMessage) => void): boolean {
    if (!ctx.executionServices?.takeInput || ctx.runId !== ctx.executionServices.ctx.runId) return false;
    let applied = false;
    for (let input = ctx.executionServices.takeInput(ctx); input; input = ctx.executionServices.takeInput(ctx)) {
      append({ role: "user", content: input.input });
      applied = true;
    }
    return applied;
  }

  private claimControlledToolRoundtrip(): void {
    if (!this.controlledExecution) return;
    if (this.controlledToolRoundtrips >= this.maxToolRoundtrips) {
      throw new Error("Controlled tool roundtrip budget exhausted; no further tools executed");
    }
    this.controlledToolRoundtrips++;
  }

  private async limitToolResult(content: string, toolName: string, ctx: RunContext): Promise<string> {
    if (!this.toolResultLimit) return content;

    const maxChars = this.toolResultLimit.maxChars ?? DEFAULT_MAX_CHARS;
    if (content.length <= maxChars) return content;

    const strategy = this.toolResultLimit.strategy ?? "truncate";
    this.logger?.info(
      `Tool "${toolName}" result ${content.length} chars exceeds limit ${maxChars}, applying ${strategy}`,
    );

    if (strategy === "summarize" && this.toolResultLimit.model) {
      try {
        const response = await this.generateObserved(
          this.toolResultLimit.model,
          [
            { role: "system", content: SUMMARIZE_PROMPT },
            { role: "user", content: content.slice(0, 200_000) },
          ],
          { maxTokens: 4096, temperature: 0, signal: ctx.signal },
          ctx,
          "tool-result-summary",
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

  async run(messages: ChatMessage[], ctx: RunContext, apiKey?: string, transcript?: ChatMessage[]): Promise<RunOutput> {
    const allToolCalls: ToolCallResult[] = [];
    const publicMessages: PublicMessage[] = [];
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalReasoningTokens = 0;
    let totalCachedTokens = 0;
    let totalCacheWriteTokens = 0;
    let totalAudioInputTokens = 0;
    let totalAudioOutputTokens = 0;
    let thinkingContent = "";
    let timeToFirstTokenMs: number | undefined;
    let responseId: string | undefined;
    let lastProviderMetrics: Record<string, unknown> | undefined;
    const loopStartTime = Date.now();
    const currentMessages = !this.controlledExecution ? [...messages] : structuredClone(messages);
    // Canonical newly produced exchanges survive request-only compaction/hooks.
    const append = (message: ChatMessage): void => {
      currentMessages.push(message);
      transcript?.push(!this.controlledExecution ? message : structuredClone(message));
      ctx.executionServices?.recordConversation(ctx.runId, [message]);
    };
    const toolDefs = this.toolExecutor?.getToolDefinitions() ?? [];
    if (toolDefs.length > 0) {
      this.logger?.debug("llm", { tools: toolDefs.map((t) => t.name) });
    }

    let handoff: HandoffSignal | undefined;
    for (let roundtrip = 0; roundtrip <= this.maxToolRoundtrips; roundtrip++) {
      if (ctx.signal?.aborted) throw new RunCancelledError();

      this.applySteering(ctx, append);
      const mandatoryMessages = !this.controlledExecution ? undefined : structuredClone(currentMessages);
      // Hook: beforeLLMCall — allows message modification (e.g. context compaction, PII scrubbing)
      if (this.loopHooks?.beforeLLMCall) {
        const modified = await this.loopHooks.beforeLLMCall(currentMessages, roundtrip);
        if (modified && modified !== currentMessages) {
          currentMessages.length = 0;
          currentMessages.push(...modified);
        }
      }

      if (mandatoryMessages) validateConversationTransform(mandatoryMessages, currentMessages);

      const modelConfig: ModelConfig & { tools?: ToolDefinition[] } = {};
      if (this.billingContext) modelConfig.billingContext = this.billingContext;
      if (apiKey) modelConfig.apiKey = apiKey;
      if (this.temperature !== undefined) modelConfig.temperature = this.temperature;
      if (this.maxTokens !== undefined) modelConfig.maxTokens = this.maxTokens;
      if (toolDefs.length > 0) modelConfig.tools = toolDefs;
      if (this.reasoning) modelConfig.reasoning = this.reasoning;
      if (this.providerOptions) modelConfig.providerOptions = this.providerOptions;
      if (ctx.questions !== undefined) modelConfig.questions = ctx.questions;

      if (this.structuredOutput) {
        modelConfig.responseFormat = {
          type: "json_schema",
          schema: this.zodToJsonSchema(this.structuredOutput),
          name: "structured_response",
        };
      }

      const response = await this.generateWithRetries(currentMessages, { ...modelConfig, signal: ctx.signal }, ctx);

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
        this.logger?.debug(
          `[LLMLoop] Roundtrip 0 usage — prompt: ${response.usage.promptTokens}, completion: ${response.usage.completionTokens}, reasoning: ${response.usage.reasoningTokens ?? 0}`,
        );
      }

      totalPromptTokens += response.usage.promptTokens;
      totalCompletionTokens += response.usage.completionTokens;
      if (response.usage.reasoningTokens) totalReasoningTokens += response.usage.reasoningTokens;
      if (response.usage.cachedTokens) totalCachedTokens += response.usage.cachedTokens;
      if (response.usage.cacheWriteTokens) totalCacheWriteTokens += response.usage.cacheWriteTokens;
      if (response.usage.audioInputTokens) totalAudioInputTokens += response.usage.audioInputTokens;
      if (response.usage.audioOutputTokens) totalAudioOutputTokens += response.usage.audioOutputTokens;
      if (response.usage.providerMetrics) lastProviderMetrics = response.usage.providerMetrics;

      if ((response as any).thinking) {
        thinkingContent += (thinkingContent ? "\n" : "") + (response as any).thinking;
      }

      if (response.message.toolCalls?.length && (response.finishReason !== "tool_calls" || !this.toolExecutor)) {
        throw new Error("Incomplete or unsupported tool turn; no tools executed");
      }
      if (response.message.toolCalls?.length) this.claimControlledToolRoundtrip();
      append(response.message);
      for (const message of publicMessagesFromResponse(response)) {
        publicMessages.push(message);
        this.publish(ctx, { type: "message.started", id: message.id, phase: message.phase });
        for (let offset = 0; offset < message.text.length; offset += 8192)
          this.publish(ctx, { type: "message.delta", id: message.id, text: message.text.slice(offset, offset + 8192) });
        this.publish(ctx, { type: "message.completed", message });
      }

      if (response.finishReason !== "tool_calls" || !response.message.toolCalls?.length || !this.toolExecutor) {
        if (this.applySteering(ctx, append) || response.message.phase === "commentary") continue;
        const text = getTextContent(response.message.content);

        const usage = {
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          totalTokens: totalPromptTokens + totalCompletionTokens,
          ...(totalReasoningTokens > 0 ? { reasoningTokens: totalReasoningTokens } : {}),
          ...(totalCachedTokens > 0 ? { cachedTokens: totalCachedTokens } : {}),
          ...(totalCacheWriteTokens > 0 ? { cacheWriteTokens: totalCacheWriteTokens } : {}),
          ...(totalAudioInputTokens > 0 ? { audioInputTokens: totalAudioInputTokens } : {}),
          ...(totalAudioOutputTokens > 0 ? { audioOutputTokens: totalAudioOutputTokens } : {}),
          ...(lastProviderMetrics ? { providerMetrics: lastProviderMetrics } : {}),
        };

        const output: RunOutput = {
          text,
          publicMessages,
          toolCalls: allToolCalls,
          ...(response.decisions ? { decisions: response.decisions } : {}),
          usage: { ...usage, ...(response.usage.pricingKey ? { pricingKey: response.usage.pricingKey } : {}) },
          ...(timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : {}),
          ...(responseId ? { responseId } : {}),
        };

        if (thinkingContent) output.thinking = thinkingContent;

        if (this.structuredOutput && text) {
          try {
            const jsonStr = this.extractJson(text);
            const parsed = JSON.parse(jsonStr);
            output.structured = parseSchema(this.structuredOutput, parsed);
          } catch (e) {
            // structured parsing failed, raw text is still available
            this.logger?.warn?.(`Structured output parsing failed, falling back to raw text: ${(e as Error)?.message}`);
          }
        }

        ctx.executionServices?.finishInput?.(ctx);
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
            append({
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

      const execute = () => this.toolExecutor!.executeAll(filteredToolCalls, ctx);
      const toolResults = await (ctx.executionServices ? ctx.executionServices.runOwned(execute) : execute());

      allToolCalls.push(...toolResults);

      const argsById = new Map(filteredToolCalls.map((tc) => [tc.id, tc.arguments]));
      const recordedResults = new Set<string>();
      try {
        for (const result of toolResults) {
          await ctx.executionServices?.observeTool(result, ctx);
          let content = typeof result.result === "string" ? result.result : result.result.content;

          this.logger?.toolCall(result.toolName, argsById.get(result.toolCallId) ?? {});
          this.logger?.toolResult(result.toolName, typeof content === "string" ? content : JSON.stringify(content));

          if (typeof content === "string") {
            content = await this.limitToolResult(content, result.toolName, ctx);
          }

          // Hook: afterToolExec — allows transforming tool results
          if (this.loopHooks?.afterToolExec && typeof content === "string") {
            const transformed = await this.loopHooks.afterToolExec(result.toolName, content);
            if (transformed !== undefined) {
              content = transformed;
            }
          }

          append({
            role: "tool",
            content,
            toolCallId: result.toolCallId,
            name: result.toolName,
          });
          recordedResults.add(result.toolCallId);
        }
      } finally {
        // Observer failure or cancellation cannot orphan an already settled handoff batch.
        if (toolResults.some((result) => result.toolName === "transfer_to_agent" || getHandoffControl(result))) {
          for (const result of toolResults)
            if (!recordedResults.has(result.toolCallId)) {
              append({
                role: "tool",
                content: typeof result.result === "string" ? result.result : result.result.content,
                toolCallId: result.toolCallId,
                name: result.toolName,
              });
            }
        }
      }

      // The transcript contains the complete batch before any transfer is acted on.
      handoff = toolResults.map(getHandoffControl).find(Boolean);

      // Hook: onRoundtripComplete — enables cost auto-stop, checkpointing
      if (this.loopHooks?.onRoundtripComplete || this.checkpointManager) {
        const tokensSoFar = {
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          totalTokens: totalPromptTokens + totalCompletionTokens,
          ...(totalReasoningTokens > 0 ? { reasoningTokens: totalReasoningTokens } : {}),
          ...(totalCachedTokens > 0 ? { cachedTokens: totalCachedTokens } : {}),
          ...(totalCacheWriteTokens > 0 ? { cacheWriteTokens: totalCacheWriteTokens } : {}),
          ...(totalAudioInputTokens > 0 ? { audioInputTokens: totalAudioInputTokens } : {}),
          ...(totalAudioOutputTokens > 0 ? { audioOutputTokens: totalAudioOutputTokens } : {}),
          ...(lastProviderMetrics ? { providerMetrics: lastProviderMetrics } : {}),
        };
        await this.checkpointManager?.save({
          runId: ctx.runId,
          roundtrip,
          messages: structuredClone(currentMessages),
          tokenUsage: tokensSoFar,
          sessionState: structuredClone(ctx.sessionState),
        });
        const hookResult = await this.loopHooks?.onRoundtripComplete?.(roundtrip, tokensSoFar);
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
      if (handoff) break;
    }

    const lastAssistantMsg = [...currentMessages].reverse().find((m) => m.role === "assistant");

    const text = getTextContent(lastAssistantMsg?.content ?? null);

    const output: RunOutput = {
      text,
      publicMessages,
      toolCalls: allToolCalls,
      status: handoff ? "completed" : "stopped",
      usage: {
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        totalTokens: totalPromptTokens + totalCompletionTokens,
        ...(totalReasoningTokens > 0 ? { reasoningTokens: totalReasoningTokens } : {}),
        ...(totalCachedTokens > 0 ? { cachedTokens: totalCachedTokens } : {}),
        ...(totalCacheWriteTokens > 0 ? { cacheWriteTokens: totalCacheWriteTokens } : {}),
        ...(totalAudioInputTokens > 0 ? { audioInputTokens: totalAudioInputTokens } : {}),
        ...(totalAudioOutputTokens > 0 ? { audioOutputTokens: totalAudioOutputTokens } : {}),
        ...(lastProviderMetrics ? { providerMetrics: lastProviderMetrics } : {}),
      },
      ...(thinkingContent ? { thinking: thinkingContent } : {}),
      ...(timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : {}),
      ...(responseId ? { responseId } : {}),
    };
    if (handoff) setHandoffControl(output, handoff);
    return output;
  }

  async *stream(
    messages: ChatMessage[],
    ctx: RunContext,
    apiKey?: string,
    transcript?: ChatMessage[],
    collectedTools?: ToolCallResult[],
    outcome?: { status: "completed" | "stopped"; publicMessages?: PublicMessage[] },
    publicMessageEvents = false,
  ): AsyncGenerator<StreamChunk> {
    const currentMessages = !this.controlledExecution ? [...messages] : structuredClone(messages);
    // Canonical newly produced exchanges survive request-only compaction/hooks.
    const append = (message: ChatMessage): void => {
      currentMessages.push(message);
      transcript?.push(!this.controlledExecution ? message : structuredClone(message));
      ctx.executionServices?.recordConversation(ctx.runId, [message]);
    };
    const toolDefs = this.toolExecutor?.getToolDefinitions() ?? [];
    if (toolDefs.length > 0) {
      this.logger?.debug("llm.stream", { tools: toolDefs.map((t) => t.name) });
    }

    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalReasoningTokens = 0;
    let totalCachedTokens = 0;
    let totalCacheWriteTokens = 0;
    let totalAudioInputTokens = 0;
    let totalAudioOutputTokens = 0;
    let lastProviderMetrics: Record<string, unknown> | undefined;

    for (let roundtrip = 0; roundtrip <= this.maxToolRoundtrips; roundtrip++) {
      if (ctx.signal?.aborted) throw new RunCancelledError();

      this.applySteering(ctx, append);
      const mandatoryMessages = !this.controlledExecution ? undefined : structuredClone(currentMessages);
      // Hook: beforeLLMCall
      if (this.loopHooks?.beforeLLMCall) {
        const modified = await this.loopHooks.beforeLLMCall(currentMessages, roundtrip);
        if (modified && modified !== currentMessages) {
          currentMessages.length = 0;
          currentMessages.push(...modified);
        }
      }

      if (mandatoryMessages) validateConversationTransform(mandatoryMessages, currentMessages);

      const modelConfig: ModelConfig & { tools?: ToolDefinition[] } = {};
      if (this.billingContext) modelConfig.billingContext = this.billingContext;
      if (apiKey) modelConfig.apiKey = apiKey;
      if (this.temperature !== undefined) modelConfig.temperature = this.temperature;
      if (this.maxTokens !== undefined) modelConfig.maxTokens = this.maxTokens;
      if (toolDefs.length > 0) modelConfig.tools = toolDefs;
      if (this.reasoning) modelConfig.reasoning = this.reasoning;
      if (this.providerOptions) modelConfig.providerOptions = this.providerOptions;
      if (ctx.questions !== undefined) modelConfig.questions = ctx.questions;

      if (this.structuredOutput) {
        modelConfig.responseFormat = {
          type: "json_schema",
          schema: this.zodToJsonSchema(this.structuredOutput),
          name: "structured_response",
        };
      }

      let fullText = "";
      const pendingToolCalls: Array<{
        id: string;
        name: string;
        args: string;
      }> = [];
      let finishReason = "stop";
      let finished = false;
      let chunkUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      let providerExtras: Record<string, unknown> | undefined;

      const publicStream = new PublicMessageStream();
      let phase: "commentary" | "final" | undefined;
      const streamGen = this.streamObserved(currentMessages, { ...modelConfig, signal: ctx.signal }, ctx);

      try {
        for await (const chunk of streamGen) {
          for (const event of publicStream.consume(chunk)) {
            this.publish(ctx, event);
            if (event.type === "message.completed" && outcome) (outcome.publicMessages ??= []).push(event.message);
            if (publicMessageEvents) yield { type: "public_message", event };
          }
          if (chunk.type !== "reasoning_summary") yield chunk;

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
            finished = true;
            finishReason = chunk.finishReason;
            phase = chunk.phase;
            if (chunk.usage) chunkUsage = chunk.usage;
            if (chunk.providerExtras) providerExtras = chunk.providerExtras;
          }
        }
      } catch (error) {
        for (const event of publicStream.fail(Boolean(ctx.signal?.aborted))) {
          this.publish(ctx, event);
          if (publicMessageEvents) yield { type: "public_message", event };
        }
        throw error;
      } finally {
        for (const event of publicStream.fail(Boolean(ctx.signal?.aborted))) this.publish(ctx, event);
      }
      if (!finished && pendingToolCalls.length)
        throw new Error("Stream ended before tool calls completed; no tools executed");
      totalPromptTokens += chunkUsage.promptTokens;
      totalCompletionTokens += chunkUsage.completionTokens;
      if ((chunkUsage as any).reasoningTokens) totalReasoningTokens += (chunkUsage as any).reasoningTokens;
      if ((chunkUsage as any).cachedTokens) totalCachedTokens += (chunkUsage as any).cachedTokens;
      if ((chunkUsage as any).cacheWriteTokens) totalCacheWriteTokens += (chunkUsage as any).cacheWriteTokens;
      if ((chunkUsage as any).audioInputTokens) totalAudioInputTokens += (chunkUsage as any).audioInputTokens;
      if ((chunkUsage as any).audioOutputTokens) totalAudioOutputTokens += (chunkUsage as any).audioOutputTokens;
      if ((chunkUsage as any).providerMetrics) lastProviderMetrics = (chunkUsage as any).providerMetrics;

      if (pendingToolCalls.length && (finishReason !== "tool_calls" || !this.toolExecutor)) {
        throw new Error("Incomplete or unsupported streamed tool turn; no tools executed");
      }
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: fullText || null,
        ...(phase ? { phase } : {}),
        toolCalls: pendingToolCalls.map((tc) => {
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(tc.args || "{}");
          } catch {
            throw new Error(`Invalid streamed tool arguments for "${tc.name}"; no tools executed`);
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error(`Invalid streamed tool arguments for "${tc.name}"; expected an object`);
          }
          return { id: tc.id, name: tc.name, arguments: parsed };
        }),
        ...(providerExtras ? { providerExtras } : {}),
      };
      if (pendingToolCalls.length === 0) delete assistantMsg.toolCalls;
      else this.claimControlledToolRoundtrip();
      // Hook: afterLLMCall. Runtime-owned model observers run inside execution services.
      if (this.loopHooks?.afterLLMCall) {
        await this.loopHooks.afterLLMCall({ finishReason, usage: chunkUsage }, roundtrip);
      }
      append(assistantMsg);
      if (finishReason !== "tool_calls" || pendingToolCalls.length === 0 || !this.toolExecutor) {
        if (this.applySteering(ctx, append) || phase === "commentary") continue;
        ctx.executionServices?.finishInput?.(ctx);
        return;
      }
      if (ctx.signal?.aborted) throw new RunCancelledError();

      // Hook: beforeToolExec
      const allCalls = assistantMsg.toolCalls!;
      const filteredCalls: typeof allCalls = [];
      for (const tc of allCalls) {
        if (this.loopHooks?.beforeToolExec) {
          const hookResult = await this.loopHooks.beforeToolExec(tc.name, tc.arguments);
          if (hookResult?.skip) {
            append({
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

      const execute = () => this.toolExecutor!.executeAll(filteredCalls, ctx);
      const toolResults = await (ctx.executionServices ? ctx.executionServices.runOwned(execute) : execute());
      collectedTools?.push(...toolResults);

      const argsById = new Map(filteredCalls.map((tc) => [tc.id, tc.arguments]));
      const recordedResults = new Set<string>();
      try {
        for (const result of toolResults) {
          await ctx.executionServices?.observeTool(result, ctx);
          let content = typeof result.result === "string" ? result.result : result.result.content;

          this.logger?.toolCall(result.toolName, argsById.get(result.toolCallId) ?? {});
          this.logger?.toolResult(result.toolName, typeof content === "string" ? content : JSON.stringify(content));

          if (typeof content === "string") {
            content = await this.limitToolResult(content, result.toolName, ctx);
          }

          // Hook: afterToolExec
          if (this.loopHooks?.afterToolExec && typeof content === "string") {
            const transformed = await this.loopHooks.afterToolExec(result.toolName, content);
            if (transformed !== undefined) content = transformed;
          }

          append({
            role: "tool",
            content,
            toolCallId: result.toolCallId,
            name: result.toolName,
          });
          recordedResults.add(result.toolCallId);
        }
      } finally {
        // Observer failure or cancellation cannot orphan an already settled handoff batch.
        if (toolResults.some((result) => result.toolName === "transfer_to_agent" || getHandoffControl(result))) {
          for (const result of toolResults)
            if (!recordedResults.has(result.toolCallId)) {
              append({
                role: "tool",
                content: typeof result.result === "string" ? result.result : result.result.content,
                toolCallId: result.toolCallId,
                name: result.toolName,
              });
            }
        }
      }

      // Hook: onRoundtripComplete
      if (this.loopHooks?.onRoundtripComplete || this.checkpointManager) {
        const tokensSoFar = {
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          totalTokens: totalPromptTokens + totalCompletionTokens,
          ...(totalReasoningTokens > 0 ? { reasoningTokens: totalReasoningTokens } : {}),
          ...(totalCachedTokens > 0 ? { cachedTokens: totalCachedTokens } : {}),
          ...(totalCacheWriteTokens > 0 ? { cacheWriteTokens: totalCacheWriteTokens } : {}),
          ...(totalAudioInputTokens > 0 ? { audioInputTokens: totalAudioInputTokens } : {}),
          ...(totalAudioOutputTokens > 0 ? { audioOutputTokens: totalAudioOutputTokens } : {}),
          ...(lastProviderMetrics ? { providerMetrics: lastProviderMetrics } : {}),
        };
        await this.checkpointManager?.save({
          runId: ctx.runId,
          roundtrip,
          messages: structuredClone(currentMessages),
          tokenUsage: tokensSoFar,
          sessionState: structuredClone(ctx.sessionState),
        });
        const hookResult = await this.loopHooks?.onRoundtripComplete?.(roundtrip, tokensSoFar);
        if (hookResult?.stop) {
          if (outcome) outcome.status = "stopped";
          return;
        }
      }
      const handoff = toolResults.map(getHandoffControl).find(Boolean);
      if (handoff) {
        if (!outcome) throw new Error("Streaming handoff requires an Agent-owned outcome");
        setHandoffControl(outcome, handoff);
        return;
      }
    }
    if (outcome) outcome.status = "stopped";
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

  private zodToJsonSchema(schema: AgentiumSchema): Record<string, unknown> {
    return convertJsonSchema(schema).schema;
  }
}
