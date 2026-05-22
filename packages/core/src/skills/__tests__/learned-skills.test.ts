import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorage } from "../../storage/in-memory.js";
import { LearnedSkillStore } from "../learned-skills.js";

describe("LearnedSkillStore", () => {
  let storage: InMemoryStorage;
  let store: LearnedSkillStore;

  beforeEach(() => {
    storage = new InMemoryStorage();
    store = new LearnedSkillStore(storage);
  });

  it("saves a learned skill", async () => {
    const skill = await store.saveSkill({
      name: "deploy-flow",
      description: "Deploy a service",
      steps: [
        { toolName: "build", args: { target: "prod" } },
        { toolName: "deploy", args: { env: "production" } },
      ],
    });
    expect(skill.id).toBeDefined();
    expect(skill.name).toBe("deploy-flow");
    expect(skill.steps).toHaveLength(2);
    expect(skill.successCount).toBe(0);
    expect(skill.failCount).toBe(0);
  });

  it("retrieves a saved skill", async () => {
    const saved = await store.saveSkill({
      name: "test",
      description: "Test skill",
      steps: [],
    });
    const retrieved = await store.getSkill(saved.id);
    expect(retrieved?.name).toBe("test");
  });

  it("lists all skills", async () => {
    await store.saveSkill({ name: "A", description: "D", steps: [] });
    await store.saveSkill({ name: "B", description: "D", steps: [] });
    const list = await store.listSkills();
    expect(list).toHaveLength(2);
  });

  it("searches skills by name", async () => {
    await store.saveSkill({ name: "deploy-flow", description: "Deploy", steps: [] });
    await store.saveSkill({ name: "test-flow", description: "Test", steps: [] });
    const results = await store.searchSkills("deploy");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("deploy-flow");
  });

  it("records outcome (success)", async () => {
    const skill = await store.saveSkill({ name: "s", description: "d", steps: [] });
    await store.recordOutcome(skill.id, true);
    const updated = await store.getSkill(skill.id);
    expect(updated?.successCount).toBe(1);
    expect(updated?.failCount).toBe(0);
  });

  it("records outcome (failure)", async () => {
    const skill = await store.saveSkill({ name: "s", description: "d", steps: [] });
    await store.recordOutcome(skill.id, false);
    const updated = await store.getSkill(skill.id);
    expect(updated?.successCount).toBe(0);
    expect(updated?.failCount).toBe(1);
  });

  it("deletes a skill", async () => {
    const skill = await store.saveSkill({ name: "temp", description: "d", steps: [] });
    await store.deleteSkill(skill.id);
    const retrieved = await store.getSkill(skill.id);
    expect(retrieved).toBeNull();
  });

  it("returns tools", () => {
    const tools = store.getTools();
    expect(tools).toHaveLength(2);
    const names = tools.map((t) => t.name);
    expect(names).toContain("save_skill");
    expect(names).toContain("search_skills");
  });
});
