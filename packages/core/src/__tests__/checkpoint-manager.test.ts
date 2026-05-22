import { beforeEach, describe, expect, it } from "vitest";
import { CheckpointManager } from "../checkpoint/checkpoint-manager.js";
import { InMemoryStorage } from "../storage/in-memory.js";

describe("CheckpointManager", () => {
  let manager: CheckpointManager;

  beforeEach(() => {
    manager = new CheckpointManager(new InMemoryStorage());
  });

  it("saves and loads a checkpoint", async () => {
    const id = await manager.save({
      runId: "run-1",
      roundtrip: 0,
      messages: [{ role: "user", content: "hello" }],
      tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      sessionState: { key: "value" },
    });

    const loaded = await manager.load(id);
    expect(loaded).not.toBeNull();
    expect(loaded!.runId).toBe("run-1");
    expect(loaded!.roundtrip).toBe(0);
    expect(loaded!.messages).toHaveLength(1);
    expect(loaded!.sessionState).toEqual({ key: "value" });
  });

  it("lists checkpoints for a run in order", async () => {
    await manager.save({
      runId: "run-1",
      roundtrip: 0,
      messages: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      sessionState: {},
    });
    await manager.save({
      runId: "run-1",
      roundtrip: 1,
      messages: [{ role: "user", content: "msg" }],
      tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      sessionState: {},
    });
    await manager.save({
      runId: "run-2",
      roundtrip: 0,
      messages: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      sessionState: {},
    });

    const list = await manager.list("run-1");
    expect(list).toHaveLength(2);
    expect(list[0].roundtrip).toBe(0);
    expect(list[1].roundtrip).toBe(1);
  });

  it("rollback deletes later checkpoints", async () => {
    const id0 = await manager.save({
      runId: "run-1",
      roundtrip: 0,
      messages: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      sessionState: {},
    });
    await manager.save({
      runId: "run-1",
      roundtrip: 1,
      messages: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      sessionState: {},
    });
    await manager.save({
      runId: "run-1",
      roundtrip: 2,
      messages: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      sessionState: {},
    });

    const checkpoint = await manager.rollback(id0);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.roundtrip).toBe(0);

    const remaining = await manager.list("run-1");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].roundtrip).toBe(0);
  });

  it("returns null when loading non-existent checkpoint", async () => {
    const result = await manager.load("non-existent");
    expect(result).toBeNull();
  });

  it("prune removes old checkpoints", async () => {
    await manager.save({
      runId: "run-1",
      roundtrip: 0,
      messages: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      sessionState: {},
    });

    // Pruning with 1 hour window should not delete recently created checkpoints
    const pruned = await manager.prune(3600_000);
    expect(pruned).toBe(0);
  });
});
