import type { EventBus } from "@agentium/core";
import type { Trace } from "./types.js";
export interface TelemetryDiagnostic {
  code: string;
  dropped?: number;
  rejectedSpans?: number;
}
export interface TelemetryOptions {
  capture?: CapturePolicy;
  onDiagnostic?: (diagnostic: TelemetryDiagnostic) => void | Promise<void>;
  maxDiagnostics?: number;
}
export interface CapturePolicy {
  /** Payload capture is an explicit opt-in. Known credential fields are always removed. */
  mode?: "metadata" | "content";
  redact?: (path: string, value: unknown) => unknown;
  maxAttributeBytes?: number;
  maxTotalBytes?: number;
  maxAttributes?: number;
  maxTraceBytes?: number;
}
const metadata = new Set([
  "controllerCallId",
  "operation",
  "decision",
  "modelRole",
  "activeToolCount",
  "agentName",
  "runId",
  "parentRunId",
  "rootRunId",
  "attemptId",
  "sessionId",
  "userId",
  "tenantId",
  "toolName",
  "toolCallId",
  "modelCallId",
  "modelId",
  "providerId",
  "status",
  "runStatus",
  "errorType",
  "cached",
  "outputLength",
  "resultLength",
  "inputLength",
  "tokens",
  "promptTokens",
  "completionTokens",
  "reasoningTokens",
  "cachedTokens",
  "cacheWriteTokens",
  "assessmentId",
  "usageRevision",
  "pricingStatus",
  "usageStatus",
  "knownSubtotal",
  "total",
  "unpricedCount",
  "currency",
  "audioInputTokens",
  "audioOutputTokens",
  "cost",
  "durationMs",
  "fromAgent",
  "toAgent",
  "memberId",
  "finalAgent",
  "cachedId",
  "interrupted",
  "event",
  "revision",
]);
const secret = /password|secret|api.?key|authorization|cookie|credential|access.?token|refresh.?token|private.?key/i;
export function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}
export function boundedText(value: string, bytes: number): string {
  if (Buffer.byteLength(value) <= bytes) return value;
  let result = Buffer.from(value).subarray(0, bytes).toString("utf8");
  while (Buffer.byteLength(result) > bytes) result = result.slice(0, -1);
  return result;
}
export class Diagnostics {
  private reporting = false;
  private reports = 0;
  readonly counts: Record<string, number> = Object.create(null);
  private readonly max: number;
  constructor(private options: TelemetryOptions = {}) {
    this.max = positive(options.maxDiagnostics ?? 100, "maxDiagnostics");
  }
  report(code: string, details: Omit<TelemetryDiagnostic, "code"> = {}) {
    this.counts[code] = (this.counts[code] ?? 0) + 1;
    if (!this.options.onDiagnostic || this.reporting || this.reports >= this.max) return;
    this.reports++;
    this.reporting = true;
    try {
      Promise.resolve(this.options.onDiagnostic({ code, ...details })).then(
        () => {
          this.reporting = false;
        },
        () => {
          this.reporting = false;
        },
      );
    } catch {
      this.reporting = false;
    }
  }
}
export class Capture {
  readonly diagnostic: Diagnostics;
  private readonly policy: CapturePolicy;
  private readonly fieldBytes: number;
  private readonly totalBytes: number;
  private readonly fields: number;
  private readonly traceBytes: number;
  constructor(options: TelemetryOptions = {}) {
    this.policy = { ...options.capture };
    if (this.policy.mode && !["content", "metadata"].includes(this.policy.mode))
      throw new TypeError("Unknown capture mode");
    this.fieldBytes = positive(this.policy.maxAttributeBytes ?? 2048, "maxAttributeBytes");
    this.totalBytes = positive(this.policy.maxTotalBytes ?? 16384, "maxTotalBytes");
    this.fields = positive(this.policy.maxAttributes ?? 64, "maxAttributes");
    this.traceBytes = positive(this.policy.maxTraceBytes ?? 1_048_576, "maxTraceBytes");
    this.diagnostic = new Diagnostics(options);
  }
  attributes(input: Record<string, unknown> = {}): Record<string, unknown> {
    const output: Record<string, unknown> = Object.create(null);
    let bytes = 2;
    let count = 0;
    try {
      for (const key of Object.keys(input).slice(0, this.fields * 4)) {
        if (count >= this.fields) break;
        if (secret.test(key) || (this.policy.mode !== "content" && !metadata.has(key))) continue;
        try {
          let value = input[key];
          if (this.policy.redact) value = this.policy.redact(key, value);
          if (value === undefined) continue;
          const safe = this.value(value, key, 0, new Set(), { remaining: 256 });
          if (safe === undefined) continue;
          const json = JSON.stringify(safe);
          const bounded = Buffer.byteLength(json) > this.fieldBytes ? boundedText(json, this.fieldBytes) : safe;
          const fieldSize = Buffer.byteLength(JSON.stringify({ [key]: bounded }));
          if (bytes + fieldSize > this.totalBytes) {
            this.diagnostic.report("capture_dropped");
            continue;
          }
          output[boundedText(key, 128)] = bounded;
          count++;
          bytes += fieldSize;
        } catch {
          this.diagnostic.report("capture_failed");
        }
      }
    } catch {
      this.diagnostic.report("capture_failed");
    }
    return output;
  }
  private value(value: unknown, path: string, depth: number, seen: Set<object>, nodes: { remaining: number }): unknown {
    if (--nodes.remaining < 0 || depth > 4) return "[bounded]";
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") return boundedText(value, this.fieldBytes);
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    if (typeof value === "bigint") return value.toString();
    if (!value || typeof value !== "object") return undefined;
    if (typeof (value as { then?: unknown }).then === "function") {
      // Redactors are synchronous. Consume accidental rejections without retaining the payload.
      void Promise.resolve(value).catch(() => {});
      this.diagnostic.report("async_capture_rejected");
      return undefined;
    }
    if (seen.has(value)) return "[circular]";
    if (value instanceof Error)
      return this.value(
        {
          name: "Error",
          ...(this.policy.mode === "content" ? { message: boundedText(value.message, this.fieldBytes) } : {}),
        },
        path,
        depth + 1,
        seen,
        nodes,
      );
    if (ArrayBuffer.isView(value)) return "[binary omitted]";
    seen.add(value);
    if (Array.isArray(value))
      return value
        .slice(0, 32)
        .map((item, index) => this.value(item, `${path}.${index}`, depth + 1, seen, nodes) ?? null);
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).slice(0, this.fields)) {
      if (secret.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) continue;
      let item = (value as Record<string, unknown>)[key];
      if (this.policy.redact) item = this.policy.redact(`${path}.${key}`, item);
      const safe = this.value(item, `${path}.${key}`, depth + 1, seen, nodes);
      if (safe !== undefined) result[boundedText(key, 128)] = safe;
    }
    return result;
  }
  trace(trace: Trace): Trace {
    const result: Trace = {
      traceId: boundedText(trace.traceId, 128),
      rootSpanId: boundedText(trace.rootSpanId, 128),
      startTime: trace.startTime,
      endTime: trace.endTime,
      durationMs: trace.durationMs,
      metadata: this.attributes(trace.metadata),
      spans: [],
    };
    let bytes = Buffer.byteLength(JSON.stringify(result));
    for (const span of trace.spans.slice(0, 256)) {
      const safe = {
        traceId: boundedText(span.traceId, 128),
        spanId: boundedText(span.spanId, 128),
        parentSpanId: span.parentSpanId ? boundedText(span.parentSpanId, 128) : undefined,
        traceFlags: span.traceFlags,
        traceState: span.traceState ? boundedText(span.traceState, 512) : undefined,
        name: boundedText(span.name, 256),
        kind: span.kind,
        startTime: span.startTime,
        endTime: span.endTime,
        durationMs: span.durationMs,
        status: span.status,
        attributes: this.attributes(span.attributes),
        events: span.events.slice(0, 64).map((event) => ({
          name: boundedText(event.name, 128),
          timestamp: event.timestamp,
          attributes: this.attributes(event.attributes),
        })),
      };
      const size = Buffer.byteLength(JSON.stringify(safe));
      if (bytes + size > this.traceBytes) {
        this.diagnostic.report("trace_capture_dropped");
        continue;
      }
      bytes += size;
      result.spans.push(safe);
    }
    return result;
  }
}
/** One attachment per bus; detaching one never removes another bus's listeners. */
export class Attachments {
  private closed = false;
  private handlers = new Map<EventBus, (event: string, data: unknown) => void>();
  attach(bus: EventBus, handler: (event: string, data: unknown) => void) {
    if (this.closed) throw new Error("Telemetry observer is shut down");
    if (!this.handlers.has(bus)) {
      this.handlers.set(bus, handler);
      bus.onAny(handler);
    }
  }
  detach(bus: EventBus) {
    const handler = this.handlers.get(bus);
    if (handler) bus.offAny(handler);
    this.handlers.delete(bus);
  }
  close() {
    this.closed = true;
    for (const bus of this.handlers.keys()) this.detach(bus);
  }
}
export async function boundedWait(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
