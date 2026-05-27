import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorage } from "../../../storage/in-memory.js";
import { EntityMemory } from "../entity-memory.js";

describe("EntityMemory", () => {
  let storage: InMemoryStorage;
  let entities: EntityMemory;
  const userId = "user-1";

  beforeEach(() => {
    storage = new InMemoryStorage();
    entities = new EntityMemory(storage);
  });

  it("returns null for unknown entity", async () => {
    const e = await entities.getEntity(userId, "unknown");
    expect(e).toBeNull();
  });

  it("creates a new entity", async () => {
    const entity = await entities.upsertEntity(userId, {
      name: "Acme Corp",
      entityType: "company",
      description: "A logistics company",
    });
    expect(entity.name).toBe("Acme Corp");
    expect(entity.entityType).toBe("company");
    expect(entity.entityId).toBe("acme_corp");
  });

  it("updates existing entity properties", async () => {
    await entities.upsertEntity(userId, { name: "Acme Corp", entityType: "company" });
    const updated = await entities.upsertEntity(userId, {
      name: "Acme Corp",
      entityType: "company",
      properties: { revenue: "10M" },
    });
    expect(updated.properties).toEqual({ revenue: "10M" });
  });

  it("adds facts to entity", async () => {
    await entities.upsertEntity(userId, { name: "Acme", entityType: "company" });
    await entities.addFact(userId, "acme", "Founded in 2020");
    const entity = await entities.getEntity(userId, "acme");
    expect(entity?.facts).toHaveLength(1);
    expect(entity?.facts[0].fact).toBe("Founded in 2020");
  });

  it("adds events to entity", async () => {
    await entities.upsertEntity(userId, { name: "Acme", entityType: "company" });
    await entities.addEvent(userId, "acme", "IPO announced", "2025-01-15");
    const entity = await entities.getEntity(userId, "acme");
    expect(entity?.events).toHaveLength(1);
    expect(entity?.events[0].event).toBe("IPO announced");
  });

  it("lists all entities for a user", async () => {
    await entities.upsertEntity(userId, { name: "Company A", entityType: "company" });
    await entities.upsertEntity(userId, { name: "Person B", entityType: "person" });
    const list = await entities.listEntities(userId);
    expect(list).toHaveLength(2);
  });

  it("deletes an entity", async () => {
    await entities.upsertEntity(userId, { name: "Temp", entityType: "other" });
    await entities.deleteEntity(userId, "temp");
    const e = await entities.getEntity(userId, "temp");
    expect(e).toBeNull();
  });

  it("generates context string", async () => {
    await entities.upsertEntity(userId, { name: "Acme Corp", entityType: "company", description: "Logistics" });
    await entities.addFact(userId, "acme_corp", "Has 500 employees");
    const ctx = await entities.getContextString(userId);
    expect(ctx).toContain("Known entities:");
    expect(ctx).toContain("Acme Corp (company)");
    expect(ctx).toContain("Has 500 employees");
  });

  it("returns tools", () => {
    const tools = entities.getTools();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toContain("search_entities");
    expect(tools.map((t) => t.name)).toContain("create_entity");
  });

  it("entities for one user are NOT visible to another user", async () => {
    await entities.upsertEntity("alice", { name: "Acme", entityType: "company" });
    await entities.addFact("alice", "acme", "Alice works there");

    const bobView = await entities.listEntities("bob");
    expect(bobView).toHaveLength(0);

    const bobCtx = await entities.getContextString("bob");
    expect(bobCtx).toBe("");
  });

  it("supports namespace scoping orthogonal to userId", async () => {
    const ns1 = new EntityMemory(storage, { namespace: "team_a" });
    const ns2 = new EntityMemory(storage, { namespace: "team_b" });

    await ns1.upsertEntity(userId, { name: "Project X", entityType: "project" });
    await ns2.upsertEntity(userId, { name: "Project Y", entityType: "project" });

    expect(await ns1.listEntities(userId)).toHaveLength(1);
    expect(await ns2.listEntities(userId)).toHaveLength(1);
    expect((await ns1.listEntities(userId))[0].name).toBe("Project X");
  });
});
