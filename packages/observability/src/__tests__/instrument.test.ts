import { EventBus } from "@agentium/core";
import { describe, expect, it } from "vitest";
import { CallbackExporter } from "../exporters/callback.js";
import { instrumentBus } from "../instrument.js";

describe("instrument", () => {
  it("attaches tracer, metrics, and logger to an eventBus", async () => {
    const bus = new EventBus();
    const exported: any[] = [];

    const obs = instrumentBus(bus, {
      exporters: [new CallbackExporter((t) => exported.push(t))],
      metrics: true,
      structuredLogs: (_entry) => {},
    });

    expect(obs.tracer).toBeDefined();
    expect(obs.metrics).toBeDefined();
    expect(obs.logger).toBeDefined();

    bus.emit("run.start", { runId: "r1", agentName: "a", input: "hi" });
    bus.emit("run.complete", {
      runId: "r1",
      output: { text: "ok", toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(exported).toHaveLength(1);
    expect(obs.metrics!.getMetrics().counters.runs_total).toBe(1);
    expect(obs.tracer.getAllTraces()).toHaveLength(1);
  });

  it("detach removes all listeners", () => {
    const bus = new EventBus();
    const obs = instrumentBus(bus, { metrics: true });

    bus.emit("run.start", { runId: "r1", agentName: "a", input: "hi" });
    expect(obs.metrics!.getMetrics().counters.runs_total).toBe(1);

    obs.detach();

    bus.emit("run.start", { runId: "r2", agentName: "a", input: "hi2" });
    expect(obs.metrics!.getMetrics().counters.runs_total).toBe(1);
    expect(obs.tracer.getAllTraces()).toHaveLength(1);
  });

  it("works without metrics if disabled", () => {
    const bus = new EventBus();
    const obs = instrumentBus(bus, { metrics: false });

    expect(obs.metrics).toBeNull();
    expect(obs.tracer).toBeDefined();
  });
});
