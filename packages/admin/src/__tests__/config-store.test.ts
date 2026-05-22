import { InMemoryStorage } from "@agentium/core";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../config-store.js";
import type { AgentBlueprint, TeamBlueprint, WorkflowBlueprint } from "../types.js";

describe("ConfigStore", () => {
  let store: ConfigStore;

  beforeEach(async () => {
    store = new ConfigStore(new InMemoryStorage());
    await store.initialize();
  });

  // ── Agents ──────────────────────────────────────────────────────────

  describe("agents", () => {
    const bp: AgentBlueprint = {
      name: "bot",
      provider: "openai",
      model: "gpt-4o",
      instructions: "Be helpful",
      tools: ["search"],
    };

    it("saves and loads an agent", async () => {
      await store.saveAgent(bp);
      const loaded = await store.loadAgent("bot");
      expect(loaded).toEqual(bp);
    });

    it("returns null for missing agent", async () => {
      expect(await store.loadAgent("nope")).toBeNull();
    });

    it("lists agents", async () => {
      await store.saveAgent(bp);
      await store.saveAgent({ ...bp, name: "bot2" });
      const list = await store.listAgents();
      expect(list).toHaveLength(2);
      expect(list.map((a) => a.name).sort()).toEqual(["bot", "bot2"]);
    });

    it("deletes an agent", async () => {
      await store.saveAgent(bp);
      await store.deleteAgent("bot");
      expect(await store.loadAgent("bot")).toBeNull();
    });

    it("overwrites on save with same name", async () => {
      await store.saveAgent(bp);
      await store.saveAgent({ ...bp, model: "gpt-4o-mini" });
      const loaded = await store.loadAgent("bot");
      expect(loaded?.model).toBe("gpt-4o-mini");
    });
  });

  // ── Teams ───────────────────────────────────────────────────────────

  describe("teams", () => {
    const bp: TeamBlueprint = {
      name: "squad",
      mode: "coordinate",
      provider: "openai",
      model: "gpt-4o",
      members: ["bot1", "bot2"],
    };

    it("saves and loads a team", async () => {
      await store.saveTeam(bp);
      expect(await store.loadTeam("squad")).toEqual(bp);
    });

    it("returns null for missing team", async () => {
      expect(await store.loadTeam("nope")).toBeNull();
    });

    it("lists and deletes teams", async () => {
      await store.saveTeam(bp);
      expect(await store.listTeams()).toHaveLength(1);
      await store.deleteTeam("squad");
      expect(await store.listTeams()).toHaveLength(0);
    });
  });

  // ── Workflows ───────────────────────────────────────────────────────

  describe("workflows", () => {
    const bp: WorkflowBlueprint = {
      name: "pipe",
      description: "A pipeline",
    };

    it("saves and loads a workflow", async () => {
      await store.saveWorkflow(bp);
      expect(await store.loadWorkflow("pipe")).toEqual(bp);
    });

    it("returns null for missing workflow", async () => {
      expect(await store.loadWorkflow("nope")).toBeNull();
    });

    it("lists and deletes workflows", async () => {
      await store.saveWorkflow(bp);
      expect(await store.listWorkflows()).toHaveLength(1);
      await store.deleteWorkflow("pipe");
      expect(await store.listWorkflows()).toHaveLength(0);
    });
  });
});
