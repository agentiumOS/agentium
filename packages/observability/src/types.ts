import type { ExportLimits } from "./export-queue.js";
import type { TelemetryOptions } from "./safety.js";

export type SpanKind =
  | "agent"
  | "llm"
  | "tool"
  | "guardrail"
  | "memory"
  | "cache"
  | "handoff"
  | "team"
  | "workflow"
  | "internal";
export type SpanStatus = "ok" | "error" | "running";

export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes?: Record<string, unknown>;
}

export interface TraceContext {
  traceId: string;
  spanId: string;
  traceFlags?: number;
  traceState?: string;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceFlags?: number;
  traceState?: string;
  name: string;
  kind: SpanKind;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: SpanStatus;
  attributes: Record<string, unknown>;
  events: SpanEvent[];
}

export interface Trace {
  traceId: string;
  spans: Span[];
  rootSpanId: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  metadata: Record<string, unknown>;
}

export interface TraceExporter {
  name: string;
  export(trace: Trace, context?: { signal: AbortSignal }): Promise<void>;
  flush?(): Promise<void>;
  shutdown?(): Promise<void>;
}

export interface MetricsSnapshot {
  counters: {
    runs_total: number;
    runs_success: number;
    runs_error: number;
    runs_cancelled: number;
    runs_stopped: number;
    tool_calls_total: number;
    handoffs_total: number;
    cache_hits: number;
    cache_misses: number;
  };
  histograms: {
    run_duration_ms: number[];
    tool_latency_ms: number[];
  };
  gauges: {
    /** Compatibility projection from complete per-run replacement events. */
    total_cost_usd: number;
    /** Known priced USD subtotal of selected own-attempt assessments; incomplete costs stay separate. */
    known_attempt_cost_usd: number;
    assessed_attempts: number;
    unpriced_attempts: number;
    provisional_attempts: number;
    cache_write_tokens: number;
    total_tokens: number;
    prompt_tokens: number;
    completion_tokens: number;
    reasoning_tokens: number;
    cached_tokens: number;
    audio_input_tokens: number;
    audio_output_tokens: number;
  };
  rates: {
    cache_hit_ratio: number;
    error_rate: number;
  };
  timestamp: number;
}

export type ExporterShorthand = "console" | "langfuse" | "json-file" | "otel" | "langfuse-otlp";

export interface ObservabilityConfig extends TelemetryOptions, ExportLimits {
  /** Exporter instances or shorthand strings like "console", "langfuse". */
  exporters?: (TraceExporter | ExporterShorthand)[];
  metrics?: boolean;
  structuredLogs?: boolean | LogDrain;
}

export type LogDrain = "console" | "json" | ((entry: LogEntry) => void);

export interface LogEntry {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  traceId?: string;
  spanId?: string;
  agentName?: string;
  attributes?: Record<string, unknown>;
}
