import type { EventBus } from "@agentium/core";
import type { Span, SpanKind, SpanStatus, Trace, TraceExporter } from "./types.js";

let idCounter = 0;
function genId(): string {
  return `${Date.now().toString(36)}_${(idCounter++).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export class Tracer {
  private traces = new Map<string, Trace>();
  private runToTrace = new Map<string, string>();
  private runToRootSpan = new Map<string, string>();
  private activeSpans = new Map<string, Span>();
  private exporters: TraceExporter[];
  private listeners: Array<{ event: string; handler: (...args: any[]) => void }> = [];
  private pendingExports: Promise<void>[] = [];
  private maxTraces = 1000;

  constructor(exporters: TraceExporter[] = []) {
    this.exporters = exporters;
  }

  attach(eventBus: EventBus): void {
    const on = (event: string, handler: (data: any) => void) => {
      (eventBus as any).on(event, handler);
      this.listeners.push({ event, handler });
    };

    on("run.start", (data: { runId: string; agentName: string; input: string }) => {
      const traceId = genId();
      const inputText = data.input?.slice(0, 1000) ?? "";
      const span = this.startSpan(traceId, "agent.run", "agent", {
        agentName: data.agentName,
        input: inputText,
        runId: data.runId,
      });
      this.runToTrace.set(data.runId, traceId);
      this.runToRootSpan.set(data.runId, span.spanId);

      const trace: Trace = {
        traceId,
        spans: [span],
        rootSpanId: span.spanId,
        startTime: span.startTime,
        metadata: { agentName: data.agentName, runId: data.runId, input: inputText },
      };
      this.traces.set(traceId, trace);
      this.activeSpans.set(`${data.runId}:root`, span);
    });

    on("run.complete", (data: { runId: string; output: any }) => {
      const span = this.activeSpans.get(`${data.runId}:root`);
      if (span) {
        const outputText = data.output?.text?.slice(0, 2000) ?? "";
        span.attributes.output = outputText;
        span.attributes.outputLength = data.output?.text?.length ?? 0;
        span.attributes.tokens = data.output?.usage?.totalTokens ?? 0;
        span.attributes.promptTokens = data.output?.usage?.promptTokens ?? 0;
        span.attributes.completionTokens = data.output?.usage?.completionTokens ?? 0;
        span.attributes.reasoningTokens = data.output?.usage?.reasoningTokens ?? 0;
        span.attributes.cachedTokens = data.output?.usage?.cachedTokens ?? 0;
        span.attributes.audioInputTokens = data.output?.usage?.audioInputTokens ?? 0;
        span.attributes.audioOutputTokens = data.output?.usage?.audioOutputTokens ?? 0;
        if (data.output?.usage?.providerMetrics) {
          span.attributes.providerMetrics = data.output.usage.providerMetrics;
        }
        this.endSpan(span, "ok");
        this.activeSpans.delete(`${data.runId}:root`);

        const traceId = this.runToTrace.get(data.runId);
        const trace = traceId ? this.traces.get(traceId) : undefined;
        if (trace) {
          trace.metadata.output = outputText;
        }

        this.finalizeTrace(data.runId);
      }
    });

    on("run.error", (data: { runId: string; error: Error }) => {
      const span = this.activeSpans.get(`${data.runId}:root`);
      if (span) {
        span.attributes.error = data.error.message;
        this.endSpan(span, "error");
        this.activeSpans.delete(`${data.runId}:root`);
        this.finalizeTrace(data.runId);
      }
    });

    on("tool.call", (data: { runId: string; toolName: string; args: unknown }) => {
      const traceId = this.runToTrace.get(data.runId);
      const parentId = this.runToRootSpan.get(data.runId);
      if (!traceId) return;

      const argsStr = typeof data.args === "string" ? data.args : JSON.stringify(data.args ?? {});
      const span = this.startSpan(
        traceId,
        `tool.${data.toolName}`,
        "tool",
        {
          toolName: data.toolName,
          runId: data.runId,
          input: argsStr.slice(0, 1000),
        },
        parentId,
      );

      const trace = this.traces.get(traceId);
      trace?.spans.push(span);
      this.activeSpans.set(`${data.runId}:tool:${data.toolName}:${span.spanId}`, span);
    });

    on("tool.result", (data: { runId: string; toolName: string; result: unknown }) => {
      const prefix = `${data.runId}:tool:${data.toolName}:`;
      let matchKey: string | undefined;
      for (const key of this.activeSpans.keys()) {
        if (key.startsWith(prefix)) {
          matchKey = key;
          break;
        }
      }
      if (!matchKey) return;
      const span = this.activeSpans.get(matchKey)!;
      const resultStr = typeof data.result === "string" ? data.result : JSON.stringify(data.result ?? "");
      span.attributes.output = resultStr.slice(0, 2000);
      span.attributes.resultLength = resultStr.length;
      span.attributes.cached = resultStr.startsWith("[cached]");
      this.endSpan(span, "ok");
      this.activeSpans.delete(matchKey);
    });

    on("handoff.transfer", (data: { runId: string; fromAgent: string; toAgent: string; reason: string }) => {
      const traceId = this.runToTrace.get(data.runId);
      const parentId = this.runToRootSpan.get(data.runId);
      if (!traceId) return;

      const span = this.startSpan(
        traceId,
        `handoff.${data.fromAgent}->${data.toAgent}`,
        "handoff",
        {
          fromAgent: data.fromAgent,
          toAgent: data.toAgent,
          reason: data.reason,
        },
        parentId,
      );
      this.endSpan(span, "ok");

      const trace = this.traces.get(traceId);
      trace?.spans.push(span);
    });

    on("handoff.complete", (data: { runId: string; chain: string[]; finalAgent: string }) => {
      const span = this.activeSpans.get(`${data.runId}:root`);
      if (span) {
        span.attributes.handoffChain = data.chain;
        span.attributes.finalAgent = data.finalAgent;
      }
    });

    on("team.delegate", (data: { runId: string; memberId: string; task: string }) => {
      const traceId = this.runToTrace.get(data.runId);
      const parentId = this.runToRootSpan.get(data.runId);
      if (!traceId) return;

      const span = this.startSpan(
        traceId,
        `team.delegate.${data.memberId}`,
        "team",
        {
          memberId: data.memberId,
          task: data.task.slice(0, 200),
        },
        parentId,
      );
      this.endSpan(span, "ok");

      const trace = this.traces.get(traceId);
      trace?.spans.push(span);
    });

    on("cache.hit", (data: { agentName: string; input: string; cachedId: string }) => {
      for (const [key, span] of this.activeSpans) {
        if (key.endsWith(":root") && span.attributes.agentName === data.agentName) {
          span.events.push({ name: "cache.hit", timestamp: Date.now(), attributes: { cachedId: data.cachedId } });
          break;
        }
      }
    });

    on("cache.miss", (data: { agentName: string; input: string }) => {
      for (const [key, span] of this.activeSpans) {
        if (key.endsWith(":root") && span.attributes.agentName === data.agentName) {
          span.events.push({ name: "cache.miss", timestamp: Date.now(), attributes: {} });
          break;
        }
      }
    });

    on("cost.tracked", (data: { runId: string; agentName: string; modelId: string; usage: any }) => {
      const span = this.activeSpans.get(`${data.runId}:root`);
      if (span) {
        span.attributes.modelId = data.modelId;
      }
    });

    on("memory.extract", (data: { sessionId: string; agentName: string }) => {
      for (const [key, span] of this.activeSpans) {
        if (key.endsWith(":root") && span.attributes.agentName === data.agentName) {
          span.events.push({
            name: "memory.extract",
            timestamp: Date.now(),
            attributes: { sessionId: data.sessionId, agentName: data.agentName },
          });
          break;
        }
      }
    });
  }

  detach(eventBus: EventBus): void {
    for (const { event, handler } of this.listeners) {
      (eventBus as any).off(event, handler);
    }
    this.listeners = [];
  }

  getTrace(traceId: string): Trace | undefined {
    return this.traces.get(traceId);
  }

  getTraceByRunId(runId: string): Trace | undefined {
    const traceId = this.runToTrace.get(runId);
    return traceId ? this.traces.get(traceId) : undefined;
  }

  getAllTraces(): Trace[] {
    return [...this.traces.values()];
  }

  clear(): void {
    this.traces.clear();
    this.runToTrace.clear();
    this.runToRootSpan.clear();
    this.activeSpans.clear();
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.pendingExports);
    this.pendingExports = [];
    for (const exporter of this.exporters) {
      if (exporter.flush) await exporter.flush();
    }
  }

  async shutdown(): Promise<void> {
    await this.flush();
    for (const exporter of this.exporters) {
      if (exporter.shutdown) await exporter.shutdown();
    }
  }

  private startSpan(
    traceId: string,
    name: string,
    kind: SpanKind,
    attributes: Record<string, unknown>,
    parentSpanId?: string,
  ): Span {
    return {
      traceId,
      spanId: genId(),
      parentSpanId,
      name,
      kind,
      startTime: Date.now(),
      status: "running",
      attributes,
      events: [],
    };
  }

  private endSpan(span: Span, status: SpanStatus): void {
    span.endTime = Date.now();
    span.durationMs = span.endTime - span.startTime;
    span.status = status;
  }

  private finalizeTrace(runId: string): void {
    const traceId = this.runToTrace.get(runId);
    if (!traceId) return;

    const trace = this.traces.get(traceId);
    if (!trace) return;

    const root = trace.spans.find((s) => s.spanId === trace.rootSpanId);
    if (root) {
      trace.endTime = root.endTime;
      trace.durationMs = root.durationMs;
    }

    const exportPromise = this.runExporters(trace);
    this.pendingExports.push(exportPromise);
    exportPromise.finally(() => {
      const idx = this.pendingExports.indexOf(exportPromise);
      if (idx >= 0) this.pendingExports.splice(idx, 1);
    });

    this.runToTrace.delete(runId);
    this.runToRootSpan.delete(runId);

    if (this.traces.size > this.maxTraces) {
      const oldest = this.traces.keys().next().value;
      if (oldest) this.traces.delete(oldest);
    }
  }

  private async runExporters(trace: Trace): Promise<void> {
    for (const exporter of this.exporters) {
      try {
        await exporter.export(trace);
      } catch (err) {
        console.warn(
          `[agentium/observability] Export failed (${exporter.name}):`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}
