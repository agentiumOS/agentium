import { describe, expect, it, vi } from "vitest";
import { InMemoryStorage } from "../../storage/in-memory.js";
import { UserMemory } from "../user-memory.js";

describe("UserMemory", () => {
  it("starts with no facts", async () => {
    const mem = new UserMemory({ storage: new InMemoryStorage() });
    const facts = await mem.getFacts("user1");
    expect(facts).toEqual([]);
  });

  it("addFacts stores facts", async () => {
    const mem = new UserMemory({ storage: new InMemoryStorage() });
    await mem.addFacts("user1", ["Lives in Mumbai", "Loves TypeScript"]);

    const facts = await mem.getFacts("user1");
    expect(facts).toHaveLength(2);
    expect(facts[0].fact).toBe("Lives in Mumbai");
    expect(facts[0].source).toBe("manual");
  });

  it("deduplicates facts (case-insensitive)", async () => {
    const mem = new UserMemory({ storage: new InMemoryStorage() });
    await mem.addFacts("user1", ["Lives in Mumbai"]);
    await mem.addFacts("user1", ["lives in mumbai", "New fact"]);

    const facts = await mem.getFacts("user1");
    expect(facts).toHaveLength(2);
  });

  it("respects maxFacts limit", async () => {
    const mem = new UserMemory({ storage: new InMemoryStorage(), maxFacts: 3 });
    await mem.addFacts("user1", ["a", "b", "c", "d", "e"]);

    const facts = await mem.getFacts("user1");
    expect(facts).toHaveLength(3);
    expect(facts[0].fact).toBe("c");
  });

  it("getContextString returns formatted string", async () => {
    const mem = new UserMemory({ storage: new InMemoryStorage() });
    await mem.addFacts("user1", ["Prefers concise answers"]);

    const ctx = await mem.getContextString("user1");
    expect(ctx).toContain("Prefers concise answers");
    expect(ctx).toContain("What you know about this user");
  });

  it("getContextString returns empty when disabled", async () => {
    const mem = new UserMemory({ storage: new InMemoryStorage(), enabled: false });
    await mem.addFacts("user1", ["fact"]);

    const ctx = await mem.getContextString("user1");
    expect(ctx).toBe("");
  });

  it("removeFact removes a specific fact", async () => {
    const mem = new UserMemory({ storage: new InMemoryStorage() });
    await mem.addFacts("user1", ["A", "B"]);
    const facts = await mem.getFacts("user1");

    await mem.removeFact("user1", facts[0].id);
    const remaining = await mem.getFacts("user1");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].fact).toBe("B");
  });

  it("clear removes all facts for a user", async () => {
    const mem = new UserMemory({ storage: new InMemoryStorage() });
    await mem.addFacts("user1", ["A", "B"]);
    await mem.clear("user1");

    const facts = await mem.getFacts("user1");
    expect(facts).toEqual([]);
  });

  it("extractAndStore calls model and saves facts", async () => {
    const mockModel = {
      providerId: "test",
      modelId: "test",
      generate: vi.fn().mockResolvedValue({
        message: { role: "assistant", content: '["Likes coffee", "Works at Acme"]' },
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: "stop",
      }),
      stream: vi.fn(),
    };

    const mem = new UserMemory({ storage: new InMemoryStorage() });
    await mem.extractAndStore(
      "user1",
      [
        { role: "user", content: "I love coffee and work at Acme." },
        { role: "assistant", content: "Great!" },
      ],
      mockModel,
    );

    const facts = await mem.getFacts("user1");
    expect(facts).toHaveLength(2);
    expect(facts[0].fact).toBe("Likes coffee");
    expect(facts[0].source).toBe("auto");
  });
});
