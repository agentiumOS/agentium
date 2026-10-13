import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../models/types.js";
import { InMemoryStorage } from "../../storage/in-memory.js";
import { IncrementalSessionManager } from "../incremental-session-manager.js";

describe("IncrementalSessionManager", () => {
  class FaultStorage extends InMemoryStorage {
    writesUntilFailure: number | undefined;
    override async set<T>(namespace: string, key: string, value: T) {
      if (this.writesUntilFailure !== undefined && this.writesUntilFailure-- === 0) throw new Error("write failed");
      return super.set(namespace, key, JSON.parse(JSON.stringify(value)));
    }
  }

  it.each([0, 1, 2, 3])("recovers a multi-message batch after write %s fails", async (failure) => {
    const storage = new FaultStorage();
    const manager = new IncrementalSessionManager(storage, { snapshotFrequency: 100 });
    await manager.getOrCreate("s");
    storage.writesUntilFailure = failure;
    await expect(
      manager.appendMessages(
        "s",
        ["A", "B", "C"].map((content) => ({ role: "user", content })),
      ),
    ).rejects.toThrow("write failed");
    storage.writesUntilFailure = undefined;
    const recovered = new IncrementalSessionManager(storage, { snapshotFrequency: 100 });
    await recovered.appendMessage("s", { role: "user", content: "next" });
    expect((await recovered.getHistory("s")).map((message) => message.content)).toEqual([
      ...["A", "B", "C"].slice(0, failure),
      "next",
    ]);
    expect((await recovered.getOrCreate("s")).createdAt).toBeInstanceOf(Date);
  });

  it("recovers missing metadata and snapshots orphan logs", async () => {
    const storage = new FaultStorage();
    await storage.set("sessions:msg", "s:0000000004", { role: "user", content: "orphan" });
    const manager = new IncrementalSessionManager(storage);
    await manager.snapshotNow("s");
    expect(await storage.get("sessions:snapshot", "s")).toMatchObject({ nextSeq: 5 });
    await manager.appendMessage("s", { role: "user", content: "next" });
    expect((await manager.getHistory("s")).map((message) => message.content)).toEqual(["orphan", "next"]);
  });

  it("counts only loose entries above the snapshot watermark", async () => {
    const storage = new FaultStorage();
    await storage.set("sessions:snapshot", "s", { messages: [{ role: "user", content: "old" }], nextSeq: 3 });
    await storage.set("sessions:msg", "s:0000000001", { role: "user", content: "leftover" });
    await storage.set("sessions:msg", "s:0000000003", { role: "user", content: "new" });
    const manager = new IncrementalSessionManager(storage, { snapshotFrequency: 2 });
    await manager.appendMessage("s", { role: "user", content: "next" });
    expect(await storage.get("sessions:snapshot", "s")).toMatchObject({ nextSeq: 5 });
    expect((await manager.getHistory("s")).map((message) => message.content)).toEqual(["old", "new", "next"]);
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid watermark %s without overwriting history",
    async (nextSeq) => {
      const storage = new FaultStorage();
      await storage.set("sessions:snapshot", "s", { messages: [], nextSeq });
      await expect(
        new IncrementalSessionManager(storage).appendMessage("s", { role: "user", content: "next" }),
      ).rejects.toThrow(/sequence/);
      expect(await storage.list("sessions:msg", "s:")).toEqual([]);
    },
  );

  it("rejects exhausted loose sequence without overwriting history", async () => {
    const storage = new FaultStorage();
    await storage.set("sessions:msg", `s:${Number.MAX_SAFE_INTEGER}`, { role: "user", content: "old" });
    await expect(
      new IncrementalSessionManager(storage).appendMessage("s", { role: "user", content: "next" }),
    ).rejects.toThrow(/sequence/);
  });

  it.each(["missing", "behind"] as const)("recovers metadata %s the committed snapshot", async (metadata) => {
    const storage = new FaultStorage();
    await storage.set("sessions:snapshot", "s", { messages: [{ role: "user", content: "old" }], nextSeq: 5 });
    if (metadata === "behind")
      await storage.set("sessions:meta", "s", {
        sessionId: "s",
        state: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        nextSeq: 1,
        appendsSinceSnapshot: 9,
      });
    const manager = new IncrementalSessionManager(storage, { snapshotFrequency: 2 });
    await manager.appendMessage("s", { role: "user", content: "new" });
    expect(await storage.get("sessions:msg", "s:0000000005")).toMatchObject({ content: "new" });
    expect(await storage.get("sessions:meta", "s")).toMatchObject({ nextSeq: 6, appendsSinceSnapshot: 1 });
    expect((await manager.getHistory("s")).map((message) => message.content)).toEqual(["old", "new"]);
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects unsafe metadata sequence %s", async (nextSeq) => {
    const storage = new FaultStorage();
    await storage.set("sessions:meta", "s", {
      sessionId: "s",
      state: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      nextSeq,
      appendsSinceSnapshot: 0,
    });
    await expect(
      new IncrementalSessionManager(storage).appendMessage("s", { role: "user", content: "next" }),
    ).rejects.toThrow(/sequence/);
    expect(await storage.list("sessions:msg", "s:")).toEqual([]);
  });

  it("orders numeric sequences after the ten-digit padding is exceeded", async () => {
    const storage = new FaultStorage();
    await storage.set("sessions:msg", "s:9999999999", { role: "user", content: "older" });
    await storage.set("sessions:msg", "s:10000000000", { role: "user", content: "newer" });
    const manager = new IncrementalSessionManager(storage, { snapshotFrequency: 100 });
    await manager.appendMessage("s", { role: "user", content: "next" });
    expect((await manager.getHistory("s")).map((message) => message.content)).toEqual(["older", "newer", "next"]);
  });

  it("isolates reads, snapshots and deletion for session IDs sharing a colon prefix", async () => {
    const mgr = new IncrementalSessionManager(new InMemoryStorage(), { snapshotFrequency: 100 });
    await mgr.appendMessage("parent", { role: "user", content: "parent value" });
    await mgr.appendMessage("parent:child", { role: "user", content: "private child value" });
    expect((await mgr.getHistory("parent")).map((msg) => msg.content)).toEqual(["parent value"]);
    await mgr.snapshotNow("parent");
    expect((await mgr.getHistory("parent:child")).map((msg) => msg.content)).toEqual(["private child value"]);
    await mgr.deleteSession("parent");
    expect((await mgr.getHistory("parent:child")).map((msg) => msg.content)).toEqual(["private child value"]);
  });

  it("does not duplicate a committed snapshot when loose-log cleanup fails", async () => {
    class FailingCleanupStorage extends InMemoryStorage {
      fail = true;
      override async delete(namespace: string, key: string) {
        if (this.fail && namespace === "sessions:msg") throw new Error("cleanup unavailable");
        return super.delete(namespace, key);
      }
    }
    const storage = new FailingCleanupStorage();
    const mgr = new IncrementalSessionManager(storage, { snapshotFrequency: 2 });
    await mgr.appendMessage("s1", { role: "user", content: "one" });
    await expect(mgr.appendMessage("s1", { role: "assistant", content: "two" })).rejects.toThrow(/cleanup/);
    expect((await mgr.getHistory("s1")).map((msg) => msg.content)).toEqual(["one", "two"]);
    storage.fail = false;
    await mgr.appendMessage("s1", { role: "user", content: "three" });
    await mgr.snapshotNow("s1");
    expect((await mgr.getHistory("s1")).map((msg) => msg.content)).toEqual(["one", "two", "three"]);
  });

  it("reads legacy array snapshots while writing watermarked snapshots", async () => {
    const storage = new InMemoryStorage();
    await storage.set("sessions:snapshot", "legacy", [{ role: "user", content: "old" }]);
    const mgr = new IncrementalSessionManager(storage);
    await mgr.appendMessage("legacy", { role: "assistant", content: "new" });
    await mgr.snapshotNow("legacy");
    expect((await mgr.getHistory("legacy")).map((msg) => msg.content)).toEqual(["old", "new"]);
  });

  it("snapshots and reads an oversized tool turn without splitting its replay", async () => {
    const mgr = new IncrementalSessionManager(new InMemoryStorage(), { snapshotFrequency: 1, maxMessages: 2 });
    await mgr.appendMessages("s1", [
      { role: "user", content: "old" },
      { role: "assistant", content: "old answer" },
    ]);
    const turn: ChatMessage[] = [
      { role: "user", content: "new" },
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "call", name: "read", arguments: {} }],
        providerExtras: { opaque: "retained" },
      },
      { role: "tool", toolCallId: "call", content: "data" },
      { role: "assistant", content: "done" },
    ];
    for (const message of turn) await mgr.appendMessage("s1", message);
    expect(await mgr.getHistory("s1", 1)).toEqual(turn);
    expect((await mgr.getOrCreate("s1")).messages).toEqual(turn);
  });

  it("creates a session on first access", async () => {
    const storage = new InMemoryStorage();
    const mgr = new IncrementalSessionManager(storage);
    const session = await mgr.getOrCreate("s1", "alice");
    expect(session.sessionId).toBe("s1");
    expect(session.userId).toBe("alice");
    expect(session.messages).toEqual([]);
  });

  it("appends messages incrementally", async () => {
    const storage = new InMemoryStorage();
    const mgr = new IncrementalSessionManager(storage, { snapshotFrequency: 100 });
    await mgr.appendMessage("s1", { role: "user", content: "hi" });
    await mgr.appendMessage("s1", { role: "assistant", content: "hello" });
    await mgr.appendMessage("s1", { role: "user", content: "again" });

    const hist = await mgr.getHistory("s1");
    expect(hist.map((m) => m.content)).toEqual(["hi", "hello", "again"]);
  });

  it("each append writes exactly one new message entry (incremental, not full overwrite)", async () => {
    const storage = new InMemoryStorage();
    const mgr = new IncrementalSessionManager(storage, { snapshotFrequency: 100 });

    await mgr.appendMessage("s1", { role: "user", content: "m1" });
    await mgr.appendMessage("s1", { role: "user", content: "m2" });
    await mgr.appendMessage("s1", { role: "user", content: "m3" });

    const looseMessages = await storage.list("sessions:msg", "s1:");
    expect(looseMessages.length).toBe(3);
  });

  it("rolls up loose entries into a snapshot at the configured frequency", async () => {
    const storage = new InMemoryStorage();
    const mgr = new IncrementalSessionManager(storage, { snapshotFrequency: 3 });

    for (let i = 1; i <= 3; i++) {
      await mgr.appendMessage("s1", { role: "user", content: `msg-${i}` });
    }

    // After 3 appends with frequency=3, loose entries should be collapsed into the snapshot.
    const looseAfter = await storage.list("sessions:msg", "s1:");
    expect(looseAfter.length).toBe(0);
    const snap = await storage.get<{ messages: ChatMessage[] }>("sessions:snapshot", "s1");
    expect(snap?.messages.length).toBe(3);
  });

  it("getHistory combines snapshot + recent loose appends", async () => {
    const storage = new InMemoryStorage();
    const mgr = new IncrementalSessionManager(storage, { snapshotFrequency: 3 });

    for (let i = 1; i <= 5; i++) {
      await mgr.appendMessage("s1", { role: "user", content: `m${i}` });
    }
    // After 5 appends: snapshot triggered at 3, then 2 more loose entries.
    const hist = await mgr.getHistory("s1");
    expect(hist.map((m) => m.content)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });

  it("respects maxMessages on snapshot, dropping the oldest", async () => {
    const storage = new InMemoryStorage();
    const mgr = new IncrementalSessionManager(storage, { snapshotFrequency: 3, maxMessages: 2 });

    for (let i = 1; i <= 3; i++) {
      await mgr.appendMessage("s1", { role: "user", content: `m${i}` });
    }
    const hist = await mgr.getHistory("s1");
    expect(hist.map((m) => m.content)).toEqual(["m2", "m3"]);
  });

  it("updateState and getState persist state", async () => {
    const storage = new InMemoryStorage();
    const mgr = new IncrementalSessionManager(storage);
    await mgr.updateState("s1", { mood: "happy" });
    await mgr.updateState("s1", { topic: "weather" });
    expect(await mgr.getState("s1")).toEqual({ mood: "happy", topic: "weather" });
  });

  it("deleteSession removes meta + snapshot + loose entries", async () => {
    const storage = new InMemoryStorage();
    const mgr = new IncrementalSessionManager(storage, { snapshotFrequency: 100 });
    await mgr.appendMessage("s1", { role: "user", content: "m1" });
    await mgr.appendMessage("s1", { role: "user", content: "m2" });

    await mgr.deleteSession("s1");

    expect(await storage.get("sessions:meta", "s1")).toBeNull();
    expect(await storage.get("sessions:snapshot", "s1")).toBeNull();
    expect((await storage.list("sessions:msg", "s1:")).length).toBe(0);
  });

  it("snapshotNow forces a roll-up even before the frequency is hit", async () => {
    const storage = new InMemoryStorage();
    const mgr = new IncrementalSessionManager(storage, { snapshotFrequency: 100 });

    await mgr.appendMessage("s1", { role: "user", content: "m1" });
    await mgr.appendMessage("s1", { role: "user", content: "m2" });
    await mgr.snapshotNow("s1");

    expect((await storage.list("sessions:msg", "s1:")).length).toBe(0);
    const snap = await storage.get<{ messages: ChatMessage[] }>("sessions:snapshot", "s1");
    expect(snap?.messages.length).toBe(2);
  });
});
