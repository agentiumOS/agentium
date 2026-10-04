import { Capture, type TelemetryOptions } from "../safety.js";
import { validTraceContext } from "../tracer.js";
import type { Span, Trace, TraceExporter } from "../types.js";
import { endpointURL, type HttpExportOptions, postTelemetry } from "./http.js";

export interface OTelExporterConfig extends TelemetryOptions, HttpExportOptions {
  /** Base OTLP endpoint: /v1/traces is appended. */
  endpoint?: string;
  /** Signal-specific complete URL; never appends a path. */
  tracesEndpoint?: string;
  headers?: Record<string, string>;
  /** JSON is implemented; protobuf explicitly rejects. Use a host SDK exporter for binary OTLP. */
  protocol?: "http/json" | "http/protobuf";
  serviceName?: string;
}
export const OTEL_SEMCONV_SCHEMA = "https://opentelemetry.io/schemas/1.37.0";
function envHeaders(raw = ""): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const pair of raw.split(",")) {
    const split = pair.indexOf("=");
    if (split > 0) result[pair.slice(0, split).trim()] = pair.slice(split + 1).trim();
  }
  return result;
}
export function nanoseconds(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0 || !Number.isSafeInteger(Math.trunc(ms)))
    throw new Error("Invalid span timestamp");
  return (BigInt(Math.trunc(ms)) * 1_000_000n + BigInt(Math.round((ms - Math.trunc(ms)) * 1_000_000))).toString();
}
export function semanticAttributes(span: Span): Record<string, unknown> {
  const attrs: Record<string, unknown> = { ...span.attributes, "agentium.span.kind": span.kind };
  if (span.status === "error") attrs["error.type"] = span.attributes.errorType ?? "_OTHER";
  if (span.kind === "llm") {
    attrs["gen_ai.operation.name"] = "chat";
    if (span.attributes.modelId) attrs["gen_ai.request.model"] = span.attributes.modelId;
    if (span.attributes.providerId) attrs["gen_ai.provider.name"] = span.attributes.providerId;
    if (typeof span.attributes.promptTokens === "number")
      attrs["gen_ai.usage.input_tokens"] = span.attributes.promptTokens;
    if (typeof span.attributes.completionTokens === "number")
      attrs["gen_ai.usage.output_tokens"] = span.attributes.completionTokens;
  }
  if (span.kind === "tool") {
    attrs["gen_ai.operation.name"] = "execute_tool";
    if (span.attributes.toolName) attrs["gen_ai.tool.name"] = span.attributes.toolName;
    if (span.attributes.toolCallId) attrs["gen_ai.tool.call.id"] = span.attributes.toolCallId;
  }
  return attrs;
}
export function otlpValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number" && Number.isFinite(value))
    return Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(otlpValue) } };
  return { stringValue: JSON.stringify(value) ?? "null" };
}
export class OTelExporter implements TraceExporter {
  name = "otel";
  protected readonly capture: Capture;
  protected readonly endpoint: string;
  protected readonly headers: Record<string, string>;
  private readonly service: string;
  protected readonly config: OTelExporterConfig;
  constructor(config: OTelExporterConfig = {}) {
    const protocol =
      config.protocol ??
      process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ??
      process.env.OTEL_EXPORTER_OTLP_PROTOCOL ??
      "http/json";
    if (protocol !== "http/json")
      throw new Error("OTelExporter supports http/json only; use a host SDK exporter for http/protobuf");
    if (config.endpoint && config.tracesEndpoint) throw new Error("Choose a base endpoint or tracesEndpoint");
    const signal =
      config.tracesEndpoint ?? (!config.endpoint ? process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT : undefined);
    const base = config.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (!signal && !base) throw new Error("OTelExporter requires an endpoint");
    this.endpoint = signal ? endpointURL(signal) : `${endpointURL(base!)}/v1/traces`;
    this.headers = {
      ...envHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
      ...envHeaders(process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS),
      ...config.headers,
    };
    this.service = config.serviceName ?? process.env.OTEL_SERVICE_NAME ?? "agentium";
    this.config = { ...config };
    this.capture = new Capture(config);
  }
  protected attributes(span: Span, _trace: Trace): Record<string, unknown> {
    return semanticAttributes(span);
  }
  payload(raw: Trace) {
    const trace = this.capture.trace(raw);
    const spans = trace.spans.map((span) => {
      if (
        !validTraceContext({
          traceId: span.traceId,
          spanId: span.spanId,
          traceFlags: span.traceFlags,
          traceState: span.traceState,
        }) ||
        (span.parentSpanId && !validTraceContext({ traceId: span.traceId, spanId: span.parentSpanId }))
      )
        throw new Error("Invalid OpenTelemetry span IDs");
      if (span.endTime === undefined || span.status === "running" || span.endTime < span.startTime)
        throw new Error("Only finished spans may be exported");
      return {
        traceId: span.traceId.toLowerCase(),
        spanId: span.spanId.toLowerCase(),
        ...(span.parentSpanId ? { parentSpanId: span.parentSpanId.toLowerCase() } : {}),
        ...(span.traceState ? { traceState: span.traceState } : {}),
        flags: span.traceFlags ?? 1,
        name: span.name,
        kind: span.kind === "llm" ? 3 : 1,
        startTimeUnixNano: nanoseconds(span.startTime),
        endTimeUnixNano: nanoseconds(span.endTime),
        status: { code: span.status === "error" ? 2 : 1 },
        attributes: Object.entries(this.attributes(span, trace)).map(([key, value]) => ({
          key,
          value: otlpValue(value),
        })),
        events: span.events.map((event) => ({
          name: event.name,
          timeUnixNano: nanoseconds(event.timestamp),
          attributes: Object.entries(event.attributes ?? {}).map(([key, value]) => ({ key, value: otlpValue(value) })),
        })),
      };
    });
    return {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: this.service } }] },
          scopeSpans: [
            { scope: { name: "@agentium/observability", version: "3.2.0" }, schemaUrl: OTEL_SEMCONV_SCHEMA, spans },
          ],
        },
      ],
    };
  }
  async export(trace: Trace, context?: { signal: AbortSignal }): Promise<void> {
    try {
      const response = await postTelemetry(
        this.endpoint,
        JSON.stringify(this.payload(trace)),
        this.headers,
        this.config,
        context?.signal,
      );
      if (response.status !== 200) throw new Error("Unexpected OTLP success status");
      if (response.body.partialSuccess !== undefined) {
        const partial = response.body.partialSuccess;
        if (!partial || typeof partial !== "object" || Array.isArray(partial))
          throw new Error("Invalid OTLP partial-success response");
        const rejected = Number(partial?.rejectedSpans ?? 0);
        if (!Number.isSafeInteger(rejected) || rejected < 0) throw new Error("Invalid OTLP rejection count");
        this.capture.diagnostic.report("otlp_partial_success", { rejectedSpans: rejected });
        // Accepted spans must never be resent for a partial-success response.
      }
    } catch (error) {
      this.capture.diagnostic.report("otlp_export_failed");
      throw error;
    }
  }
  getDiagnostics() {
    return { ...this.capture.diagnostic.counts };
  }
}
