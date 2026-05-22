import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../../events/event-bus.js";
import type { WebhookDestination } from "../types.js";
import { WebhookManager } from "../webhook-manager.js";

function mockDestination(name = "test"): WebhookDestination & { send: ReturnType<typeof vi.fn> } {
  return {
    name,
    send: vi.fn().mockResolvedValue(undefined),
  };
}

describe("WebhookManager", () => {
  it("sends events to all destinations", async () => {
    const dest1 = mockDestination("d1");
    const dest2 = mockDestination("d2");
    const bus = new EventBus();

    const manager = new WebhookManager({
      destinations: [dest1, dest2],
    });
    manager.attach(bus);

    bus.emit("run.start", { runId: "r1", agentName: "a", input: "hello" });

    await new Promise((r) => setTimeout(r, 50));

    expect(dest1.send).toHaveBeenCalledWith("run.start", expect.any(Object));
    expect(dest2.send).toHaveBeenCalledWith("run.start", expect.any(Object));
  });

  it("filters events by configured list", async () => {
    const dest = mockDestination();
    const bus = new EventBus();

    const manager = new WebhookManager({
      destinations: [dest],
      events: ["run.complete"],
    });
    manager.attach(bus);

    bus.emit("run.start", { runId: "r1", agentName: "a", input: "hello" });
    await new Promise((r) => setTimeout(r, 50));
    expect(dest.send).not.toHaveBeenCalled();

    bus.emit("run.complete", {
      runId: "r1",
      output: { text: "hi", toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(dest.send).toHaveBeenCalledOnce();
  });

  it("retries on failure", async () => {
    const dest = mockDestination();
    dest.send.mockRejectedValueOnce(new Error("network error")).mockResolvedValueOnce(undefined);

    const bus = new EventBus();
    const manager = new WebhookManager({
      destinations: [dest],
      retries: 2,
    });
    manager.attach(bus);

    bus.emit("run.start", { runId: "r1", agentName: "a", input: "hello" });
    await new Promise((r) => setTimeout(r, 300));

    expect(dest.send).toHaveBeenCalledTimes(2);
  });

  it("batches events when batchInterval is set", async () => {
    const dest = mockDestination();
    const bus = new EventBus();

    const manager = new WebhookManager({
      destinations: [dest],
      batchInterval: 100,
    });
    manager.attach(bus);

    bus.emit("run.start", { runId: "r1", agentName: "a", input: "hello" });
    bus.emit("run.start", { runId: "r2", agentName: "a", input: "world" });

    expect(dest.send).not.toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, 200));

    expect(dest.send).toHaveBeenCalledTimes(2);

    manager.detach(bus);
  });

  it("flushes pending batched events", async () => {
    const dest = mockDestination();
    const bus = new EventBus();

    const manager = new WebhookManager({
      destinations: [dest],
      batchInterval: 10000,
    });
    manager.attach(bus);

    bus.emit("run.start", { runId: "r1", agentName: "a", input: "hello" });

    await manager.flush();

    expect(dest.send).toHaveBeenCalledOnce();
    manager.detach(bus);
  });
});
