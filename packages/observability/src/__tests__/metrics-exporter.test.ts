import { EventBus } from "@agentium/core";
import { beforeEach, describe, expect, it } from "vitest";
import { MetricsExporter } from "../metrics-exporter.js";

describe("MetricsExporter", () => {
  let exporter: MetricsExporter;
  let bus: EventBus;

  beforeEach(() => {
    exporter = new MetricsExporter();
    bus = new EventBus();
    exporter.attach(bus);
  });

  it("tracks run lifecycle", () => {
    bus.emit("run.start", { runId: "r1", agentName: "bot", input: "hi" });
    bus.emit("run.complete", {
      runId: "r1",
      output: { text: "hello", toolCalls: [], usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } },
    });

    const metrics = exporter.getMetrics("bot");
    expect(metrics.runs).toBe(1);
    expect(metrics.errors).toBe(0);
    expect(metrics.totalTokens).toBe(150);
    expect(metrics.avgDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("tracks errors", () => {
    bus.emit("run.start", { runId: "r2", agentName: "bot", input: "hi" });
    bus.emit("run.error", { runId: "r2", error: new Error("boom") });

    const metrics = exporter.getMetrics("bot");
    expect(metrics.errors).toBe(1);
    expect(metrics.errorRate).toBe(1);
  });

  it("tracks tool usage frequency", () => {
    bus.emit("run.start", { runId: "r3", agentName: "bot", input: "hi" });
    bus.emit("tool.call", { runId: "r3", toolName: "search" });
    bus.emit("tool.call", { runId: "r3", toolName: "search" });
    bus.emit("tool.call", { runId: "r3", toolName: "calculate" });
    bus.emit("run.complete", {
      runId: "r3",
      output: { text: "done", toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
    });

    const metrics = exporter.getMetrics("bot");
    expect(metrics.toolCallCount).toBe(3);
    expect(metrics.toolUsageFrequency.search).toBe(2);
    expect(metrics.toolUsageFrequency.calculate).toBe(1);
  });

  it("produces Prometheus format", () => {
    bus.emit("run.start", { runId: "r4", agentName: "my-agent", input: "test" });
    bus.emit("run.complete", {
      runId: "r4",
      output: { text: "ok", toolCalls: [], usage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 } },
    });

    const prom = exporter.toPrometheus();
    expect(prom).toContain("agentium_agent_runs_total");
    expect(prom).toContain('agent="my-agent"');
    expect(prom).toContain("agentium_agent_tokens_total");
  });

  it("produces JSON format with byAgent breakdown", () => {
    bus.emit("run.start", { runId: "r5", agentName: "a1", input: "x" });
    bus.emit("run.complete", {
      runId: "r5",
      output: { text: "y", toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    });

    const json = exporter.toJSON() as any;
    expect(json.global.runs).toBe(1);
    expect(json.byAgent.a1).toBeDefined();
    expect(json.byAgent.a1.runs).toBe(1);
  });

  it("global metrics aggregate all agents", () => {
    bus.emit("run.start", { runId: "r6", agentName: "a1", input: "x" });
    bus.emit("run.complete", {
      runId: "r6",
      output: { text: "y", toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    });
    bus.emit("run.start", { runId: "r7", agentName: "a2", input: "z" });
    bus.emit("run.complete", {
      runId: "r7",
      output: { text: "w", toolCalls: [], usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 } },
    });

    const global = exporter.getMetrics();
    expect(global.runs).toBe(2);
    expect(global.totalTokens).toBe(45);
  });
});
