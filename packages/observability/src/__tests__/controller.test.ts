import { EventBus } from "@agentium/core";
import { expect, it } from "vitest";
import { instrumentBus } from "../instrument.js";

it("traces overlapping controller decisions by invocation ID without inflating model/tool accounting", async () => {
  const bus = new EventBus();
  const observation = instrumentBus(bus);
  bus.emit("run.start", { runId: "run", agentName: "custom", input: "" });
  for (const id of ["one", "two"])
    bus.emit("controller.start", { runId: "run", controllerCallId: id, operation: "prepareStep" });
  bus.emit("controller.result", {
    runId: "run",
    controllerCallId: "two",
    operation: "prepareStep",
    decision: "continue",
    modelRole: "main",
  });
  bus.emit("controller.error", {
    runId: "run",
    controllerCallId: "one",
    operation: "prepareStep",
    status: "cancelled",
  });
  bus.emit("run.complete", {
    runId: "run",
    output: { text: "", toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
  });
  const trace = observation.tracer.getTraceByRunId("run")!;
  expect(trace.spans.map((span) => span.status)).toEqual(["ok", "error", "ok"]);
  expect(trace.spans[2].attributes).toMatchObject({ controllerCallId: "two", decision: "continue", modelRole: "main" });
  expect(trace.spans.slice(1).every((span) => span.kind === "internal")).toBe(true);
  await observation.shutdown();
});
