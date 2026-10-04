import { EventBus } from "@agentium/core";
import { afterEach, expect, it, vi } from "vitest";
import { ExportQueue } from "../export-queue.js";
import { CallbackExporter } from "../exporters/callback.js";
import { MetricsCollector } from "../metrics.js";
import { MetricsExporter } from "../metrics-exporter.js";
import { Capture } from "../safety.js";
import { StructuredLogger } from "../structured-logger.js";
import { Tracer } from "../tracer.js";
import type { LogEntry, Trace } from "../types.js";

import { fixtureTrace, output } from "./telemetry-fixture.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("removes content before retention, callbacks and drains; direct exporter is independently safe", async () => {
  const bus = new EventBus();
  const exported: Trace[] = [];
  const logs: LogEntry[] = [];
  const tracer = new Tracer([
    new CallbackExporter((trace) => {
      exported.push(trace);
    }),
  ]);
  const logger = new StructuredLogger((entry) => {
    logs.push(entry);
  });
  tracer.attach(bus);
  logger.attach(bus);
  bus.emit("run.start", { runId: "r", agentName: "demo", input: "PRIVATE_PROMPT" });
  bus.emit("tool.call", { runId: "r", toolCallId: "t", toolName: "search", args: { key: "PRIVATE_TOOL" } });
  bus.emit("tool.result", {
    runId: "r",
    toolCallId: "t",
    toolName: "search",
    result: "PRIVATE_RESULT",
    status: "success",
  });
  bus.emit("run.error", { runId: "r", error: new Error("PRIVATE_ERROR") });
  await Promise.all([tracer.flush(), logger.flush()]);
  expect(JSON.stringify([tracer.getAllTraces(), exported, logs])).not.toMatch(/PRIVATE_/);
  const direct: Trace[] = [];
  const trace = fixtureTrace();
  (trace as any).unlistedSecret = "PRIVATE_EXTRA";
  (trace.spans[0] as any).other = "PRIVATE_EXTRA";
  await new CallbackExporter((safe) => {
    direct.push(safe);
  }).export(trace);
  expect(JSON.stringify(direct)).not.toMatch(/PRIVATE_|SECRET/);
  await Promise.all([tracer.shutdown(), logger.shutdown()]);
});
it("content opt-in redacts nested credentials, cycles and accidental rejected promises", async () => {
  const capture = new Capture({
    capture: {
      mode: "content",
      redact: (path, value) => (path.endsWith("email") ? "[redacted]" : value),
      maxAttributeBytes: 256,
      maxTotalBytes: 512,
    },
  });
  const cyclic: any = { email: "private@email", password: "SECRET", content: "visible" };
  cyclic.self = cyclic;
  const result = capture.attributes({ input: cyclic, apiKey: "SECRET", promise: Promise.reject(new Error("hidden")) });
  expect(JSON.stringify(result)).toContain("visible");
  expect(JSON.stringify(result)).toContain("[redacted]");
  expect(JSON.stringify(result)).not.toMatch(/SECRET|private@email/);
  expect(result.promise).toBeUndefined();
  await Promise.resolve();
  expect(capture.diagnostic.counts.async_capture_rejected).toBe(1);
  expect(Buffer.byteLength(JSON.stringify(capture.attributes({ output: "x".repeat(10000) })))).toBeLessThan(512);
});
it("retains newest traces under count cap and immutable returned snapshots", () => {
  const bus = new EventBus();
  const tracer = new Tracer([], { maxTraces: 2 });
  tracer.attach(bus);
  for (let i = 0; i < 3; i++) {
    bus.emit("run.start", { runId: String(i), agentName: "a", input: "p" });
    bus.emit("run.complete", { runId: String(i), output });
  }
  expect(tracer.getAllTraces().map((t) => t.metadata.runId)).toEqual(["1", "2"]);
  const copy = tracer.getAllTraces();
  copy[0].metadata.agentName = "changed";
  expect(tracer.getAllTraces()[0].metadata.agentName).toBe("a");
});
it("bounds stalled exporter count/bytes, flush and close without replacement work", async () => {
  vi.useFakeTimers();
  const send = vi.fn(() => new Promise<void>(() => {}));
  const queue = new ExportQueue(send, { maxQueuedExports: 3, maxQueuedBytes: 100, maxInFlight: 1, flushTimeoutMs: 10 });
  for (let i = 0; i < 100; i++) queue.add({ i });
  await Promise.resolve();
  expect(queue.stats()).toMatchObject({ queued: 2, inFlight: 1 });
  expect(queue.stats().bytes).toBeLessThanOrEqual(100);
  expect(send).toHaveBeenCalledOnce();
  const flush = queue.flush();
  await vi.advanceTimersByTimeAsync(11);
  await flush;
  const close = queue.close();
  await vi.advanceTimersByTimeAsync(11);
  await close;
  expect(send).toHaveBeenCalledOnce();
  expect(queue.stats()).toMatchObject({ queued: 0, inFlight: 1 });
  expect(queue.add({ i: 100 })).toBe(false);
});
it("coalesces stalled exporter lifecycle calls and never shuts down live export work", async () => {
  vi.useFakeTimers();
  const flush = vi.fn(() => new Promise<void>(() => {}));
  const shutdown = vi.fn(async () => {});
  const tracer = new Tracer([{ name: "stalled", export: async () => {}, flush, shutdown }], { flushTimeoutMs: 10 });
  const first = tracer.flush();
  await vi.advanceTimersByTimeAsync(11);
  await first;
  const second = tracer.flush();
  await vi.advanceTimersByTimeAsync(11);
  await second;
  expect(flush).toHaveBeenCalledOnce();
  const closing = tracer.shutdown();
  await vi.advanceTimersByTimeAsync(11);
  await closing;
  expect(shutdown).not.toHaveBeenCalled();
  expect(tracer.getDiagnostics().capture.shutdown_pending_work).toBe(1);
});
it("attach/detach is bus-specific and idempotent across tracer, collector and dashboard", () => {
  const one = new EventBus(),
    two = new EventBus();
  const tracer = new Tracer(),
    collector = new MetricsCollector(),
    dashboard = new MetricsExporter();
  for (const observer of [tracer, collector, dashboard]) {
    observer.attach(one);
    observer.attach(one);
    observer.attach(two);
    observer.detach(one);
  }
  for (const [bus, id] of [
    [one, "one"],
    [two, "two"],
  ] as const) {
    bus.emit("run.start", { runId: id, agentName: "a", input: "p" });
    bus.emit("run.complete", { runId: id, output });
  }
  expect(tracer.getAllTraces()).toHaveLength(1);
  expect(collector.getMetrics().counters.runs_total).toBe(1);
  expect(dashboard.getMetrics().runs).toBe(1);
});
it("shared accounting handles reversed concurrent calls, cancellation and terminal deduplication", () => {
  vi.useFakeTimers();
  const bus = new EventBus(),
    metrics = new MetricsCollector(),
    dashboard = new MetricsExporter();
  metrics.attach(bus);
  dashboard.attach(bus);
  bus.emit("run.start", { runId: "r", agentName: "a", input: "p" });
  bus.emit("tool.call", { runId: "r", toolName: "same", toolCallId: "one", args: {} });
  vi.advanceTimersByTime(5);
  bus.emit("tool.call", { runId: "r", toolName: "same", toolCallId: "two", args: {} });
  vi.advanceTimersByTime(2);
  bus.emit("tool.result", { runId: "r", toolName: "same", toolCallId: "two", result: "ok" });
  vi.advanceTimersByTime(3);
  bus.emit("tool.result", { runId: "r", toolName: "same", toolCallId: "one", result: "ok" });
  bus.emit("run.cancelled", { runId: "r", agentName: "a" });
  bus.emit("run.complete", { runId: "r", output: { ...output, status: "cancelled" } });
  bus.emit("run.error", { runId: "r", error: new Error("duplicate") });
  expect(metrics.getMetrics().histograms.tool_latency_ms).toEqual([2, 10]);
  expect(metrics.getMetrics().counters).toMatchObject({
    runs_total: 1,
    runs_cancelled: 1,
    runs_error: 1,
    runs_success: 0,
  });
  expect(metrics.getMetrics().gauges.total_tokens).toBe(3);
  expect(dashboard.getMetrics()).toMatchObject({ runs: 1, errors: 1, totalTokens: 3 });
  expect(dashboard.getDiagnostics()).toMatchObject({ activeRuns: 0, activeTools: 0 });
});
it("keeps cumulative Prometheus counters separate from bounded rolling records and escapes labels", () => {
  const bus = new EventBus(),
    metrics = new MetricsExporter({ maxRecords: 1 });
  metrics.attach(bus);
  for (let i = 0; i < 3; i++) {
    bus.emit("run.start", { runId: String(i), agentName: 'a"\\\nb', input: "p" });
    bus.emit("run.complete", { runId: String(i), output });
  }
  expect(metrics.getMetrics().runs).toBe(1);
  expect(metrics.toPrometheus()).toContain('agentium_agent_runs_total{agent="a\\"\\\\\\nb"} 3');
  expect(metrics.toPrometheus().match(/# TYPE agentium_agent_duration_ms_avg/g)).toHaveLength(1);
});
it("bounds subscriber buffers in count and bytes and settles pending next on return", async () => {
  const bus = new EventBus(),
    metrics = new MetricsExporter({ maxSubscriberEvents: 2, maxSubscriberBytes: 600, maxSubscribers: 1 });
  metrics.attach(bus);
  const stream = metrics.stream();
  expect(() => metrics.stream()).toThrow(/limit/);
  for (let i = 0; i < 20; i++) bus.emit("run.start", { runId: String(i), agentName: "a".repeat(10000), input: "p" });
  expect(metrics.getDiagnostics().subscriberBytes).toBeLessThanOrEqual(600);
  expect(metrics.getDiagnostics().droppedSubscriberEvents).toBeGreaterThan(0);
  const first = stream.next();
  await first;
  const second = stream.next();
  const third = stream.next();
  await stream.return!();
  expect((await second).done).toBe(true);
  expect((await third).done).toBe(true);
  expect(metrics.getDiagnostics().subscriberBytes).toBe(0);
});
it("uses only host-supplied upstream context and keeps child model flags and linkage", () => {
  const bus = new EventBus();
  const tracer = new Tracer([], {
    parentContext: { traceId: "c".repeat(32), spanId: "d".repeat(16), traceFlags: 0, traceState: "vendor=value" },
  });
  tracer.attach(bus);
  bus.emit("run.start", { runId: "r", agentName: "a", input: "p" });
  bus.emit("model.start", { runId: "r", modelCallId: "m", modelId: "test", providerId: "synthetic" });
  bus.emit("model.result", {
    runId: "r",
    modelCallId: "m",
    modelId: "test",
    providerId: "synthetic",
    usage: output.usage,
  });
  bus.emit("run.complete", { runId: "r", output });
  const trace = tracer.getAllTraces()[0];
  expect(trace.traceId).toBe("c".repeat(32));
  expect(trace.spans[0].parentSpanId).toBe("d".repeat(16));
  expect(trace.spans[1]).toMatchObject({
    parentSpanId: trace.rootSpanId,
    traceFlags: 0,
    traceState: "vendor=value",
    status: "ok",
  });
});

it("eventually shuts down a timed-out exporter once its owned work settles", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const shutdown = vi.fn(async () => {});
  const bus = new EventBus();
  const tracer = new Tracer(
    [
      {
        name: "slow",
        export: () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
        shutdown,
      },
    ],
    { flushTimeoutMs: 10 },
  );
  tracer.attach(bus);
  bus.emit("run.start", { runId: "r", agentName: "a", input: "p" });
  bus.emit("run.complete", { runId: "r", output });
  await Promise.resolve();
  const closing = tracer.shutdown();
  await vi.advanceTimersByTimeAsync(20);
  await closing;
  expect(shutdown).not.toHaveBeenCalled();
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(shutdown).toHaveBeenCalledOnce();
  await tracer.shutdown();
  expect(shutdown).toHaveBeenCalledOnce();
});
