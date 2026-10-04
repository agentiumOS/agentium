import { Capture, type TelemetryOptions } from "../safety.js";
import { validTraceContext } from "../tracer.js";
import type { Trace, TraceContext, TraceExporter } from "../types.js";
import { semanticAttributes } from "./otel.js";
export interface HostOTelSpan {
  spanContext(): Omit<TraceContext, "traceState"> & { traceState?: string | { serialize(): string } };
  setStatus(status: { code: number }): unknown;
  addEvent(name: string, attributes: Record<string, string | number | boolean>, time: [number, number]): unknown;
  end(time: [number, number]): unknown;
}
export interface HostOTelTracer {
  startSpan(
    name: string,
    options: { kind: number; startTime: [number, number]; attributes: Record<string, string | number | boolean> },
    context: any,
  ): HostOTelSpan;
}
export interface OTelBridgeOptions extends TelemetryOptions {
  tracer?: HostOTelTracer;
  provider?: { getTracer(name: string, version?: string): HostOTelTracer };
  /** Host implements with trace.setSpanContext(context.active(), parent), or a chosen root context. */
  contextFor(parent: TraceContext | undefined): any;
}
function scalarAttributes(input: Record<string, unknown>): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(input)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [
        key,
        typeof value === "string" || typeof value === "number" || typeof value === "boolean"
          ? value
          : JSON.stringify(value),
      ]),
  );
}
const time = (ms: number): [number, number] => [Math.floor(ms / 1000), Math.round((ms % 1000) * 1_000_000)];
/** Borrow a host SDK tracer/provider. Never installs globals or shuts down the host provider. */
export class OTelBridgeExporter implements TraceExporter {
  name = "otel-bridge";
  private tracer: HostOTelTracer;
  private capture: Capture;
  constructor(private options: OTelBridgeOptions) {
    if (Boolean(options.tracer) === Boolean(options.provider))
      throw new Error("Supply one host OTel tracer or provider");
    if (typeof options.contextFor !== "function") throw new Error("OTel bridge requires explicit host context binding");
    this.tracer = options.tracer ?? options.provider!.getTracer("@agentium/observability", "3.2.0");
    this.capture = new Capture(options);
  }
  async export(raw: Trace) {
    const trace = this.capture.trace(raw);
    const contexts = new Map<string, TraceContext>();
    const remaining = [...trace.spans];
    while (remaining.length) {
      const index = remaining.findIndex(
        (span) =>
          !span.parentSpanId ||
          contexts.has(span.parentSpanId) ||
          !remaining.some((candidate) => candidate.spanId === span.parentSpanId),
      );
      if (index < 0) throw new Error("Cyclic telemetry span hierarchy");
      const span = remaining.splice(index, 1)[0];
      if (
        span.endTime === undefined ||
        span.status === "running" ||
        span.endTime < span.startTime ||
        !Number.isFinite(span.startTime) ||
        !Number.isFinite(span.endTime)
      )
        throw new Error("OTel bridge requires finished spans");
      const parent = span.parentSpanId
        ? (contexts.get(span.parentSpanId) ?? {
            traceId: span.traceId,
            spanId: span.parentSpanId,
            traceFlags: span.traceFlags ?? 1,
            traceState: span.traceState,
          })
        : undefined;
      if (parent && !validTraceContext(parent)) throw new Error("Invalid parent span context");
      const attributes = scalarAttributes(semanticAttributes(span));
      // The host SDK owns generated IDs. Local IDs remain explicit correlation attributes.
      attributes["agentium.source.span_id"] = span.spanId;
      const host = this.tracer.startSpan(
        span.name,
        { kind: span.kind === "llm" ? 2 : 0, startTime: time(span.startTime), attributes },
        this.options.contextFor(parent),
      );
      const generated = host.spanContext();
      contexts.set(span.spanId, {
        ...generated,
        traceState: typeof generated.traceState === "string" ? generated.traceState : generated.traceState?.serialize(),
      });
      try {
        host.setStatus({ code: span.status === "error" ? 2 : 1 });
        for (const event of span.events)
          host.addEvent(event.name, scalarAttributes(event.attributes ?? {}), time(event.timestamp));
      } finally {
        host.end(time(span.endTime));
      }
    }
  }
}
