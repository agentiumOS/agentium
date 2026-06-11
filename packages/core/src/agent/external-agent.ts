import { v4 as uuidv4 } from "uuid";
import { EventBus } from "../events/event-bus.js";
import type { MessageContent, StreamChunk, TokenUsage } from "../models/types.js";
import { registry, type ServableAgent } from "../serve.js";
import type { RunOpts, RunOutput } from "./types.js";

const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

export interface ExternalAgentConfig {
  name: string;
  /**
   * The agent's run logic — wrap a LangGraph graph invocation, a Claude Agent
   * SDK call, or any custom code. Return a plain string or a partial
   * RunOutput; missing fields are filled with sensible defaults.
   */
  run: (input: MessageContent, opts?: RunOpts) => Promise<string | Partial<RunOutput>>;
  /**
   * Optional native streaming. When omitted, `stream()` falls back to
   * running `run()` and yielding the full text as a single chunk.
   */
  stream?: (input: MessageContent, opts?: RunOpts) => AsyncIterable<StreamChunk>;
  /** Shown in registry descriptions and swagger docs. */
  instructions?: string;
  modelId?: string;
  providerId?: string;
  /** Auto-register in the global registry (default: true). */
  register?: boolean;
  /** Bring your own event bus; a fresh one is created otherwise. */
  eventBus?: EventBus;
}

/**
 * Wrap framework-external agent logic (LangGraph, Claude Agent SDK, plain
 * functions) into a `ServableAgent` so it gets Agentium's production surface:
 * registry, HTTP/Socket.IO gateways, queue workers, and observability —
 * without adopting the Agentium `Agent` class.
 *
 * @example
 * ```ts
 * const langGraphAgent = defineExternalAgent({
 *   name: "researcher",
 *   run: async (input) => {
 *     const result = await graph.invoke({ messages: [String(input)] });
 *     return result.messages.at(-1).content;
 *   },
 * });
 * // immediately servable: POST /agents/researcher/run
 * ```
 */
export function defineExternalAgent(config: ExternalAgentConfig): ServableAgent {
  const eventBus = config.eventBus ?? new EventBus();

  const normalize = (result: string | Partial<RunOutput>, runId: string, opts?: RunOpts): RunOutput => {
    const partial: Partial<RunOutput> = typeof result === "string" ? { text: result } : result;
    return {
      text: partial.text ?? "",
      toolCalls: partial.toolCalls ?? [],
      usage: partial.usage ?? ZERO_USAGE,
      runId: partial.runId ?? runId,
      agentName: config.name,
      sessionId: opts?.sessionId,
      userId: opts?.userId,
      status: partial.status ?? "completed",
      ...partial,
    } as RunOutput;
  };

  const agent: ServableAgent = {
    kind: "agent",
    name: config.name,
    eventBus,
    instructions: config.instructions,
    modelId: config.modelId,
    providerId: config.providerId,

    async run(input: MessageContent, opts?: RunOpts): Promise<RunOutput> {
      const runId = uuidv4();
      eventBus.emit("run.start", {
        runId,
        agentName: config.name,
        input: typeof input === "string" ? input : "(multimodal)",
      });
      try {
        const result = await config.run(input, opts);
        const output = normalize(result, runId, opts);
        eventBus.emit("run.complete", { runId, output });
        return output;
      } catch (error) {
        eventBus.emit("run.error", {
          runId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        throw error;
      }
    },

    async *stream(input: MessageContent, opts?: RunOpts): AsyncIterable<StreamChunk> {
      if (config.stream) {
        yield* config.stream(input, opts);
        return;
      }
      // Fallback: run to completion, emit the text as one chunk.
      const output = await agent.run(input, opts);
      if (output.text) yield { type: "text", text: output.text };
      yield { type: "finish", finishReason: "stop", usage: output.usage };
    },
  };

  if (config.register !== false) {
    registry.add(agent);
  }

  return agent;
}
