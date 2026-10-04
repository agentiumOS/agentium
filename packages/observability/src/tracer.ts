import { randomBytes } from "node:crypto";
import type { EventBus } from "@agentium/core";
import { outcome, usage } from "./accounting.js";
import { type ExportLimits, ExportQueue } from "./export-queue.js";
import { Attachments, boundedText, boundedWait, Capture, positive, type TelemetryOptions } from "./safety.js";
import type { Span, SpanKind, Trace, TraceContext, TraceExporter } from "./types.js";

export interface TracerOptions extends TelemetryOptions, ExportLimits {
  maxTraces?: number;
  maxSpansPerTrace?: number;
  maxEventsPerSpan?: number;
  maxRetainedBytes?: number;
  retentionMs?: number;
  /** Verified upstream context from the host; no arbitrary run input is parsed as trace context. */
  parentContext?: TraceContext | ((run: Readonly<Record<string, unknown>>) => TraceContext | undefined);
}
export function validTraceContext(value: TraceContext | undefined): value is TraceContext {
  return Boolean(
    value &&
      /^[0-9a-f]{32}$/i.test(value.traceId) &&
      !/^0+$/.test(value.traceId) &&
      /^[0-9a-f]{16}$/i.test(value.spanId) &&
      !/^0+$/.test(value.spanId) &&
      (value.traceFlags === undefined ||
        (Number.isInteger(value.traceFlags) && value.traceFlags >= 0 && value.traceFlags <= 255)) &&
      (value.traceState === undefined || (typeof value.traceState === "string" && value.traceState.length <= 512)),
  );
}
const hex = (bytes: number) => randomBytes(bytes).toString("hex");
export class Tracer {
  private traces = new Map<string, Trace>();
  private active = new Map<string, Map<string, Span>>();
  private attachments = new Attachments();
  private capture: Capture;
  private queue: ExportQueue<{ exporter: number; trace: Trace }>;
  private readonly bounds: { traces: number; spans: number; events: number; bytes: number; age: number };
  private exporters: readonly TraceExporter[];
  private stopped = false;
  private lifecycle = new Map<TraceExporter, Promise<void>>();
  private shutdownPromise?: Promise<void>;
  constructor(
    exporters: TraceExporter[] = [],
    private options: TracerOptions = {},
  ) {
    this.exporters = [...exporters];
    this.capture = new Capture(options);
    this.bounds = {
      traces: positive(options.maxTraces ?? 1000, "maxTraces"),
      spans: positive(options.maxSpansPerTrace ?? 256, "maxSpansPerTrace"),
      events: positive(options.maxEventsPerSpan ?? 64, "maxEventsPerSpan"),
      bytes: positive(options.maxRetainedBytes ?? 8_388_608, "maxRetainedBytes"),
      age: positive(options.retentionMs ?? 3_600_000, "retentionMs"),
    };
    this.queue = new ExportQueue(
      ({ exporter, trace }, signal) => this.exporters[exporter].export(trace, { signal }),
      options,
    );
  }
  attach(bus: EventBus) {
    if (this.stopped) throw new Error("Tracer is shut down");
    this.attachments.attach(bus, (event, data) => {
      try {
        this.accept(event, data as any);
      } catch {
        this.capture.diagnostic.report("observer_failed");
      }
    });
  }
  detach(bus: EventBus) {
    this.attachments.detach(bus);
  }
  private accept(event: string, data: any) {
    this.prune();
    const id = data?.runId;
    if (event === "run.start") {
      if (typeof id !== "string" || id.length > 512 || this.traces.has(id)) return;
      let parent: TraceContext | undefined;
      try {
        const configured =
          typeof this.options.parentContext === "function"
            ? this.options.parentContext(Object.freeze({ ...data }))
            : this.options.parentContext;
        const parentRun = typeof data.parentRunId === "string" ? this.traces.get(data.parentRunId) : undefined;
        parent = configured ?? (parentRun ? { traceId: parentRun.traceId, spanId: parentRun.rootSpanId } : undefined);
        if (parent && !validTraceContext(parent)) {
          this.capture.diagnostic.report("invalid_parent_context");
          parent = undefined;
        }
      } catch {
        this.capture.diagnostic.report("invalid_parent_context");
      }
      const traceId = parent?.traceId.toLowerCase() ?? hex(16);
      const span: Span = {
        traceId,
        spanId: hex(8),
        ...(parent
          ? { parentSpanId: parent.spanId.toLowerCase(), traceFlags: parent.traceFlags, traceState: parent.traceState }
          : {}),
        name: "agent.run",
        kind: "agent",
        startTime: Date.now(),
        status: "running",
        attributes: this.capture.attributes({
          agentName: data.agentName,
          runId: id,
          sessionId: data.sessionId,
          userId: data.userId,
          tenantId: data.tenantId,
          rootRunId: data.rootRunId,
          parentRunId: data.parentRunId,
          attemptId: data.attemptId,
          input: data.input,
          inputLength: typeof data.input === "string" ? data.input.length : undefined,
        }),
        events: [],
      };
      const trace: Trace = {
        traceId,
        rootSpanId: span.spanId,
        startTime: span.startTime,
        spans: [span],
        metadata: { ...span.attributes },
      };
      this.traces.set(id, trace);
      this.active.set(id, new Map([["root", span]]));
    } else if (["run.complete", "run.error", "run.cancelled"].includes(event)) {
      const trace = this.traces.get(id);
      const spans = this.active.get(id);
      const root = spans?.get("root");
      if (!trace || !root) return;
      const status = outcome(event, data);
      Object.assign(
        root.attributes,
        this.capture.attributes({
          ...usage(data.output?.usage),
          runStatus: status,
          output: data.output?.text,
          outputLength: typeof data.output?.text === "string" ? data.output.text.length : undefined,
          error: data.error,
          errorType: data.error ? "Error" : undefined,
        }),
      );
      for (const span of spans!.values()) {
        if (span !== root) span.attributes.interrupted = true;
        this.end(span, span === root && status === "completed" ? "ok" : "error");
      }
      trace.endTime = root.endTime;
      trace.durationMs = root.durationMs;
      trace.metadata = this.capture.attributes({ ...trace.metadata, ...root.attributes });
      this.active.delete(id);
      for (let i = 0; i < this.exporters.length; i++) this.queue.add({ exporter: i, trace: structuredClone(trace) });
    } else if (event === "controller.start") {
      const trace = this.traces.get(id);
      const spans = this.active.get(id);
      if (!trace || !spans || trace.spans.length >= this.bounds.spans) return;
      if (typeof data.controllerCallId !== "string" || data.controllerCallId.length > 512) return;
      const key = JSON.stringify(["controller", data.controllerCallId]);
      if (spans.has(key)) return;
      spans.set(
        key,
        this.child(trace, `controller.${data.operation}`, "internal", {
          runId: id,
          controllerCallId: data.controllerCallId,
          operation: data.operation,
        }),
      );
    } else if (event === "controller.result" || event === "controller.error") {
      const spans = this.active.get(id);
      const key = JSON.stringify(["controller", data.controllerCallId]);
      const span = spans?.get(key);
      if (!span) return;
      Object.assign(
        span.attributes,
        this.capture.attributes({
          decision: data.decision,
          modelRole: data.modelRole,
          activeToolCount: data.activeToolCount,
          status: data.status,
        }),
      );
      this.end(span, event === "controller.error" ? "error" : "ok");
      spans!.delete(key);
    } else if (event === "tool.call" || event === "model.start") {
      const trace = this.traces.get(id);
      const spans = this.active.get(id);
      if (!trace || !spans || trace.spans.length >= this.bounds.spans) {
        if (trace) this.capture.diagnostic.report("span_dropped");
        return;
      }
      const isTool = event === "tool.call";
      const callId = isTool ? data.toolCallId : data.modelCallId;
      if (callId !== undefined && (typeof callId !== "string" || callId.length > 512)) {
        this.capture.diagnostic.report("invalid_call_id");
        return;
      }
      const key = JSON.stringify([isTool ? "tool" : "model", callId ?? hex(8)]);
      if (spans.has(key)) return;
      const span = this.child(
        trace,
        isTool ? `tool.${data.toolName}` : `llm.${data.modelId}`,
        isTool ? "tool" : "llm",
        {
          runId: id,
          toolName: isTool ? data.toolName : undefined,
          toolCallId: isTool ? callId : undefined,
          modelCallId: isTool ? undefined : callId,
          modelId: data.modelId,
          providerId: data.providerId,
          input: isTool ? data.args : data.messages,
        },
      );
      spans.set(key, span);
    } else if (["tool.result", "model.result", "model.error"].includes(event)) {
      const spans = this.active.get(id);
      if (!spans) return;
      const isTool = event === "tool.result";
      const callId = isTool ? data.toolCallId : data.modelCallId;
      const matching = [...spans.entries()].filter(
        ([key, span]) =>
          span.kind === (isTool ? "tool" : "llm") &&
          (callId
            ? key === JSON.stringify([isTool ? "tool" : "model", callId])
            : span.attributes.toolName === data.toolName),
      );
      if (matching.length !== 1) return;
      const [key, span] = matching[0];
      Object.assign(
        span.attributes,
        this.capture.attributes({
          ...usage(data.usage),
          status: data.status,
          cached: data.cached,
          output: isTool ? data.result : data.output,
          error: data.error,
          errorType: data.error ? "Error" : undefined,
        }),
      );
      this.end(
        span,
        event === "model.error" || ["error", "denied", "cancelled"].includes(data.status) ? "error" : "ok",
      );
      spans.delete(key);
    } else if (["handoff.transfer", "team.delegate"].includes(event)) {
      const trace = this.traces.get(id);
      if (!trace || !this.active.has(id) || trace.spans.length >= this.bounds.spans) return;
      const span = this.child(
        trace,
        event === "handoff.transfer" ? `handoff.${data.fromAgent}->${data.toAgent}` : `team.delegate.${data.memberId}`,
        event === "handoff.transfer" ? "handoff" : "team",
        { ...data, input: undefined },
      );
      this.end(span, "ok");
    } else if (event === "cost.tracked") {
      const trace = this.traces.get(id);
      if (trace)
        Object.assign(trace.spans[0].attributes, this.capture.attributes({ modelId: data.modelId, cost: data.cost }));
    } else if (["cache.hit", "cache.miss", "memory.extract", "handoff.complete"].includes(event)) {
      const candidates = id
        ? ([this.traces.get(id)].filter(Boolean) as Trace[])
        : [...this.active.keys()]
            .map((key) => this.traces.get(key)!)
            .filter((trace) => trace.metadata.agentName === data.agentName);
      if (candidates.length !== 1) return;
      const root = candidates[0].spans[0];
      if (root.events.length >= this.bounds.events) {
        this.capture.diagnostic.report("event_dropped");
        return;
      }
      root.events.push({ name: event, timestamp: Date.now(), attributes: this.capture.attributes(data) });
    }
    this.prune();
  }
  private child(trace: Trace, name: string, kind: SpanKind, attributes: Record<string, unknown>): Span {
    const root = trace.spans[0];
    const span: Span = {
      traceId: trace.traceId,
      spanId: hex(8),
      parentSpanId: trace.rootSpanId,
      traceFlags: root.traceFlags,
      traceState: root.traceState,
      name: boundedText(name, 256),
      kind,
      startTime: Date.now(),
      status: "running",
      attributes: this.capture.attributes(attributes),
      events: [],
    };
    trace.spans.push(span);
    return span;
  }
  private end(span: Span, status: "ok" | "error") {
    span.status = status;
    span.endTime = Date.now();
    span.durationMs = span.endTime - span.startTime;
  }
  private prune() {
    let bytes = [...this.traces.values()].reduce((total, trace) => total + Buffer.byteLength(JSON.stringify(trace)), 0);
    const now = Date.now();
    for (const [id, trace] of this.traces) {
      if (
        now - trace.startTime > this.bounds.age ||
        this.traces.size > this.bounds.traces ||
        bytes > this.bounds.bytes
      ) {
        bytes -= Buffer.byteLength(JSON.stringify(trace));
        this.traces.delete(id);
        this.active.delete(id);
        this.capture.diagnostic.report("trace_dropped");
      }
    }
  }
  getTrace(id: string) {
    this.prune();
    const trace = [...this.traces.values()].find((trace) => trace.traceId === id);
    return trace ? structuredClone(trace) : undefined;
  }
  getTraceByRunId(id: string) {
    this.prune();
    const trace = this.traces.get(id);
    return trace ? structuredClone(trace) : undefined;
  }
  getAllTraces() {
    this.prune();
    return structuredClone([...this.traces.values()]);
  }
  getDiagnostics() {
    return {
      ...this.queue.stats(),
      retainedTraces: this.traces.size,
      activeRuns: this.active.size,
      capture: { ...this.capture.diagnostic.counts },
    };
  }
  clear() {
    this.traces.clear();
    this.active.clear();
  }
  private exporterLifecycle(exporter: TraceExporter, operation: "flush" | "shutdown"): Promise<void> {
    const pending = this.lifecycle.get(exporter);
    if (pending) return pending;
    const work = Promise.resolve()
      .then(() => exporter[operation]?.())
      .catch(() => {
        this.capture.diagnostic.report(`${operation}_failed`);
      })
      .finally(() => {
        this.lifecycle.delete(exporter);
      });
    this.lifecycle.set(exporter, work);
    return work;
  }
  async flush() {
    const deadline = Date.now() + this.queue.timeout;
    await this.queue.flush();
    const work = Promise.all(
      this.exporters.filter((exporter) => exporter.flush).map((exporter) => this.exporterLifecycle(exporter, "flush")),
    );
    if (!(await boundedWait(work, Math.max(0, deadline - Date.now())))) this.capture.diagnostic.report("flush_timeout");
  }
  shutdown(): Promise<void> {
    return (this.shutdownPromise ??= this.close());
  }
  private async close() {
    this.stopped = true;
    this.attachments.close();
    const deadline = Date.now() + this.queue.timeout;
    await this.queue.close();
    // Defer resource cleanup until owned work settles, even after the bounded public shutdown returns.
    const pending = [...this.lifecycle.values()];
    const cleanup = Promise.all([this.queue.whenIdle(), ...pending]).then(async () => {
      await Promise.all(
        this.exporters
          .filter((exporter) => exporter.shutdown)
          .map((exporter) => this.exporterLifecycle(exporter, "shutdown")),
      );
    });
    if (!(await boundedWait(cleanup, Math.max(0, deadline - Date.now()))))
      this.capture.diagnostic.report("shutdown_pending_work");
    this.active.clear();
  }
}
