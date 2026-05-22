import { registry } from "@agentium/core";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { EntityFactory } from "../entity-factory.js";
import type { AgentBlueprint, TeamBlueprint } from "../types.js";

const mockTool = {
  name: "calculator",
  description: "Evaluate math",
  parameters: z.object({ expression: z.string() }),
  execute: async ({ expression }: { expression: string }) => `result: ${expression}`,
};

describe("EntityFactory", () => {
  let factory: EntityFactory;

  beforeEach(() => {
    registry.clear();
    factory = new EntityFactory({ calculator: mockTool as any });
  });

  describe("createAgent", () => {
    const blueprint: AgentBlueprint = {
      name: "test-bot",
      provider: "openai",
      model: "gpt-4o-mini",
      instructions: "Be helpful",
    };

    it("creates an agent and registers it", () => {
      factory.createAgent(blueprint);
      expect(registry.getAgent("test-bot")).toBeDefined();
      expect(registry.getAgent("test-bot")!.name).toBe("test-bot");
    });

    it("creates an agent with tools", () => {
      factory.createAgent({ ...blueprint, tools: ["calculator"] });
      expect(registry.getAgent("test-bot")).toBeDefined();
    });

    it("throws on unknown provider", () => {
      expect(() => factory.createAgent({ ...blueprint, provider: "fake" })).toThrow("Unknown model provider");
    });

    it("throws on unknown tool", () => {
      expect(() => factory.createAgent({ ...blueprint, tools: ["nonexistent"] })).toThrow(
        'Tool "nonexistent" not found',
      );
    });
  });

  describe("createTeam", () => {
    it("creates a team from existing agents", () => {
      factory.createAgent({ name: "a1", provider: "openai", model: "gpt-4o-mini" });
      factory.createAgent({ name: "a2", provider: "openai", model: "gpt-4o-mini" });

      const teamBp: TeamBlueprint = {
        name: "squad",
        mode: "coordinate",
        provider: "openai",
        model: "gpt-4o",
        members: ["a1", "a2"],
      };

      factory.createTeam(teamBp);
      expect(registry.getTeam("squad")).toBeDefined();
    });

    it("throws when a member agent is missing", () => {
      const teamBp: TeamBlueprint = {
        name: "squad",
        mode: "coordinate",
        provider: "openai",
        model: "gpt-4o",
        members: ["ghost"],
      };

      expect(() => factory.createTeam(teamBp)).toThrow('Agent "ghost" not found');
    });

    it("throws on unknown team mode", () => {
      factory.createAgent({ name: "a1", provider: "openai", model: "gpt-4o-mini" });

      expect(() =>
        factory.createTeam({
          name: "bad",
          mode: "unknown-mode",
          provider: "openai",
          model: "gpt-4o",
          members: ["a1"],
        }),
      ).toThrow('Unknown team mode "unknown-mode"');
    });
  });

  describe("destroy", () => {
    it("destroys an agent from registry", () => {
      factory.createAgent({ name: "doomed", provider: "openai", model: "gpt-4o-mini" });
      expect(registry.getAgent("doomed")).toBeDefined();

      expect(factory.destroyAgent("doomed")).toBe(true);
      expect(registry.getAgent("doomed")).toBeUndefined();
    });

    it("returns false for non-existent agent", () => {
      expect(factory.destroyAgent("nope")).toBe(false);
    });

    it("destroys a team from registry", () => {
      factory.createAgent({ name: "m1", provider: "openai", model: "gpt-4o-mini" });
      factory.createTeam({
        name: "team1",
        mode: "route",
        provider: "openai",
        model: "gpt-4o",
        members: ["m1"],
      });

      expect(factory.destroyTeam("team1")).toBe(true);
      expect(registry.getTeam("team1")).toBeUndefined();
    });
  });
});
