import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EdgeCloudSync } from "../../sync/edge-cloud-sync.js";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs");
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue(""),
  };
});

describe("EdgeCloudSync", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates sync instance", () => {
    const sync = new EdgeCloudSync({
      cloudUrl: "https://cloud.example.com",
      deviceId: "pi-001",
    });

    expect(sync.isConnected).toBe(false);
    expect(sync.queueSize).toBe(0);
  });

  it("queues events when offline", () => {
    const sync = new EdgeCloudSync({
      cloudUrl: "https://cloud.example.com",
      deviceId: "pi-001",
    });

    sync.pushEvent("agent.run", { result: "hello" });
    sync.pushEvent("agent.run", { result: "world" });

    expect(sync.queueSize).toBe(2);
  });

  it("respects max queue size", () => {
    const sync = new EdgeCloudSync({
      cloudUrl: "https://cloud.example.com",
      deviceId: "pi-001",
      maxQueueSize: 3,
    });

    for (let i = 0; i < 5; i++) {
      sync.pushEvent("test", { i });
    }

    expect(sync.queueSize).toBe(3);
  });

  describe("sendHeartbeat", () => {
    it("marks connected on success", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "ok" }),
      });

      const sync = new EdgeCloudSync({
        cloudUrl: "https://cloud.example.com",
        deviceId: "pi-001",
      });

      await sync.sendHeartbeat();
      expect(sync.isConnected).toBe(true);
    });

    it("marks disconnected on failure", async () => {
      (global.fetch as any).mockRejectedValue(new Error("Network error"));

      const sync = new EdgeCloudSync({
        cloudUrl: "https://cloud.example.com",
        deviceId: "pi-001",
      });

      await sync.sendHeartbeat();
      expect(sync.isConnected).toBe(false);
    });
  });

  describe("flush", () => {
    it("sends queued events on success", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "ok" }),
      });

      const sync = new EdgeCloudSync({
        cloudUrl: "https://cloud.example.com",
        deviceId: "pi-001",
      });

      sync.pushEvent("test", { data: 1 });
      sync.pushEvent("test", { data: 2 });

      const result = await sync.flush();
      expect(result.sent).toBe(2);
      expect(result.remaining).toBe(0);
      expect(sync.queueSize).toBe(0);
    });

    it("keeps events in queue on failure", async () => {
      (global.fetch as any).mockRejectedValue(new Error("Network error"));

      const sync = new EdgeCloudSync({
        cloudUrl: "https://cloud.example.com",
        deviceId: "pi-001",
      });

      sync.pushEvent("test", { data: 1 });
      const result = await sync.flush();
      expect(result.failed).toBe(1);
      expect(result.remaining).toBe(1);
    });

    it("returns zeros when queue is empty", async () => {
      const sync = new EdgeCloudSync({
        cloudUrl: "https://cloud.example.com",
        deviceId: "pi-001",
      });

      const result = await sync.flush();
      expect(result).toEqual({ sent: 0, failed: 0, remaining: 0 });
    });
  });

  describe("pullConfig", () => {
    it("fetches agents, teams, and workflows", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const sync = new EdgeCloudSync({
        cloudUrl: "https://cloud.example.com",
        deviceId: "pi-001",
        authToken: "secret-token",
      });

      const config = await sync.pullConfig();
      expect(config).toHaveProperty("agents");
      expect(config).toHaveProperty("teams");
      expect(config).toHaveProperty("workflows");
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it("includes auth header when token provided", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const sync = new EdgeCloudSync({
        cloudUrl: "https://cloud.example.com",
        deviceId: "pi-001",
        authToken: "my-token",
      });

      await sync.pullConfig();

      const calls = (global.fetch as any).mock.calls;
      for (const call of calls) {
        expect(call[1]?.headers?.Authorization).toBe("Bearer my-token");
      }
    });
  });

  it("start and stop manage timers", () => {
    const sync = new EdgeCloudSync({
      cloudUrl: "https://cloud.example.com",
      deviceId: "pi-001",
      heartbeatIntervalMs: 60000,
    });

    (global.fetch as any).mockRejectedValue(new Error("offline"));
    sync.start();
    sync.stop();
  });
});
