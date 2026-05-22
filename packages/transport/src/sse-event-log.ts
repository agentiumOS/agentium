/**
 * Per-run in-memory ring buffer of SSE events. Each event gets a monotonically
 * increasing numeric `id` so clients can pass `Last-Event-ID` on reconnect and
 * replay missed events.
 *
 * Storage is intentionally in-process; for multi-instance deployments, plug a
 * Redis-backed implementation behind the same interface.
 */
export interface SSEEvent {
  /** Monotonic numeric ID. */
  id: number;
  /** Optional `event:` line value. Default omitted. */
  event?: string;
  /** Payload (will be JSON-stringified into the `data:` field). */
  payload: unknown;
  /** Wall-clock time the event was recorded. */
  recordedAt: number;
}

export interface SSEEventLog {
  /** Record a new event and return its assigned id. */
  record(runId: string, event: Omit<SSEEvent, "id" | "recordedAt">): SSEEvent;
  /** Return events for a run with id greater than `afterId`. */
  since(runId: string, afterId: number): SSEEvent[];
  /** All events for a run. */
  all(runId: string): SSEEvent[];
  /** Mark a run completed (frees buffers after `ttlMs`). */
  finalize(runId: string): void;
  /** Remove a run's buffer immediately. */
  drop(runId: string): void;
}

export interface InMemoryEventLogConfig {
  /** Max events kept per run. Oldest evicted when exceeded. Default: 1024. */
  maxEventsPerRun?: number;
  /** Milliseconds after finalize before a run's buffer is dropped. Default: 300_000 (5min). */
  ttlMs?: number;
}

export class InMemoryEventLog implements SSEEventLog {
  private buffers = new Map<string, SSEEvent[]>();
  private nextIds = new Map<string, number>();
  private finalizeTimers = new Map<string, NodeJS.Timeout>();
  private maxEvents: number;
  private ttlMs: number;

  constructor(config: InMemoryEventLogConfig = {}) {
    this.maxEvents = config.maxEventsPerRun ?? 1024;
    this.ttlMs = config.ttlMs ?? 5 * 60_000;
  }

  record(runId: string, event: Omit<SSEEvent, "id" | "recordedAt">): SSEEvent {
    const buf = this.buffers.get(runId) ?? [];
    const nextId = (this.nextIds.get(runId) ?? 0) + 1;
    const full: SSEEvent = { id: nextId, recordedAt: Date.now(), ...event };
    buf.push(full);
    if (buf.length > this.maxEvents) buf.splice(0, buf.length - this.maxEvents);
    this.buffers.set(runId, buf);
    this.nextIds.set(runId, nextId);
    return full;
  }

  since(runId: string, afterId: number): SSEEvent[] {
    const buf = this.buffers.get(runId) ?? [];
    return buf.filter((e) => e.id > afterId);
  }

  all(runId: string): SSEEvent[] {
    return this.buffers.get(runId) ?? [];
  }

  finalize(runId: string): void {
    const existing = this.finalizeTimers.get(runId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => this.drop(runId), this.ttlMs);
    // unref so we don't keep the process alive
    (t as any).unref?.();
    this.finalizeTimers.set(runId, t);
  }

  drop(runId: string): void {
    this.buffers.delete(runId);
    this.nextIds.delete(runId);
    const t = this.finalizeTimers.get(runId);
    if (t) clearTimeout(t);
    this.finalizeTimers.delete(runId);
  }
}

/** Format an `SSEEvent` for the wire. */
export function formatSSEEvent(ev: SSEEvent): string {
  let out = `id: ${ev.id}\n`;
  if (ev.event) out += `event: ${ev.event}\n`;
  const data = typeof ev.payload === "string" ? ev.payload : JSON.stringify(ev.payload);
  out += `data: ${data}\n\n`;
  return out;
}

/** Process-wide default log so multiple endpoints can share one buffer. */
export const defaultEventLog = new InMemoryEventLog();
