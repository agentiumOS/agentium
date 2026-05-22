import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SkillManager } from "../skill-manager.js";
import type { Skill } from "../types.js";

const mockSkill: Skill = {
  name: "test-skill",
  description: "A test skill",
  version: "1.0.0",
  tools: [
    {
      name: "test_tool",
      description: "A test tool",
      parameters: z.object({ input: z.string() }),
      execute: async (args) => `Result: ${args.input}`,
    },
  ],
  instructions: "Use the test_tool for testing.",
};

describe("SkillManager", () => {
  it("loads pre-built Skill objects directly", async () => {
    const manager = new SkillManager([mockSkill]);
    const tools = await manager.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("test_tool");
  });

  it("returns combined instructions from skills", async () => {
    const manager = new SkillManager([mockSkill]);
    const instructions = await manager.getInstructions();
    expect(instructions).toContain("[Skill: test-skill]");
    expect(instructions).toContain("Use the test_tool for testing.");
  });

  it("returns all loaded skills", async () => {
    const manager = new SkillManager([mockSkill]);
    const skills = await manager.getSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("test-skill");
  });

  it("adds skills dynamically", async () => {
    const manager = new SkillManager([]);
    await manager.addSkill(mockSkill);
    const skills = await manager.getSkills();
    expect(skills).toHaveLength(1);
  });

  it("handles multiple skills", async () => {
    const skill2: Skill = {
      ...mockSkill,
      name: "skill-2",
      tools: [
        {
          name: "tool_2",
          description: "Second tool",
          parameters: z.object({}),
          execute: async () => "ok",
        },
      ],
    };

    const manager = new SkillManager([mockSkill, skill2]);
    const tools = await manager.getTools();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toEqual(["test_tool", "tool_2"]);
  });

  it("returns empty instructions when skills have none", async () => {
    const noInstructions: Skill = { ...mockSkill, instructions: undefined };
    const manager = new SkillManager([noInstructions]);
    const instructions = await manager.getInstructions();
    expect(instructions).toBe("");
  });
});
