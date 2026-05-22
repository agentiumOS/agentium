import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "../../storage/in-memory.js";
import { IncrementalSessionManager } from "../incremental-session-manager.js";

describe("IncrementalSessionManager", () => {
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
    const snap = await storage.get<any[]>("sessions:snapshot", "s1");
    expect(snap?.length).toBe(3);
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
    const snap = await storage.get<any[]>("sessions:snapshot", "s1");
    expect(snap?.length).toBe(2);
  });
});
