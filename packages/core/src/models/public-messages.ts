import { randomUUID } from "node:crypto";
import type { ModelProvider } from "./provider.js";
import { getTextContent, type ModelResponse, type StreamChunk } from "./types.js";

export type PublicMessagePhase = "commentary" | "final" | "reasoning_summary";
export interface PublicMessage {
  id: string;
  phase: PublicMessagePhase;
  text: string;
}
export type PublicMessageEvent =
  | { type: "message.started"; id: string; phase: PublicMessagePhase | "pending" }
  | { type: "message.delta"; id: string; text: string }
  | { type: "message.completed"; message: PublicMessage; artifactId?: string }
  | { type: "message.failed"; id: string; reason: "cancelled" | "interrupted" };

export interface CommunicationCapabilities {
  /** Inferred phases classify complete tool responses; native phases can label standalone commentary. */
  messagePhases: "native" | "inferred" | "conditional";
  reasoningSummaries: "supported" | "unsupported" | "conditional";
}
/** Unknown adapters explicitly report no public-summary support. Raw thinking is never a substitute. */
export function getCommunicationCapabilities(provider: ModelProvider): CommunicationCapabilities {
  return provider.communicationCapabilities ?? { messagePhases: "inferred", reasoningSummaries: "unsupported" };
}

export function publicMessagesFromResponse(response: ModelResponse): PublicMessage[] {
  if (response.publicMessages) {
    const prefix = randomUUID();
    return response.publicMessages.map((message) => ({ ...message, id: `${prefix}:${message.id}` }));
  }
  const text = getTextContent(response.message.content);
  return text
    ? [
        {
          id: randomUUID(),
          phase: response.message.phase ?? (response.message.toolCalls?.length ? "commentary" : "final"),
          text,
        },
      ]
    : [];
}

/** Per-model-call lifecycle. Replay envelopes are deliberately not accepted by this collector. */
export class PublicMessageStream {
  private items = new Map<string, { id: string; text: string; phase: PublicMessagePhase | "pending" }>();
  private prefix = randomUUID();
  private ended = false;
  readonly messages: PublicMessage[] = [];

  consume(chunk: StreamChunk): PublicMessageEvent[] {
    if (this.ended) return [];
    if (chunk.type === "text" || chunk.type === "reasoning_summary") {
      const phase = chunk.type === "reasoning_summary" ? "reasoning_summary" : (chunk.phase ?? "pending");
      return this.delta(chunk.itemId ?? (chunk.type === "text" ? "text" : "summary"), chunk.text, phase);
    }
    if (chunk.type !== "finish") return [];
    const events: PublicMessageEvent[] = [];
    if (chunk.publicMessages) {
      for (const message of chunk.publicMessages) {
        const key = message.id;
        const prior = this.items.get(key);
        if (prior && !message.text.startsWith(prior.text))
          throw new Error("Provider rewrote streamed public message content");
        events.push(...this.delta(key, message.text.slice(prior?.text.length ?? 0), message.phase));
        const item = this.items.get(key);
        if (item) item.phase = message.phase;
      }
    }
    for (const item of this.items.values()) {
      const message: PublicMessage = {
        id: item.id,
        phase:
          item.phase === "pending"
            ? (chunk.phase ?? (chunk.finishReason === "tool_calls" ? "commentary" : "final"))
            : item.phase,
        text: item.text,
      };
      this.messages.push(message);
      events.push({ type: "message.completed", message });
    }
    this.ended = true;
    return events;
  }

  fail(cancelled: boolean): PublicMessageEvent[] {
    if (this.ended) return [];
    this.ended = true;
    return [...this.items.values()].map((item) => ({
      type: "message.failed",
      id: item.id,
      reason: cancelled ? "cancelled" : "interrupted",
    }));
  }

  private delta(key: string, text: string, phase: PublicMessagePhase | "pending"): PublicMessageEvent[] {
    const events: PublicMessageEvent[] = [];
    let item = this.items.get(key);
    if (!item) {
      item = { id: `${this.prefix}:${key}`, text: "", phase };
      this.items.set(key, item);
      events.push({ type: "message.started", id: item.id, phase });
    }
    item.text += text;
    // Bound individual deltas for event stores and transports.
    for (let offset = 0; offset < text.length; offset += 8192)
      events.push({ type: "message.delta", id: item.id, text: text.slice(offset, offset + 8192) });
    return events;
  }
}
