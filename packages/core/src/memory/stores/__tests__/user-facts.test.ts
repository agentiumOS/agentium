import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorage } from "../../../storage/in-memory.js";
import { UserFacts } from "../user-facts.js";

describe("UserFacts", () => {
  let storage: InMemoryStorage;
  let userFacts: UserFacts;

  beforeEach(() => {
    storage = new InMemoryStorage();
    userFacts = new UserFacts(storage);
  });

  it("returns empty array when no facts exist", async () => {
    const facts = await userFacts.getFacts("user1");
    expect(facts).toEqual([]);
  });

  it("adds manual facts", async () => {
    await userFacts.addFacts("user1", [{ fact: "Lives in Mumbai" }], "manual");
    const facts = await userFacts.getFacts("user1");
    expect(facts).toHaveLength(1);
    expect(facts[0].fact).toBe("Lives in Mumbai");
    expect(facts[0].source).toBe("manual");
    expect(facts[0].topics).toEqual([]);
  });

  it("adds facts with topics", async () => {
    await userFacts.addFacts("user1", [{ fact: "Prefers dark mode", topics: ["preference", "ui"] }]);
    const facts = await userFacts.getFacts("user1");
    expect(facts[0].topics).toEqual(["preference", "ui"]);
  });

  it("deduplicates case-insensitively", async () => {
    await userFacts.addFacts("user1", [{ fact: "Lives in Mumbai" }]);
    await userFacts.addFacts("user1", [{ fact: "lives in mumbai" }]);
    const facts = await userFacts.getFacts("user1");
    expect(facts).toHaveLength(1);
  });

  it("removes a fact by ID", async () => {
    await userFacts.addFacts("user1", [{ fact: "Fact A" }, { fact: "Fact B" }]);
    const facts = await userFacts.getFacts("user1");
    await userFacts.removeFact("user1", facts[0].id);
    const remaining = await userFacts.getFacts("user1");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].fact).toBe("Fact B");
  });

  it("clears all facts for a user", async () => {
    await userFacts.addFacts("user1", [{ fact: "Fact A" }]);
    await userFacts.clear("user1");
    const facts = await userFacts.getFacts("user1");
    expect(facts).toEqual([]);
  });

  it("respects maxFacts limit", async () => {
    const smallStore = new UserFacts(storage, { maxFacts: 3 });
    for (let i = 0; i < 5; i++) {
      await smallStore.addFacts("user1", [{ fact: `Fact ${i}` }]);
    }
    const facts = await smallStore.getFacts("user1");
    expect(facts).toHaveLength(3);
    expect(facts[0].fact).toBe("Fact 2");
  });

  it("generates context string", async () => {
    await userFacts.addFacts("user1", [{ fact: "Loves coffee" }, { fact: "Works at Acme" }]);
    const ctx = await userFacts.getContextString("user1");
    expect(ctx).toContain("What you know about this user:");
    expect(ctx).toContain("- Loves coffee");
    expect(ctx).toContain("- Works at Acme");
  });

  it("returns empty context string when no facts", async () => {
    const ctx = await userFacts.getContextString("user1");
    expect(ctx).toBe("");
  });

  it("creates a tool definition", () => {
    const tool = userFacts.asTool();
    expect(tool.name).toBe("recall_user_facts");
    expect(tool.execute).toBeDefined();
  });
});
