import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorage } from "../../storage/in-memory.js";
import { MemoryManager } from "../memory-manager.js";

describe("MemoryManager", () => {
  let storage: InMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
  });

  it("creates with minimal config (sessions + summaries only)", () => {
    const mm = new MemoryManager({ storage });
    expect(mm.sessionManager).toBeDefined();
    expect(mm.getSummaries()).not.toBeNull();
    expect(mm.getUserFacts()).toBeNull();
    expect(mm.getUserProfile()).toBeNull();
    expect(mm.getEntityMemory()).toBeNull();
    expect(mm.getDecisionLog()).toBeNull();
    expect(mm.getLearnedKnowledge()).toBeNull();
  });

  it("enables user facts when configured", () => {
    const mm = new MemoryManager({ storage, userFacts: true });
    expect(mm.getUserFacts()).not.toBeNull();
  });

  it("enables user profile when configured", () => {
    const mm = new MemoryManager({ storage, userProfile: true });
    expect(mm.getUserProfile()).not.toBeNull();
  });

  it("enables entities when configured", () => {
    const mm = new MemoryManager({ storage, entities: true });
    expect(mm.getEntityMemory()).not.toBeNull();
  });

  it("enables decisions when configured", () => {
    const mm = new MemoryManager({ storage, decisions: true });
    expect(mm.getDecisionLog()).not.toBeNull();
  });

  it("disables summaries when set to false", () => {
    const mm = new MemoryManager({ storage, summaries: false });
    expect(mm.getSummaries()).toBeNull();
  });

  it("manages sessions", async () => {
    const mm = new MemoryManager({ storage });
    const session = await mm.getOrCreateSession("s1", "u1");
    expect(session.sessionId).toBe("s1");
    expect(session.userId).toBe("u1");
    expect(session.messages).toEqual([]);
  });

  it("appends messages to session", async () => {
    const mm = new MemoryManager({ storage });
    await mm.getOrCreateSession("s1");
    await mm.appendMessages("s1", [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ]);
    const history = await mm.getHistory("s1");
    expect(history).toHaveLength(2);
  });

  it("builds empty context when nothing is enabled", async () => {
    const mm = new MemoryManager({ storage, summaries: false });
    const ctx = await mm.buildContext("s1", "u1");
    expect(ctx).toBe("");
  });

  it("builds context with user facts", async () => {
    const mm = new MemoryManager({ storage, userFacts: true });
    const uf = mm.getUserFacts()!;
    await uf.addFacts("u1", [{ fact: "Likes TypeScript" }]);
    const ctx = await mm.buildContext("s1", "u1");
    expect(ctx).toContain("Likes TypeScript");
  });

  it("builds context with user profile", async () => {
    const mm = new MemoryManager({ storage, userProfile: true });
    const up = mm.getUserProfile()!;
    await up.updateProfile("u1", { name: "Akash" });
    const ctx = await mm.buildContext("s1", "u1");
    expect(ctx).toContain("Name: Akash");
  });

  it("collects tools from enabled stores", () => {
    const mm = new MemoryManager({ storage, entities: true, decisions: true });
    const tools = mm.getTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("search_entities");
    expect(names).toContain("log_decision");
  });

  it("returns no tools when nothing is enabled", () => {
    const mm = new MemoryManager({ storage });
    expect(mm.getTools()).toEqual([]);
  });

  it("exposes curator", () => {
    const mm = new MemoryManager({ storage, userFacts: true });
    expect(mm.curator).toBeDefined();
  });

  it("respects maxMessages config", () => {
    const mm = new MemoryManager({ storage, maxMessages: 10 });
    expect(mm.getMaxMessages()).toBe(10);
  });

  it("defaults maxMessages to 50", () => {
    const mm = new MemoryManager({ storage });
    expect(mm.getMaxMessages()).toBe(50);
  });
});
