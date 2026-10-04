import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../models/types.js";
import { InMemoryStorage } from "../../storage/in-memory.js";
import { IncrementalSessionManager } from "../incremental-session-manager.js";

describe("IncrementalSessionManager", () => {
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
