import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "../../storage/in-memory.js";
import { SessionManager } from "../session-manager.js";

describe("SessionManager", () => {
  it("creates a new session on first access", async () => {
    const mgr = new SessionManager(new InMemoryStorage());
    const session = await mgr.getOrCreate("s1", "user1");

    expect(session.sessionId).toBe("s1");
    expect(session.userId).toBe("user1");
    expect(session.messages).toEqual([]);
  });

  it("returns existing session on subsequent access", async () => {
    const mgr = new SessionManager(new InMemoryStorage());
    const _s1 = await mgr.getOrCreate("s1");
    await mgr.appendMessages("s1", [{ role: "user", content: "hi" }]);
    const s2 = await mgr.getOrCreate("s1");

    expect(s2.messages).toHaveLength(1);
  });

  it("appendMessages stores messages", async () => {
    const mgr = new SessionManager(new InMemoryStorage());
    await mgr.getOrCreate("s1");
    await mgr.appendMessages("s1", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);

    const history = await mgr.getHistory("s1");
    expect(history).toHaveLength(2);
    expect(history[0].content).toBe("hello");
  });

  it("overflow returns trimmed messages when maxMessages exceeded", async () => {
    const mgr = new SessionManager(new InMemoryStorage(), { maxMessages: 2 });
    await mgr.getOrCreate("s1");

    await mgr.appendMessages("s1", [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);

    const { overflow } = await mgr.appendMessages("s1", [
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
    ]);

    expect(overflow).toHaveLength(2);
    expect(overflow[0].content).toBe("a");
    expect(overflow[1].content).toBe("b");

    const history = await mgr.getHistory("s1");
    expect(history).toHaveLength(2);
    expect(history[0].content).toBe("c");
  });

  it("getHistory with limit returns most recent messages", async () => {
    const mgr = new SessionManager(new InMemoryStorage());
    await mgr.getOrCreate("s1");
    await mgr.appendMessages("s1", [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ]);

    const recent = await mgr.getHistory("s1", 2);
    expect(recent).toHaveLength(2);
    expect(recent[0].content).toBe("b");
  });

  it("updateState and getState round-trip", async () => {
    const mgr = new SessionManager(new InMemoryStorage());
    await mgr.getOrCreate("s1");
    await mgr.updateState("s1", { count: 5 });

    const state = await mgr.getState("s1");
    expect(state.count).toBe(5);
  });

  it("deleteSession removes the session", async () => {
    const mgr = new SessionManager(new InMemoryStorage());
    await mgr.getOrCreate("s1");
    await mgr.appendMessages("s1", [{ role: "user", content: "hi" }]);
    await mgr.deleteSession("s1");

    const history = await mgr.getHistory("s1");
    expect(history).toEqual([]);
  });
});
