import { Capture, type TelemetryOptions } from "../safety.js";
import type { Span, Trace, TraceExporter } from "../types.js";
import { endpointURL, type HttpExportOptions, postTelemetry } from "./http.js";

export interface LangfuseExporterConfig extends TelemetryOptions, HttpExportOptions {
  /** Defaults to LANGFUSE_PUBLIC_KEY env var. */
  publicKey?: string;
  /** Defaults to LANGFUSE_SECRET_KEY env var. */
  secretKey?: string;
  /** Defaults to LANGFUSE_BASE_URL env var or https://cloud.langfuse.com. */
  baseUrl?: string;
}

let eventCounter = 0;
function eventId(): string {
  return `evt_${Date.now().toString(36)}_${(eventCounter++).toString(36)}`;
}

function extractIO(span: Span): { input: unknown; output: unknown } {
  const input = span.attributes.input ?? null;
  const output = span.attributes.output ?? null;
  return { input, output };
}

export class LangfuseExporter implements TraceExporter {
  name = "langfuse";
  private capture: Capture;
  private config: LangfuseExporterConfig;
  private publicKey: string;
  private secretKey: string;
  private baseUrl: string;

  constructor(config: LangfuseExporterConfig = {}) {
    this.config = { ...config };
    this.capture = new Capture(config);
    this.capture.diagnostic.report("legacy_langfuse_ingestion_deprecated");
    this.publicKey = config?.publicKey ?? process.env.LANGFUSE_PUBLIC_KEY ?? "";
    this.secretKey = config?.secretKey ?? process.env.LANGFUSE_SECRET_KEY ?? "";
    this.baseUrl = (config?.baseUrl ?? process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com").replace(
      /\/$/,
      "",
    );

    if (!this.publicKey || !this.secretKey) {
      throw new Error(
        "LangfuseExporter: missing credentials. Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY env vars, or pass them in config.",
      );
    }
  }

  async export(raw: Trace, context?: { signal: AbortSignal }): Promise<void> {
    const trace = this.capture.trace(raw);
    if (trace.spans.some((span) => span.status === "running" || span.endTime === undefined))
      throw new Error("Only finished Langfuse spans may be exported");
    const events: unknown[] = [];
    const now = new Date().toISOString();

    const rootSpan = trace.spans.find((s) => s.spanId === trace.rootSpanId);

    events.push({
      id: eventId(),
      type: "trace-create",
      timestamp: now,
      body: {
        id: trace.traceId,
        name: String(trace.metadata.agentName ?? "agent.run"),
        input: trace.metadata.input ?? rootSpan?.attributes.input ?? null,
        output: trace.metadata.output ?? rootSpan?.attributes.output ?? null,
        metadata: { ...trace.metadata, input: undefined, output: undefined },
        timestamp: new Date(trace.startTime).toISOString(),
      },
    });

    for (const span of trace.spans) {
      const { input, output } = extractIO(span);
      const { input: _i, output: _o, ...restAttrs } = span.attributes as Record<string, unknown>;

      if (span.kind === "llm" || span.name.startsWith("llm.")) {
        events.push({
          id: eventId(),
          type: "generation-create",
          timestamp: now,
          body: {
            id: span.spanId,
            traceId: trace.traceId,
            parentObservationId: span.parentSpanId,
            name: span.name,
            model: span.attributes.modelId ?? undefined,
            input,
            output,
            startTime: new Date(span.startTime).toISOString(),
            endTime: span.endTime ? new Date(span.endTime).toISOString() : undefined,
            usage: {
              promptTokens: span.attributes.promptTokens,
              completionTokens: span.attributes.completionTokens,
              totalTokens: span.attributes.tokens,
            },
            metadata: {
              ...restAttrs,
              ...(span.attributes.providerMetrics ? { providerMetrics: span.attributes.providerMetrics } : {}),
            },
          },
        });
      } else {
        events.push({
          id: eventId(),
          type: "span-create",
          timestamp: now,
          body: {
            id: span.spanId,
            traceId: trace.traceId,
            parentObservationId: span.parentSpanId,
            name: span.name,
            input,
            output,
            startTime: new Date(span.startTime).toISOString(),
            endTime: span.endTime ? new Date(span.endTime).toISOString() : undefined,
            metadata: restAttrs,
            level: span.status === "error" ? "ERROR" : "DEFAULT",
          },
        });
      }
    }

    const auth = Buffer.from(`${this.publicKey}:${this.secretKey}`).toString("base64");

    const res = await postTelemetry(
      `${endpointURL(this.baseUrl)}/api/public/ingestion`,
      JSON.stringify({ batch: events }),
      { Authorization: `Basic ${auth}` },
      this.config,
      context?.signal,
    );
    if (res.status === 207 && Array.isArray(res.body.errors) && res.body.errors.length > 0) {
      this.capture.diagnostic.report("legacy_langfuse_partial_failure");
      throw new Error("Langfuse legacy ingestion partially rejected telemetry");
    }
  }
}
