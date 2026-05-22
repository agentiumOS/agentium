import type { RunContext } from "../agent/run-context.js";
import type { RunOpts, RunOutput } from "../agent/types.js";
import type { EventBus } from "../events/event-bus.js";
import type { ChatMessage, TokenUsage } from "../models/types.js";
import { type HandoffConfig, type HandoffResult, HandoffSignal, type HandoffTarget } from "./types.js";

export class HandoffManager {
  private targets: Map<string, HandoffTarget>;
  private maxHandoffs: number;
  private carryMessages: boolean;
  private carrySessionState: boolean;

  constructor(config: HandoffConfig) {
    this.targets = new Map(config.targets.map((t) => [t.agent.name, t]));
    this.maxHandoffs = config.maxHandoffs ?? 5;
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
  ): Promise<HandoffResult> {
    const chain: string[] = [sourceAgent];
    const visited = new Set<string>();
    visited.add(sourceAgent);
    let currentSignal: HandoffSignal | null = signal;
    let accumulatedUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let lastOutput: RunOutput | null = null;

    for (let hop = 0; hop < this.maxHandoffs; hop++) {
      if (!currentSignal) break;

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

      const handoffContext = this.carryMessages
        ? `[System: Conversation handed off from "${chain[chain.length - 2]}". Reason: ${currentSignal.reason}]\n\nConversation so far:\n${this.summarizeMessages(conversationMessages)}\n\nLatest user request: ${originalInput}`
        : originalInput;

      try {
        const output = await target.agent.run(handoffContext, {
          sessionId: opts?.sessionId,
          userId: opts?.userId,
          metadata: {
            ...opts?.metadata,
            handoffChain: chain,
            handoffFrom: chain[chain.length - 2],
          },
        });

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
      throw new Error(`Maximum handoffs (${this.maxHandoffs}) exceeded. Chain: ${chain.join(" → ")}`);
    }

    const finalAgent = chain[chain.length - 1];

    eventBus.emit("handoff.complete" as any, {
      runId: ctx.runId,
      chain,
      finalAgent,
    });

    return {
      text: lastOutput?.text ?? "",
      toolCalls: lastOutput?.toolCalls ?? [],
      usage: accumulatedUsage,
      thinking: lastOutput?.thinking,
      durationMs: lastOutput?.durationMs,
      handoffChain: chain,
      finalAgent,
    };
  }

  private summarizeMessages(messages: ChatMessage[]): string {
    return messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-10)
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
