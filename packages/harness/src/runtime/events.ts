import { randomUUID } from "node:crypto";
import type { InputRequest, PublicMessageEvent, TokenUsage } from "@agentium/core";

/** Terminal result status. awaiting_input is legacy-only; new live waits use RunHandle.state. */
export type HarnessStatus = "completed" | "failed" | "cancelled" | "stopped" | "awaiting_input";
export interface HarnessReason {
  code: string;
  message: string;
}
export interface HarnessResult {
  status: HarnessStatus;
  text: string;
  structured?: unknown;
  artifacts?: readonly { id: string; mimeType?: string }[];
  reason?: HarnessReason;
  usage: TokenUsage;
  runId: string;
  sessionId: string;
  finalCursor: number;
  cleanupDiagnostics?: readonly string[];
}
export type HarnessEventPayload =
  | PublicMessageEvent
  | { type: "compaction.started"; compactionId: string; policyId: string; beforeTokens: number }
  | { type: "compaction.completed"; compactionId: string; policyId: string; afterTokens: number }
  | { type: "compaction.failed"; compactionId: string; policyId: string; reason: string }
  | { type: "run.started"; driverId: string }
  | { type: "text.delta"; text: string }
  | { type: "input.requested"; request: InputRequest }
  | { type: "input.resolved"; requestId: string }
  | { type: "run.resumed"; requestId: string }
  | { type: "input.received"; inputId: string; mode: "steer" | "follow_up" }
  | { type: "input.applied"; inputId: string; mode: "steer" | "follow_up" }
  | { type: "model.complete"; providerId: string; modelId: string; usage: TokenUsage }
  | { type: "tool.complete"; toolName: string; toolCallId: string; denied: boolean }
  | { type: "control"; operation: "cancel" | "follow_up" | "steer" | "replace"; reason?: string }
  | { type: "completion"; action: string; reason: string }
  | { type: "run.terminal"; result: HarnessResult };
export interface HarnessEvent {
  schemaVersion: 1;
  eventId: string;
  sequence: number;
  timestamp: number;
  sessionId: string;
  runId: string;
  attemptId: string;
  parentRunId?: string;
  rootRunId: string;
  payload: HarnessEventPayload;
}
export class HarnessEventGapError extends Error {
  readonly code = "event_gap";
  constructor(readonly earliestCursor: number) {
    super(`Event history gap; earliest available cursor is ${earliestCursor}`);
  }
}
/** Bounded in-process history; no durability, network delivery, or audio backpressure promise. */
export class InMemoryHarnessEventStore {
  readonly durable = false;
  private history: HarnessEvent[] = [];
  private sequence = 0;
  private finished = false;
  private listeners = new Set<() => void>();
  constructor(
    private identity: Omit<HarnessEvent, "schemaVersion" | "eventId" | "sequence" | "timestamp" | "payload">,
    readonly capacity = 256,
  ) {
    if (!Number.isInteger(capacity) || capacity < 2) throw new Error("Event capacity must be an integer >= 2");
  }
  get cursor(): number {
    return this.sequence;
  }
  append(payload: HarnessEventPayload): HarnessEvent {
    if (this.finished) throw new Error("Event stream is already terminal");
    const event: HarnessEvent = {
      ...this.identity,
      schemaVersion: 1,
      eventId: randomUUID(),
      sequence: ++this.sequence,
      timestamp: Date.now(),
      payload: structuredClone(payload),
    };
    this.history.push(event);
    if (this.history.length > this.capacity) this.history.shift();
    if (payload.type === "run.terminal") this.finished = true;
    for (const notify of this.listeners) notify();
    return structuredClone(event);
  }
  events(options: { after?: number } = {}): AsyncGenerator<HarnessEvent> {
    let cursor = options.after ?? 0;
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > this.sequence) throw new Error("Invalid event cursor");
    let closed = false;
    let queued: Promise<unknown> = Promise.resolve();
    let wake: (() => void) | undefined;
    const close = () => {
      closed = true;
      if (wake) {
        this.listeners.delete(wake);
        wake();
        wake = undefined;
      }
    };
    const iterator = {
      [Symbol.asyncIterator]() {
        return this;
      },
      [Symbol.asyncDispose]: async () => {
        close();
      },
      next: (): Promise<IteratorResult<HarnessEvent>> => {
        const result = queued.then(async (): Promise<IteratorResult<HarnessEvent>> => {
          while (!closed) {
            const earliest = this.history[0]?.sequence ?? 1;
            if (cursor < earliest - 1) {
              close();
              throw new HarnessEventGapError(earliest - 1);
            }
            const next = this.history.find((event) => event.sequence > cursor);
            if (next) {
              cursor = next.sequence;
              return { value: structuredClone(next), done: false };
            }
            if (this.finished) break;
            await new Promise<void>((resolve) => {
              wake = resolve;
              this.listeners.add(resolve);
            });
            if (wake) this.listeners.delete(wake);
            wake = undefined;
          }
          close();
          return { value: undefined, done: true };
        });
        queued = result.catch(() => {});
        return result;
      },
      return: async () => {
        close();
        return { value: undefined, done: true as const };
      },
      throw: async (error: unknown) => {
        close();
        throw error;
      },
    };
    return iterator as AsyncGenerator<HarnessEvent>;
  }
}
