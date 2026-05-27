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

  describe("invalidation handling", () => {
    it("marks auto-superseded facts with reason 'superseded'", async () => {
      await userFacts.addFacts("user1", [{ fact: "User works at Shipment.", subject: "employer" }]);
      await userFacts.addFacts("user1", [{ fact: "User works at Google.", subject: "employer" }]);
      const all = await userFacts.getFacts("user1");
      const old = all.find((f) => f.fact === "User works at Shipment.");
      expect(old?.invalidatedAt).toBeDefined();
      expect(old?.invalidationReason).toBe("superseded");
    });

    it("marks user-forgotten facts with reason 'forgotten'", async () => {
      await userFacts.addFacts("user1", [{ fact: "User likes coffee." }]);
      await userFacts.forgetByText("user1", ["user likes coffee."]);
      const all = await userFacts.getFacts("user1");
      expect(all[0].invalidatedAt).toBeDefined();
      expect(all[0].invalidationReason).toBe("forgotten");
    });

    it("does NOT surface superseded facts in the IMPORTANT-forget block", async () => {
      await userFacts.addFacts("user1", [{ fact: "User works at Shipment.", subject: "employer" }]);
      await userFacts.addFacts("user1", [{ fact: "User works at Google.", subject: "employer" }]);
      const ctx = await userFacts.getContextString("user1");
      expect(ctx).toContain("User works at Google.");
      expect(ctx).not.toContain("User works at Shipment.");
      expect(ctx).not.toMatch(/asked you to forget/i);
    });

    it("DOES surface user-forgotten facts in the IMPORTANT-forget block", async () => {
      await userFacts.addFacts("user1", [{ fact: "User's birthday is April 11." }]);
      await userFacts.forgetByText("user1", ["user's birthday is april 11."]);
      const ctx = await userFacts.getContextString("user1");
      expect(ctx).toMatch(/asked you to forget/i);
      expect(ctx).toContain("User's birthday is April 11.");
    });

    it("re-adding a previously-forgotten fact reactivates it (Batch B #14)", async () => {
      await userFacts.addFacts("user1", [{ fact: "User loves coffee.", subject: "interest:coffee" }]);
      await userFacts.forgetByText("user1", ["user loves coffee."]);
      await userFacts.addFacts("user1", [{ fact: "User loves coffee.", subject: "interest:coffee" }]);
      const active = await userFacts.getActiveFacts("user1");
      expect(active.map((f) => f.fact)).toContain("User loves coffee.");
    });

    it("dedup ignores trailing punctuation and inner whitespace (Batch B #14)", async () => {
      await userFacts.addFacts("user1", [{ fact: "User loves coffee" }]);
      await userFacts.addFacts("user1", [{ fact: "user  loves coffee." }]);
      const facts = await userFacts.getFacts("user1");
      expect(facts).toHaveLength(1);
    });

    it("supersedes does NOT also trigger auto-subject invalidation (Batch B #11)", async () => {
      await userFacts.addFacts("user1", [
        { fact: "User works as engineer.", subject: "role" },
        { fact: "User works at Acme.", subject: "company" },
      ]);
      // Wrong-target supersedes: claims to update role, but provides company subject.
      await userFacts.addFacts("user1", [
        { fact: "User works at Google.", subject: "company", supersedes: "User works as engineer." },
      ]);
      const active = await userFacts.getActiveFacts("user1");
      const factTexts = active.map((f) => f.fact);
      // Only the explicit target was invalidated; the unrelated company fact stays.
      expect(factTexts).toContain("User works at Acme.");
      expect(factTexts).toContain("User works at Google.");
      expect(factTexts).not.toContain("User works as engineer.");
    });

    it("maxFacts pruning honours the hard cap even with invalidated facts (Batch B #13)", async () => {
      const small = new UserFacts(storage, { maxFacts: 5 });
      // 10 invalidated tombstones
      for (let i = 0; i < 10; i++) {
        await small.addFacts("u", [{ fact: `User old fact ${i}.`, subject: `s${i}` }]);
      }
      for (let i = 0; i < 10; i++) {
        await small.forgetByText("u", [`user old fact ${i}.`]);
      }
      // Now 10 new active facts
      for (let i = 0; i < 10; i++) {
        await small.addFacts("u", [{ fact: `User new fact ${i}.`, subject: `n${i}` }]);
      }
      const facts = await small.getFacts("u");
      // Hard cap is 5: ~10% slots for tombstones (0 here, since floor(5*0.1)=0) + active fill.
      expect(facts.length).toBeLessThanOrEqual(5);
    });

    it("legacy facts without invalidationReason fall back to subject heuristic", async () => {
      // Simulate legacy data: invalidate by writing directly to storage without setting reason.
      await userFacts.addFacts("user1", [{ fact: "User works at Shipment.", subject: "employer" }]);
      const facts = await userFacts.getFacts("user1");
      facts[0].invalidatedAt = new Date();
      // intentionally do NOT set invalidationReason
      await (userFacts as any).storage.set("memory:user-facts", "user1", facts);
      // Add a new active fact on the same subject → legacy invalidated one should be treated as superseded
      await userFacts.addFacts("user1", [{ fact: "User works at Google.", subject: "employer" }]);
      const ctx = await userFacts.getContextString("user1");
      expect(ctx).not.toContain("User works at Shipment.");
    });
  });
});
