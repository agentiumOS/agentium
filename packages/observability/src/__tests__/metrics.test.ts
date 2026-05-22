import { EventBus } from "@agentium/core";
import { describe, expect, it } from "vitest";
import { MetricsCollector } from "../metrics.js";

describe("MetricsCollector", () => {
  it("counts runs", () => {
    const bus = new EventBus();
    const metrics = new MetricsCollector();
    metrics.attach(bus);

    bus.emit("run.start", { runId: "r1", agentName: "a", input: "hi" });
    bus.emit("run.complete", {
      runId: "r1",
      output: { text: "ok", toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    });

    const snap = metrics.getMetrics();
    expect(snap.counters.runs_total).toBe(1);
    expect(snap.counters.runs_success).toBe(1);
    expect(snap.counters.runs_error).toBe(0);
    expect(snap.gauges.total_tokens).toBe(15);
  });

  it("counts errors", () => {
    const bus = new EventBus();
    const metrics = new MetricsCollector();
    metrics.attach(bus);

    bus.emit("run.start", { runId: "r1", agentName: "a", input: "hi" });
    bus.emit("run.error", { runId: "r1", error: new Error("fail") });

    const snap = metrics.getMetrics();
    expect(snap.counters.runs_total).toBe(1);
    expect(snap.counters.runs_error).toBe(1);
    expect(snap.rates.error_rate).toBe(1);
  });

  it("counts tool calls and measures latency", async () => {
    const bus = new EventBus();
    const metrics = new MetricsCollector();
    metrics.attach(bus);

    bus.emit("tool.call", { runId: "r1", toolName: "t1", args: {} });
    await new Promise((r) => setTimeout(r, 10));
    bus.emit("tool.result", { runId: "r1", toolName: "t1", result: "ok" });

    const snap = metrics.getMetrics();
    expect(snap.counters.tool_calls_total).toBe(1);
    expect(snap.histograms.tool_latency_ms).toHaveLength(1);
    expect(snap.histograms.tool_latency_ms[0]).toBeGreaterThanOrEqual(5);
  });

  it("tracks cache hit/miss ratio", () => {
    const bus = new EventBus();
    const metrics = new MetricsCollector();
    metrics.attach(bus);

    bus.emit("cache.hit" as any, { agentName: "a", input: "q1", cachedId: "c1" });
    bus.emit("cache.miss" as any, { agentName: "a", input: "q2" });
    bus.emit("cache.miss" as any, { agentName: "a", input: "q3" });

    const snap = metrics.getMetrics();
    expect(snap.counters.cache_hits).toBe(1);
    expect(snap.counters.cache_misses).toBe(2);
    expect(snap.rates.cache_hit_ratio).toBeCloseTo(1 / 3, 2);
  });

  it("counts handoffs", () => {
    const bus = new EventBus();
    const metrics = new MetricsCollector();
    metrics.attach(bus);

    bus.emit("handoff.transfer" as any, { runId: "r1", fromAgent: "a", toAgent: "b", reason: "r" });
    bus.emit("handoff.transfer" as any, { runId: "r2", fromAgent: "b", toAgent: "c", reason: "r" });

    const snap = metrics.getMetrics();
    expect(snap.counters.handoffs_total).toBe(2);
  });

  it("reset clears everything", () => {
    const bus = new EventBus();
    const metrics = new MetricsCollector();
    metrics.attach(bus);

    bus.emit("run.start", { runId: "r1", agentName: "a", input: "hi" });
    bus.emit("run.complete", {
      runId: "r1",
      output: { text: "ok", toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
    });

    metrics.reset();
    const snap = metrics.getMetrics();
    expect(snap.counters.runs_total).toBe(0);
    expect(snap.gauges.total_tokens).toBe(0);
  });

  it("detach stops counting", () => {
    const bus = new EventBus();
    const metrics = new MetricsCollector();
    metrics.attach(bus);

    bus.emit("run.start", { runId: "r1", agentName: "a", input: "hi" });
    expect(metrics.getMetrics().counters.runs_total).toBe(1);

    metrics.detach(bus);

    bus.emit("run.start", { runId: "r2", agentName: "a", input: "hi2" });
    expect(metrics.getMetrics().counters.runs_total).toBe(1);
  });
});
