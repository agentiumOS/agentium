import type { Trace, TraceExporter } from "../types.js";

export interface OTelExporterConfig {
  /** Defaults to OTEL_EXPORTER_OTLP_ENDPOINT env var. */
  endpoint?: string;
  /** Defaults to OTEL_EXPORTER_OTLP_HEADERS env var (comma-separated key=value pairs). */
  headers?: Record<string, string>;
  protocol?: "http/json" | "http/protobuf";
  /** Defaults to OTEL_SERVICE_NAME env var or "agentium". */
  serviceName?: string;
}

function parseEnvHeaders(raw?: string): Record<string, string> {
  if (!raw) return {};
  const result: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [k, ...v] = pair.split("=");
    if (k) result[k.trim()] = v.join("=").trim();
  }
  return result;
}

export class OTelExporter implements TraceExporter {
  name = "otel";
  private endpoint: string;
  private headers: Record<string, string>;
  private serviceName: string;

  constructor(config?: OTelExporterConfig) {
    const ep = config?.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "";
    if (!ep) {
      throw new Error("OTelExporter: missing endpoint. Set OTEL_EXPORTER_OTLP_ENDPOINT env var, or pass it in config.");
    }
    this.endpoint = ep.replace(/\/$/, "");
    this.headers = config?.headers ?? parseEnvHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);
    this.serviceName = config?.serviceName ?? process.env.OTEL_SERVICE_NAME ?? "agentium";
  }

  private async fetchWithRetry(url: string, init: RequestInit, retries = 2): Promise<Response> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(url, { ...init, signal: controller.signal });
        clearTimeout(timeout);
        if (res.status >= 500 && attempt < retries) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        return res;
      } catch (err) {
        if (attempt === retries) throw err;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    throw new Error("Unreachable");
  }

  async export(trace: Trace): Promise<void> {
    const otlpSpans = trace.spans.map((span) => ({
      traceId: this.padHex(span.traceId, 32),
      spanId: this.padHex(span.spanId, 16),
      parentSpanId: span.parentSpanId ? this.padHex(span.parentSpanId, 16) : undefined,
      name: span.name,
      kind: this.mapKind(span.kind),
      startTimeUnixNano: String(span.startTime * 1_000_000),
      endTimeUnixNano: span.endTime ? String(span.endTime * 1_000_000) : undefined,
      status: {
        code: span.status === "error" ? 2 : 1,
        message: span.status === "error" ? String(span.attributes.error ?? "") : undefined,
      },
      attributes: Object.entries(span.attributes).map(([key, value]) => ({
        key,
        value: this.toOtlpValue(value),
      })),
      events: span.events.map((evt) => ({
        name: evt.name,
        timeUnixNano: String(evt.timestamp * 1_000_000),
        attributes: evt.attributes
          ? Object.entries(evt.attributes).map(([k, v]) => ({ key: k, value: this.toOtlpValue(v) }))
          : [],
      })),
    }));

    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: this.serviceName } }],
          },
          scopeSpans: [
            {
              scope: { name: "@agentium/observability" },
              spans: otlpSpans,
            },
          ],
        },
      ],
    };

    const url = `${this.endpoint}/v1/traces`;

    const res = await this.fetchWithRetry(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`OTLP export failed: ${res.status} ${res.statusText}`);
    }
  }

  private padHex(id: string, length: number): string {
    let hex = "";
    for (let i = 0; i < id.length; i++) {
      hex += id.charCodeAt(i).toString(16).padStart(2, "0");
    }
    return hex.padStart(length, "0").slice(-length);
  }

  private mapKind(kind: string): number {
    switch (kind) {
      case "agent":
        return 1;
      case "llm":
        return 3;
      case "tool":
        return 3;
      default:
        return 0;
    }
  }

  private toOtlpValue(value: unknown): Record<string, unknown> {
    if (typeof value === "string") return { stringValue: value };
    if (typeof value === "number")
      return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
    if (typeof value === "boolean") return { boolValue: value };
    if (Array.isArray(value)) return { stringValue: JSON.stringify(value) };
    return { stringValue: String(value) };
  }
}
