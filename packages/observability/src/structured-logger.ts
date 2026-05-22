import type { EventBus } from "@agentium/core";
import type { Tracer } from "./tracer.js";
import type { LogDrain, LogEntry } from "./types.js";

export class StructuredLogger {
  private drain: LogDrain;
  private tracer: Tracer | null;
  private listeners: Array<{ event: string; handler: (...args: any[]) => void }> = [];

  constructor(drain: LogDrain = "json", tracer?: Tracer) {
    this.drain = drain;
    this.tracer = tracer ?? null;
  }

  attach(eventBus: EventBus): void {
    const on = (event: string, handler: (data: any) => void) => {
      (eventBus as any).on(event, handler);
      this.listeners.push({ event, handler });
    };

    on("run.start", (data: { runId: string; agentName: string; input: string }) => {
      this.log(
        "info",
        "Run started",
        data.agentName,
        {
          runId: data.runId,
          input: data.input?.slice(0, 200) ?? "",
        },
        data.runId,
      );
    });

    on("run.complete", (data: { runId: string; output: any }) => {
      this.log(
        "info",
        "Run completed",
        data.output?.agentName ?? undefined,
        {
          runId: data.runId,
          tokens: data.output?.usage?.totalTokens,
          promptTokens: data.output?.usage?.promptTokens,
          completionTokens: data.output?.usage?.completionTokens,
          reasoningTokens: data.output?.usage?.reasoningTokens,
          durationMs: data.output?.durationMs,
          providerMetrics: data.output?.usage?.providerMetrics,
        },
        data.runId,
      );
    });

    on("run.error", (data: { runId: string; error: Error }) => {
      this.log(
        "error",
        `Run failed: ${data.error?.message ?? "unknown error"}`,
        undefined,
        {
          runId: data.runId,
          error: data.error?.message ?? "unknown error",
          stack: data.error?.stack?.split("\n").slice(0, 3).join("\n"),
        },
        data.runId,
      );
    });

    on("tool.call", (data: { runId: string; toolName: string; args: unknown }) => {
      this.log(
        "debug",
        `Tool call: ${data.toolName}`,
        undefined,
        {
          runId: data.runId,
          toolName: data.toolName,
        },
        data.runId,
      );
    });

    on("tool.result", (data: { runId: string; toolName: string; result: unknown }) => {
      this.log(
        "debug",
        `Tool result: ${data.toolName}`,
        undefined,
        {
          runId: data.runId,
          toolName: data.toolName,
        },
        data.runId,
      );
    });

    on("handoff.transfer", (data: { runId: string; fromAgent: string; toAgent: string; reason: string }) => {
      this.log(
        "info",
        `Handoff: ${data.fromAgent} -> ${data.toAgent}`,
        data.fromAgent,
        {
          runId: data.runId,
          toAgent: data.toAgent,
          reason: data.reason,
        },
        data.runId,
      );
    });

    on("cache.hit", (data: { agentName: string; input: string }) => {
      this.log("debug", "Cache hit", data.agentName, {
        input: data.input?.slice(0, 100) ?? "",
      });
    });

    on("cache.miss", (data: { agentName: string; input: string }) => {
      this.log("debug", "Cache miss", data.agentName, {
        input: data.input?.slice(0, 100) ?? "",
      });
    });

    on("cost.tracked", (data: { runId: string; agentName: string; modelId: string; usage: any }) => {
      this.log(
        "info",
        `Cost tracked: ${data.modelId}`,
        data.agentName,
        {
          runId: data.runId,
          modelId: data.modelId,
          tokens: data.usage?.totalTokens,
          promptTokens: data.usage?.promptTokens,
          completionTokens: data.usage?.completionTokens,
          reasoningTokens: data.usage?.reasoningTokens,
          cachedTokens: data.usage?.cachedTokens,
          audioInputTokens: data.usage?.audioInputTokens,
          audioOutputTokens: data.usage?.audioOutputTokens,
        },
        data.runId,
      );
    });
  }

  detach(eventBus: EventBus): void {
    for (const { event, handler } of this.listeners) {
      (eventBus as any).off(event, handler);
    }
    this.listeners = [];
  }

  private log(
    level: LogEntry["level"],
    message: string,
    agentName?: string,
    attributes?: Record<string, unknown>,
    runId?: string,
  ): void {
    const traceId = runId && this.tracer ? this.tracer.getTraceByRunId(runId)?.traceId : undefined;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      traceId,
      agentName,
      attributes,
    };

    if (typeof this.drain === "function") {
      this.drain(entry);
    } else if (this.drain === "json") {
      console.log(JSON.stringify(entry));
    } else {
      console.log(`[${entry.timestamp}] ${level.toUpperCase()} ${message}${traceId ? ` trace=${traceId}` : ""}`);
    }
  }
}
