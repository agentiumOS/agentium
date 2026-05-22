import type { Span, Trace, TraceExporter } from "../types.js";

export interface LangfuseExporterConfig {
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
  private publicKey: string;
  private secretKey: string;
  private baseUrl: string;

  constructor(config?: LangfuseExporterConfig) {
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

    const res = await this.fetchWithRetry(`${this.baseUrl}/api/public/ingestion`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({ batch: events }),
    });

    if (!res.ok && res.status !== 207) {
      throw new Error(`Langfuse export failed: ${res.status} ${res.statusText}`);
    }

    if (res.status === 207) {
      const body = (await res.json()) as { errors?: Array<{ status: number; message: string }> };
      if (body.errors && body.errors.length > 0) {
        const realErrors = body.errors.filter((e) => e.status >= 400);
        if (realErrors.length > 0) {
          throw new Error(`Langfuse partial failure: ${JSON.stringify(realErrors[0])}`);
        }
      }
    }
  }
}
