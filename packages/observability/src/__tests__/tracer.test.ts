import { EventBus } from "@agentium/core";
import { describe, expect, it } from "vitest";
import { Tracer } from "../tracer.js";
import type { TraceExporter } from "../types.js";

describe("Tracer", () => {
  it("creates a trace from run.start and run.complete", async () => {
    const bus = new EventBus();
    const tracer = new Tracer();
    tracer.attach(bus);

    bus.emit("run.start", { runId: "r1", agentName: "assistant", input: "hello" });
    bus.emit("run.complete", {
      runId: "r1",
      output: { text: "hi", toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    });

    await new Promise((r) => setTimeout(r, 50));

    const traces = tracer.getAllTraces();
    expect(traces).toHaveLength(1);

    const trace = traces[0];
    expect(trace.spans).toHaveLength(1);
    expect(trace.spans[0].name).toBe("agent.run");
    expect(trace.spans[0].status).toBe("ok");
    expect(trace.spans[0].attributes.agentName).toBe("assistant");
    expect(trace.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("tracks tool call spans as children of the run span", async () => {
    const bus = new EventBus();
    const tracer = new Tracer();
    tracer.attach(bus);

    bus.emit("run.start", { runId: "r1", agentName: "a", input: "test" });
    bus.emit("tool.call", { runId: "r1", toolName: "get_weather", args: { city: "NYC" } });
    bus.emit("tool.result", { runId: "r1", toolName: "get_weather", result: "72F" });
    bus.emit("run.complete", {
      runId: "r1",
      output: { text: "It's 72F", toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
    });

    await new Promise((r) => setTimeout(r, 50));

    const trace = tracer.getAllTraces()[0];
    expect(trace.spans).toHaveLength(2);

    const toolSpan = trace.spans.find((s) => s.name === "tool.get_weather");
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.kind).toBe("tool");
    expect(toolSpan!.status).toBe("ok");
    expect(toolSpan!.parentSpanId).toBe(trace.rootSpanId);
  });

  it("marks error runs correctly", async () => {
    const bus = new EventBus();
    const tracer = new Tracer();
    tracer.attach(bus);

    bus.emit("run.start", { runId: "r1", agentName: "a", input: "test" });
    bus.emit("run.error", { runId: "r1", error: new Error("boom") });

    await new Promise((r) => setTimeout(r, 50));

    const trace = tracer.getAllTraces()[0];
    expect(trace.spans[0].status).toBe("error");
    expect(trace.spans[0].attributes.error).toBeUndefined();
    expect(trace.spans[0].attributes.errorType).toBe("Error");
  });

  it("tracks handoff spans", async () => {
    const bus = new EventBus();
    const tracer = new Tracer();
    tracer.attach(bus);

    bus.emit("run.start", { runId: "r1", agentName: "front-desk", input: "billing q" });
    bus.emit("handoff.transfer", { runId: "r1", fromAgent: "front-desk", toAgent: "billing", reason: "payment" });
    bus.emit("run.complete", {
      runId: "r1",
      output: { text: "done", toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
    });

    await new Promise((r) => setTimeout(r, 50));

    const trace = tracer.getAllTraces()[0];
    const handoffSpan = trace.spans.find((s) => s.kind === "handoff");
    expect(handoffSpan).toBeDefined();
    expect(handoffSpan!.name).toContain("front-desk->billing");
  });

  it("records cache events as span events", async () => {
    const bus = new EventBus();
    const tracer = new Tracer();
    tracer.attach(bus);

    bus.emit("run.start", { runId: "r1", agentName: "a", input: "test" });
    bus.emit("cache.miss", { agentName: "a", input: "test" });
    bus.emit("run.complete", {
      runId: "r1",
      output: { text: "res", toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
    });

    await new Promise((r) => setTimeout(r, 50));

    const trace = tracer.getAllTraces()[0];
    const rootSpan = trace.spans[0];
    expect(rootSpan.events.some((e) => e.name === "cache.miss")).toBe(true);
  });

  it("calls exporters when trace finalizes", async () => {
    const exported: any[] = [];
    const exporter: TraceExporter = {
      name: "test",
      export: async (trace) => {
        exported.push(trace);
      },
    };

    const bus = new EventBus();
    const tracer = new Tracer([exporter]);
    tracer.attach(bus);

    bus.emit("run.start", { runId: "r1", agentName: "a", input: "test" });
    bus.emit("run.complete", {
      runId: "r1",
      output: { text: "ok", toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(exported).toHaveLength(1);
    expect(exported[0].traceId).toBeDefined();
  });

  it("getTraceByRunId works", () => {
    const bus = new EventBus();
    const tracer = new Tracer();
    tracer.attach(bus);

    bus.emit("run.start", { runId: "r42", agentName: "a", input: "hi" });

    const trace = tracer.getTraceByRunId("r42");
    expect(trace).toBeDefined();
    expect(trace!.metadata.runId).toBe("r42");
  });

  it("detach removes listeners", () => {
    const bus = new EventBus();
    const tracer = new Tracer();
    tracer.attach(bus);

    bus.emit("run.start", { runId: "r1", agentName: "a", input: "hi" });
    expect(tracer.getAllTraces()).toHaveLength(1);

    tracer.detach(bus);

    bus.emit("run.start", { runId: "r2", agentName: "a", input: "hi2" });
    expect(tracer.getAllTraces()).toHaveLength(1);
  });

  it("clear removes all traces", () => {
    const bus = new EventBus();
    const tracer = new Tracer();
    tracer.attach(bus);

    bus.emit("run.start", { runId: "r1", agentName: "a", input: "hi" });
    expect(tracer.getAllTraces()).toHaveLength(1);

    tracer.clear();
    expect(tracer.getAllTraces()).toHaveLength(0);
  });
});

it("pairs concurrent same-tool outcomes by call ID even when completion order reverses", () => {
  const bus = new EventBus();
  const tracer = new Tracer([], { capture: { mode: "content" } });
  tracer.attach(bus);
  bus.emit("run.start", { runId: "r", agentName: "same", input: "work" });
  bus.emit("tool.call", { runId: "r", toolCallId: "a", toolName: "search", args: { query: "first" } });
  bus.emit("tool.call", { runId: "r", toolCallId: "b", toolName: "search", args: { query: "second" } });
  bus.emit("tool.result", { runId: "r", toolCallId: "b", toolName: "search", result: "second-result" });
  bus.emit("tool.result", { runId: "r", toolCallId: "a", toolName: "search", result: "first-result" });
  const spans = tracer.getAllTraces()[0].spans;
  expect(spans.find((span) => span.attributes.toolCallId === "a")?.attributes.output).toBe("first-result");
  expect(spans.find((span) => span.attributes.toolCallId === "b")?.attributes.output).toBe("second-result");
});

it.each(["cancelled", "stopped"] as const)("preserves %s completion status in the root span", (status) => {
  const bus = new EventBus();
  const tracer = new Tracer();
  tracer.attach(bus);
  bus.emit("run.start", { runId: "partial", agentName: "worker", input: "work" });
  bus.emit("run.complete", {
    runId: "partial",
    output: { text: "partial", toolCalls: [], status, usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } },
  });
  const span = tracer.getAllTraces()[0].spans[0];
  expect(span.status).toBe("error");
  expect(span.attributes.runStatus).toBe(status);
  tracer.detach(bus);
});
