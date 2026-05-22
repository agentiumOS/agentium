import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../event-bus.js";

describe("EventBus", () => {
  it("emits and receives events", () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on("run.start", handler);
    bus.emit("run.start", { runId: "r1", agentName: "test", input: "hi" });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({
      runId: "r1",
      agentName: "test",
      input: "hi",
    });
  });

  it("once() fires only once", () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.once("run.start", handler);
    bus.emit("run.start", { runId: "r1", agentName: "test", input: "a" });
    bus.emit("run.start", { runId: "r2", agentName: "test", input: "b" });

    expect(handler).toHaveBeenCalledOnce();
  });

  it("off() removes handler", () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on("tool.call", handler);
    bus.off("tool.call", handler);
    bus.emit("tool.call", { runId: "r1", toolName: "t", args: {} });

    expect(handler).not.toHaveBeenCalled();
  });

  it("removeAllListeners clears all handlers for an event", () => {
    const bus = new EventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();

    bus.on("run.error", h1);
    bus.on("run.error", h2);
    bus.removeAllListeners("run.error");
    bus.emit("run.error", { runId: "r1", error: new Error("x") });

    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });

  it("supports multiple handlers for the same event", () => {
    const bus = new EventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();

    bus.on("tool.result", h1);
    bus.on("tool.result", h2);
    bus.emit("tool.result", { runId: "r1", toolName: "t", result: "ok" });

    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });
});
