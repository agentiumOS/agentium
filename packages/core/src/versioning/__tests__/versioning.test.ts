import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorage } from "../../storage/in-memory.js";
import { ABRouter } from "../ab-router.js";
import { VersionStore } from "../version-store.js";

describe("VersionStore", () => {
  let store: VersionStore;

  beforeEach(() => {
    store = new VersionStore(new InMemoryStorage());
  });

  it("saves and loads a version", async () => {
    const saved = await store.save({
      agentName: "test-agent",
      instructions: "Be helpful",
      modelId: "gpt-4o",
      providerId: "openai",
      toolNames: ["search"],
      temperature: 0.7,
    });

    expect(saved.versionId).toBeTruthy();
    expect(saved.createdAt).toBeInstanceOf(Date);

    const loaded = await store.load("test-agent", saved.versionId);
    expect(loaded).toBeTruthy();
    expect(loaded!.agentName).toBe("test-agent");
    expect(loaded!.modelId).toBe("gpt-4o");
  });

  it("returns null for unknown version", async () => {
    const loaded = await store.load("test-agent", "nonexistent");
    expect(loaded).toBeNull();
  });

  it("lists versions for an agent sorted by date (newest first)", async () => {
    await store.save({ agentName: "agent", instructions: "v1", modelId: "m1", providerId: "p", toolNames: [] });
    await store.save({ agentName: "agent", instructions: "v2", modelId: "m2", providerId: "p", toolNames: [] });
    await store.save({ agentName: "agent", instructions: "v3", modelId: "m3", providerId: "p", toolNames: [] });

    const versions = await store.list("agent");
    expect(versions).toHaveLength(3);
    expect(new Date(versions[0].createdAt).getTime()).toBeGreaterThanOrEqual(new Date(versions[1].createdAt).getTime());
  });

  it("latest() returns newest version", async () => {
    await store.save({ agentName: "a", instructions: "v1", modelId: "m1", providerId: "p", toolNames: [] });
    await new Promise((r) => setTimeout(r, 5));
    const v2 = await store.save({ agentName: "a", instructions: "v2", modelId: "m2", providerId: "p", toolNames: [] });

    const latest = await store.latest("a");
    expect(latest?.versionId).toBe(v2.versionId);
  });

  it("latest() returns null for unknown agent", async () => {
    expect(await store.latest("unknown")).toBeNull();
  });

  it("diff() detects model changes", async () => {
    const v1 = await store.save({
      agentName: "a",
      instructions: "same",
      modelId: "gpt-4o",
      providerId: "openai",
      toolNames: ["search"],
    });
    const v2 = await store.save({
      agentName: "a",
      instructions: "same",
      modelId: "gpt-4o-mini",
      providerId: "openai",
      toolNames: ["search"],
    });

    const diffs = store.diff(v1, v2);
    expect(diffs.some((d) => d.field === "modelId")).toBe(true);
  });

  it("diff() detects tool changes", async () => {
    const v1 = await store.save({
      agentName: "a",
      instructions: "x",
      modelId: "m",
      providerId: "p",
      toolNames: ["a", "b"],
    });
    const v2 = await store.save({
      agentName: "a",
      instructions: "x",
      modelId: "m",
      providerId: "p",
      toolNames: ["a", "c"],
    });

    const diffs = store.diff(v1, v2);
    expect(diffs.some((d) => d.field === "toolNames")).toBe(true);
  });

  it("diff() returns empty for identical versions", async () => {
    const v1 = await store.save({ agentName: "a", instructions: "x", modelId: "m", providerId: "p", toolNames: ["a"] });
    const v2 = await store.save({ agentName: "a", instructions: "x", modelId: "m", providerId: "p", toolNames: ["a"] });

    const diffs = store.diff(v1, v2);
    expect(diffs).toHaveLength(0);
  });

  it("delete() removes a version", async () => {
    const v = await store.save({ agentName: "a", instructions: "x", modelId: "m", providerId: "p", toolNames: [] });
    await store.delete("a", v.versionId);
    expect(await store.load("a", v.versionId)).toBeNull();
  });
});

describe("ABRouter", () => {
  it("routes to control by default (low split)", () => {
    const router = new ABRouter({
      name: "test",
      control: { agentName: "v1" },
      variant: { agentName: "v2" },
      trafficSplit: 0,
      routing: "random",
    });

    expect(router.route({})).toBe("control");
  });

  it("routes to variant with 100% split", () => {
    const router = new ABRouter({
      name: "test",
      control: { agentName: "v1" },
      variant: { agentName: "v2" },
      trafficSplit: 1.0,
      routing: "random",
    });

    expect(router.route({})).toBe("variant");
  });

  it("deterministic user-based routing returns same result for same user", () => {
    const router = new ABRouter({
      name: "test",
      control: { agentName: "v1" },
      variant: { agentName: "v2" },
      trafficSplit: 0.5,
      routing: "user",
    });

    const first = router.route({ userId: "user-42" });
    const second = router.route({ userId: "user-42" });
    expect(first).toBe(second);
  });

  it("deterministic session-based routing", () => {
    const router = new ABRouter({
      name: "test",
      control: { agentName: "v1" },
      variant: { agentName: "v2" },
      trafficSplit: 0.5,
      routing: "session",
    });

    const first = router.route({ sessionId: "session-abc" });
    const second = router.route({ sessionId: "session-abc" });
    expect(first).toBe(second);
  });

  it("tracks metrics correctly", () => {
    const router = new ABRouter({
      name: "test",
      control: { agentName: "v1" },
      variant: { agentName: "v2" },
      trafficSplit: 0.5,
      routing: "random",
    });

    router.recordRun("control", true, 1000, 100);
    router.recordRun("control", true, 1200, 150);
    router.recordRun("variant", true, 800, 80);
    router.recordRun("variant", false, 1500, 200);

    const metrics = router.getMetrics();
    expect(metrics.control.totalRuns).toBe(2);
    expect(metrics.control.successCount).toBe(2);
    expect(metrics.variant.totalRuns).toBe(2);
    expect(metrics.variant.errorCount).toBe(1);
    expect(metrics.control.avgLatencyMs).toBe(1100);
  });

  it("shouldAutoRollback returns false with no config", () => {
    const router = new ABRouter({
      name: "test",
      control: { agentName: "v1" },
      variant: { agentName: "v2" },
      trafficSplit: 0.5,
      routing: "random",
    });

    router.recordRun("variant", false, 1000, 100);
    expect(router.shouldAutoRollback()).toBe(false);
  });

  it("shouldAutoRollback triggers when error rate exceeds threshold", () => {
    const router = new ABRouter({
      name: "test",
      control: { agentName: "v1" },
      variant: { agentName: "v2" },
      trafficSplit: 0.5,
      routing: "random",
      autoRollback: { errorRateThreshold: 0.3, windowMs: 60_000 },
    });

    for (let i = 0; i < 10; i++) {
      router.recordRun("variant", false, 1000, 100);
    }

    expect(router.shouldAutoRollback()).toBe(true);
  });

  it("reset() clears all records", () => {
    const router = new ABRouter({
      name: "test",
      control: { agentName: "v1" },
      variant: { agentName: "v2" },
      trafficSplit: 0.5,
      routing: "random",
    });

    router.recordRun("control", true, 1000, 100);
    router.reset();

    const metrics = router.getMetrics();
    expect(metrics.control.totalRuns).toBe(0);
    expect(metrics.variant.totalRuns).toBe(0);
  });
});
