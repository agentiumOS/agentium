import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorage } from "../../../storage/in-memory.js";
import { EntityMemory } from "../entity-memory.js";

describe("EntityMemory", () => {
  let storage: InMemoryStorage;
  let entities: EntityMemory;

  beforeEach(() => {
    storage = new InMemoryStorage();
    entities = new EntityMemory(storage);
  });

  it("returns null for unknown entity", async () => {
    const e = await entities.getEntity("unknown");
    expect(e).toBeNull();
  });

  it("creates a new entity", async () => {
    const entity = await entities.upsertEntity({
      name: "Acme Corp",
      entityType: "company",
      description: "A logistics company",
    });
    expect(entity.name).toBe("Acme Corp");
    expect(entity.entityType).toBe("company");
    expect(entity.entityId).toBe("acme_corp");
  });

  it("updates existing entity properties", async () => {
    await entities.upsertEntity({ name: "Acme Corp", entityType: "company" });
    const updated = await entities.upsertEntity({
      name: "Acme Corp",
      entityType: "company",
      properties: { revenue: "10M" },
    });
    expect(updated.properties).toEqual({ revenue: "10M" });
  });

  it("adds facts to entity", async () => {
    await entities.upsertEntity({ name: "Acme", entityType: "company" });
    await entities.addFact("acme", "Founded in 2020");
    const entity = await entities.getEntity("acme");
    expect(entity?.facts).toHaveLength(1);
    expect(entity?.facts[0].fact).toBe("Founded in 2020");
  });

  it("adds events to entity", async () => {
    await entities.upsertEntity({ name: "Acme", entityType: "company" });
    await entities.addEvent("acme", "IPO announced", "2025-01-15");
    const entity = await entities.getEntity("acme");
    expect(entity?.events).toHaveLength(1);
    expect(entity?.events[0].event).toBe("IPO announced");
  });

  it("lists all entities", async () => {
    await entities.upsertEntity({ name: "Company A", entityType: "company" });
    await entities.upsertEntity({ name: "Person B", entityType: "person" });
    const list = await entities.listEntities();
    expect(list).toHaveLength(2);
  });

  it("deletes an entity", async () => {
    await entities.upsertEntity({ name: "Temp", entityType: "other" });
    await entities.deleteEntity("temp");
    const e = await entities.getEntity("temp");
    expect(e).toBeNull();
  });

  it("generates context string", async () => {
    await entities.upsertEntity({ name: "Acme Corp", entityType: "company", description: "Logistics" });
    await entities.addFact("acme_corp", "Has 500 employees");
    const ctx = await entities.getContextString();
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

  it("supports namespace scoping", async () => {
    const ns1 = new EntityMemory(storage, { namespace: "team_a" });
    const ns2 = new EntityMemory(storage, { namespace: "team_b" });

    await ns1.upsertEntity({ name: "Project X", entityType: "project" });
    await ns2.upsertEntity({ name: "Project Y", entityType: "project" });

    expect(await ns1.listEntities()).toHaveLength(1);
    expect(await ns2.listEntities()).toHaveLength(1);
    expect((await ns1.listEntities())[0].name).toBe("Project X");
  });
});
