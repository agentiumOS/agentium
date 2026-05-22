import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorage } from "../../storage/in-memory.js";
import { Curator } from "../curator.js";
import { UserFacts } from "../stores/user-facts.js";

describe("Curator", () => {
  let storage: InMemoryStorage;
  let userFacts: UserFacts;
  let curator: Curator;

  beforeEach(() => {
    storage = new InMemoryStorage();
    userFacts = new UserFacts(storage);
    curator = new Curator(storage, { userFacts });
  });

  it("deduplicates user facts", async () => {
    await userFacts.addFacts("u1", [{ fact: "Lives in Mumbai" }]);
    await userFacts.addFacts("u1", [{ fact: "Lives in mumbai" }]);
    await userFacts.addFacts("u1", [{ fact: "Loves AI" }]);

    const before = await userFacts.getFacts("u1");
    expect(before).toHaveLength(2);

    const removed = await curator.deduplicate({ userId: "u1" });
    expect(removed).toBe(0);
  });

  it("prunes old facts", async () => {
    await userFacts.addFacts("u1", [{ fact: "Old fact" }]);

    const facts = await userFacts.getFacts("u1");
    (facts[0] as any).createdAt = new Date("2020-01-01");
    await storage.set("memory:user-facts", "u1", facts);

    const pruned = await curator.prune({ maxAgeDays: 30, userId: "u1" });
    expect(pruned).toBe(1);
    expect(await userFacts.getFacts("u1")).toHaveLength(0);
  });

  it("clears all data for a user", async () => {
    await userFacts.addFacts("u1", [{ fact: "Fact" }]);
    await curator.clearAll({ userId: "u1" });
    expect(await userFacts.getFacts("u1")).toHaveLength(0);
  });
});
