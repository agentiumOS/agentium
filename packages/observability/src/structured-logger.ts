import type { EventBus } from "@agentium/core";
import { outcome, usage } from "./accounting.js";
import { type ExportLimits, ExportQueue } from "./export-queue.js";
import { Attachments, Capture, type TelemetryOptions } from "./safety.js";
import type { Tracer } from "./tracer.js";
import type { LogDrain, LogEntry } from "./types.js";
export class StructuredLogger {
  private attachments = new Attachments();
  private capture: Capture;
  private queue: ExportQueue<LogEntry>;
  constructor(
    drain: LogDrain = "json",
    private tracer?: Tracer,
    options: TelemetryOptions & ExportLimits = {},
  ) {
    this.capture = new Capture(options);
    this.queue = new ExportQueue(async (entry) => {
      if (typeof drain === "function") await drain(entry);
      else if (drain === "json") console.log(JSON.stringify(entry));
      else
        console.log(
          `[${entry.timestamp}] ${entry.level.toUpperCase()} ${entry.message}${entry.traceId ? ` trace=${entry.traceId}` : ""}`,
        );
    }, options);
  }
  attach(bus: EventBus) {
    this.attachments.attach(bus, (event, raw) => {
      if (
        ![
          "run.start",
          "run.complete",
          "run.error",
          "run.cancelled",
          "tool.call",
          "tool.result",
          "handoff.transfer",
          "cache.hit",
          "cache.miss",
          "cost.tracked",
          "model.start",
          "model.result",
          "model.error",
        ].includes(event)
      )
        return;
      const data = raw as any;
      const attributes = this.capture.attributes({
        ...data,
        ...usage(data.output?.usage ?? data.usage),
        status: event.startsWith("run.") && event !== "run.start" ? outcome(event, data) : data.status,
        errorType: data.error ? "Error" : undefined,
      });
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level: event.endsWith("error") ? "error" : "info",
        message: event,
        attributes,
        traceId: data.runId ? this.tracer?.getTraceByRunId(data.runId)?.traceId : undefined,
      };
      this.queue.add(entry);
    });
  }
  detach(bus: EventBus) {
    this.attachments.detach(bus);
  }
  flush() {
    return this.queue.flush();
  }
  async shutdown() {
    this.attachments.close();
    await this.queue.close();
  }
  getDiagnostics() {
    return this.queue.stats();
  }
}
