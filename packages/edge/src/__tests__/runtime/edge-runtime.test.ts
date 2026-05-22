import { afterEach, describe, expect, it, vi } from "vitest";
import { EdgeRuntime } from "../../runtime/edge-runtime.js";

describe("EdgeRuntime", () => {
  const mockAgent = {} as any;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts with 'running' state", async () => {
    const runtime = new EdgeRuntime({
      preset: "pi5-8gb",
      agent: mockAgent,
      disableHealthCheck: true,
    });

    await runtime.start();
    expect(runtime.state).toBe("running");

    const status = runtime.getStatus();
    expect(status.state).toBe("running");
    expect(status.uptime_ms).toBeGreaterThanOrEqual(0);
    expect(status.watchdog_restarts).toBe(0);

    await runtime.stop();
    expect(runtime.state).toBe("stopped");
  });

  it("uses preset configuration", async () => {
    const runtime = new EdgeRuntime({
      preset: "pi4-4gb",
      agent: mockAgent,
      disableHealthCheck: true,
    });

    await runtime.start();
    const monitor = runtime.getMonitor();
    expect(monitor).toBeDefined();
    await runtime.stop();
  });

  it("heartbeat updates last activity", async () => {
    const runtime = new EdgeRuntime({
      preset: "pi5-8gb",
      agent: mockAgent,
      disableHealthCheck: true,
    });

    await runtime.start();
    runtime.heartbeat();
    const status = runtime.getStatus();
    expect(status.watchdog_restarts).toBe(0);
    await runtime.stop();
  });

  it("emits events on lifecycle", async () => {
    const events: string[] = [];
    const runtime = new EdgeRuntime({
      preset: "pi5-8gb",
      agent: mockAgent,
      disableHealthCheck: true,
    });

    runtime.on("started", () => events.push("started"));
    runtime.on("stopped", () => events.push("stopped"));

    await runtime.start();
    await runtime.stop();

    expect(events).toContain("started");
    expect(events).toContain("stopped");
  });

  it("accepts custom preset object", async () => {
    const runtime = new EdgeRuntime({
      preset: {
        id: "custom",
        label: "Custom",
        recommendedModel: "tinyllama:1.1b",
        maxTokens: 256,
        contextWindow: 2048,
        memoryLimitMb: 512,
        watchdogTimeoutMs: 5000,
        monitorIntervalMs: 60000,
        thermalThrottleC: 80,
        memoryThreshold: 0.9,
        disableFeatures: [],
      },
      agent: mockAgent,
      disableHealthCheck: true,
    });

    await runtime.start();
    expect(runtime.state).toBe("running");
    await runtime.stop();
  });
});
