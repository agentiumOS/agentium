import type { RunContext } from "../agent/run-context.js";
import type { RunOpts, RunOutput } from "../agent/types.js";
import type { EventBus } from "../events/event-bus.js";
import type { ModelProvider } from "../models/provider.js";
import type { ChatMessage, StreamChunk, TokenUsage } from "../models/types.js";
import type { ApprovalManager } from "../tools/approval.js";
import { getHandoffScope, setHandoffScope } from "./control.js";
import { type HandoffConfig, type HandoffResult, HandoffSignal, type HandoffTarget } from "./types.js";

export class HandoffManager {
  private targets: Map<string, HandoffTarget>;
  private maxHandoffs: number;
  private carryMessages: boolean;
  private carrySessionState: boolean;

  constructor(config: HandoffConfig) {
    this.targets = new Map(config.targets.map((t) => [t.agent.name, t]));
    this.maxHandoffs = config.maxHandoffs ?? 5;
    if (!Number.isSafeInteger(this.maxHandoffs) || this.maxHandoffs < 0)
      throw new Error("maxHandoffs must be a non-negative safe integer");
    this.carryMessages = config.carryMessages ?? true;
    this.carrySessionState = config.carrySessionState ?? true;
  }

  getTarget(name: string): HandoffTarget | undefined {
    return this.targets.get(name);
  }

  async execute(
    signal: HandoffSignal,
    sourceAgent: string,
    originalInput: string,
    conversationMessages: ChatMessage[],
    ctx: RunContext,
    eventBus: EventBus,
    opts?: RunOpts,
    approvals: readonly ApprovalManager[] = [],
  ): Promise<HandoffResult> {
    const inherited = getHandoffScope(opts);
    const chain = [...(inherited?.chain ?? [sourceAgent])];
    const visited = new Set(chain);
    const maxHandoffs = Math.min(this.maxHandoffs, inherited?.remaining ?? this.maxHandoffs);
    const dispatchers = [...new Set([...(inherited?.approvals ?? []), ...approvals])];
    let currentSignal: HandoffSignal | null = signal;
    let accumulatedUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let lastOutput: RunOutput | null = null;

    for (let hop = 0; hop < maxHandoffs; hop++) {
      if (!currentSignal) break;
      ctx.signal?.throwIfAborted();

      if (visited.has(currentSignal.targetAgent)) {
        throw new Error(`Handoff cycle detected: ${[...visited, currentSignal.targetAgent].join(" → ")}`);
      }
      visited.add(currentSignal.targetAgent);

      const target = this.targets.get(currentSignal.targetAgent);
      if (!target) {
        throw new Error(
          `Handoff target "${currentSignal.targetAgent}" not found. Available: ${[...this.targets.keys()].join(", ")}`,
        );
      }

      chain.push(target.agent.name);

      eventBus.emit("handoff.transfer" as any, {
        runId: ctx.runId,
        fromAgent: chain[chain.length - 2],
        toAgent: target.agent.name,
        reason: currentSignal.reason,
      });

      if (target.onHandoff) {
        await target.onHandoff(ctx);
      }
      ctx.signal?.throwIfAborted();

      const handoffContext = this.carryMessages
        ? `[System: Conversation handed off from "${chain[chain.length - 2]}". Reason: ${currentSignal.reason}]\n\nConversation so far:\n${this.summarizeMessages(conversationMessages)}\n\nLatest user request: ${originalInput}`
        : originalInput;

      try {
        const targetOptions: RunOpts = {
          ...opts,
          sessionId: `${ctx.sessionId}:handoff:${target.agent.name}`,
          runId: undefined,
          history: undefined,
          userId: ctx.userId,
          tenantId: ctx.tenantId,
          signal: ctx.signal,
          runMode: ctx.runMode,
          executionPolicy: ctx === ctx.executionServices?.ctx ? undefined : ctx.executionPolicy,
          executionServices: ctx.executionServices,
          metadata: {
            ...opts?.metadata,
            ...ctx.metadata,
            parentRunId: ctx.runId,
            rootRunId: ctx.metadata.rootRunId ?? ctx.runId,
            handoffChain: [...chain],
            handoffFrom: chain[chain.length - 2],
          },
        };
        setHandoffScope(targetOptions, {
          chain: [...chain],
          remaining: maxHandoffs - hop - 1,
          approvals: dispatchers,
          ...(this.carrySessionState ? { state: structuredClone(ctx.sessionState) } : {}),
        });
        const output = await target.agent.run(handoffContext, targetOptions);

        accumulatedUsage = this.mergeUsage(accumulatedUsage, output.usage);
        lastOutput = output;
        currentSignal = null;
      } catch (err) {
        if (err instanceof HandoffSignal) {
          currentSignal = err;
        } else {
          throw err;
        }
      }
    }

    if (currentSignal) {
      throw new Error(`Maximum handoffs (${maxHandoffs}) exceeded. Chain: ${chain.join(" → ")}`);
    }

    if (lastOutput && "handoffChain" in lastOutput) {
      const nested = lastOutput as HandoffResult;
      chain.splice(0, chain.length, ...nested.handoffChain);
    }
    const finalAgent = chain[chain.length - 1];

    eventBus.emit("handoff.complete" as any, {
      runId: ctx.runId,
      chain,
      finalAgent,
    });

    return {
      text: lastOutput?.text ?? "",
      structured: lastOutput?.structured,
      status: lastOutput?.status,
      toolCalls: lastOutput?.toolCalls ?? [],
      usage: accumulatedUsage,
      thinking: lastOutput?.thinking,
      durationMs: lastOutput?.durationMs,
      handoffChain: chain,
      finalAgent,
    };
  }

  /** Continue a live Agent stream after a fully authorized, settled transfer batch. */
  async *stream(
    signal: HandoffSignal,
    sourceAgent: string,
    originalInput: string,
    conversationMessages: ChatMessage[],
    ctx: RunContext,
    eventBus: EventBus,
    opts?: RunOpts,
    approvals: readonly ApprovalManager[] = [],
    transcript: ChatMessage[] = [],
    sourceModel?: ModelProvider,
  ): AsyncGenerator<StreamChunk, HandoffResult> {
    if (ctx.executionServices)
      throw new Error("Streaming handoff requires host-owned delegation inside execution services");
    ctx.signal?.throwIfAborted();
    const inherited = getHandoffScope(opts);
    const chain = [...(inherited?.chain ?? [sourceAgent])];
    const remaining = Math.min(this.maxHandoffs, inherited?.remaining ?? this.maxHandoffs);
    if (remaining === 0) throw new Error(`Maximum handoffs (${remaining}) exceeded. Chain: ${chain.join(" → ")}`);
    if (chain.includes(signal.targetAgent))
      throw new Error(`Handoff cycle detected: ${[...chain, signal.targetAgent].join(" → ")}`);
    const target = this.targets.get(signal.targetAgent);
    if (!target) throw new Error(`Handoff target "${signal.targetAgent}" not found`);
    chain.push(target.agent.name);
    eventBus.emit("handoff.transfer", {
      runId: ctx.runId,
      fromAgent: sourceAgent,
      toAgent: target.agent.name,
      reason: signal.reason,
    });
    await target.onHandoff?.(ctx);
    ctx.signal?.throwIfAborted();
    const shareProviderHistory = sourceModel !== undefined && target.agent.model === sourceModel && !opts?.apiKey;
    const history = this.carryMessages
      ? portableHandoffMessages(conversationMessages, shareProviderHistory)
      : undefined;
    const targetTranscript: ChatMessage[] = [];
    let completed: RunOutput | undefined;
    const targetOptions: RunOpts = {
      ...opts,
      // The target owns its model credentials and instructions. Conversation state is explicit.
      apiKey: undefined,
      ephemeral: true,
      history,
      sessionId: `${ctx.sessionId}:handoff:${target.agent.name}`,
      runId: undefined,
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      signal: ctx.signal,
      runMode: ctx.runMode,
      executionPolicy: ctx.executionPolicy,
      executionServices: undefined,
      metadata: {
        ...opts?.metadata,
        ...ctx.metadata,
        parentRunId: ctx.runId,
        rootRunId: ctx.metadata.rootRunId ?? ctx.runId,
        handoffChain: [...chain],
        handoffFrom: sourceAgent,
        handoffReason: signal.reason,
      },
    };
    setHandoffScope(targetOptions, {
      chain,
      remaining: remaining - 1,
      approvals: [...new Set([...(inherited?.approvals ?? []), ...approvals])],
      ...(this.carrySessionState ? { state: structuredClone(ctx.sessionState) } : {}),
      stream: {
        continuation: Boolean(history?.length),
        transcript: targetTranscript,
        complete(output) {
          completed = output;
        },
      },
    });
    try {
      // Delegation stays lazy: each next/return/throw reaches the target iterator directly.
      yield* target.agent.stream(originalInput, targetOptions);
      ctx.signal?.throwIfAborted();
      if (!completed) throw new Error("Handoff target stream ended without a completed lifecycle");
      const nestedChain =
        "handoffChain" in completed &&
        Array.isArray(completed.handoffChain) &&
        completed.handoffChain.every((name: unknown) => typeof name === "string")
          ? completed.handoffChain
          : chain;
      const finalAgent = nestedChain[nestedChain.length - 1];
      const result: HandoffResult = { ...completed, handoffChain: nestedChain, finalAgent };
      eventBus.emit("handoff.complete", { runId: ctx.runId, chain: nestedChain, finalAgent });
      return result;
    } finally {
      // On failure/caller return retain only completed tool groups, never an unvalidated final answer.
      transcript.push(
        ...portableHandoffMessages(
          completed ? targetTranscript : settledHandoffPrefix(targetTranscript),
          shareProviderHistory,
        ),
      );
    }
  }

  private summarizeMessages(messages: ChatMessage[]): string {
    return messages
      .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "tool")
      .slice(-20)
      .map((m) => {
        const content = typeof m.content === "string" ? m.content : "[multimodal]";
        return `${m.role}: ${content}`;
      })
      .join("\n");
  }

  private mergeUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
    return {
      promptTokens: a.promptTokens + b.promptTokens,
      completionTokens: a.completionTokens + b.completionTokens,
      totalTokens: a.totalTokens + b.totalTokens,
      ...(a.reasoningTokens || b.reasoningTokens
        ? { reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0) }
        : {}),
    };
  }
}

/** Portable conversation data; provider-private replay envelopes belong to their originating agent. */
function portableHandoffMessages(messages: readonly ChatMessage[], preserveProviderExtras = false): ChatMessage[] {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      if (preserveProviderExtras) return structuredClone(message);
      const { providerExtras: _providerExtras, ...portable } = message;
      return structuredClone(portable);
    });
}

/** Largest complete prefix ending in a tool result; partial batches and final answers are excluded. */
export function settledHandoffPrefix(messages: readonly ChatMessage[]): ChatMessage[] {
  const pending = new Set<string>();
  let end = 0;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    for (const call of message.toolCalls ?? []) pending.add(call.id);
    if (message.role === "tool" && message.toolCallId) {
      pending.delete(message.toolCallId);
      if (pending.size === 0) end = index + 1;
    }
  }
  return messages.slice(0, end);
}
