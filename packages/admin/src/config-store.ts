import type { StorageDriver } from "@agentium/core";
import type { AgentBlueprint, TeamBlueprint, WorkflowBlueprint } from "./types.js";

const NS_AGENTS = "agentium:admin:agents";
const NS_TEAMS = "agentium:admin:teams";
const NS_WORKFLOWS = "agentium:admin:workflows";

/**
 * Persists serializable blueprints to a StorageDriver.
 * All values are plain JSON — no class instances.
 */
export class ConfigStore {
  constructor(private readonly storage: StorageDriver) {}

  async initialize(): Promise<void> {
    await this.storage.initialize?.();
  }

  // ── Agents ────────────────────────────────────────────────────────────

  async saveAgent(blueprint: AgentBlueprint): Promise<void> {
    await this.storage.set(NS_AGENTS, blueprint.name, blueprint);
  }

  async loadAgent(name: string): Promise<AgentBlueprint | null> {
    return this.storage.get<AgentBlueprint>(NS_AGENTS, name);
  }

  async deleteAgent(name: string): Promise<void> {
    await this.storage.delete(NS_AGENTS, name);
  }

  async listAgents(): Promise<AgentBlueprint[]> {
    const entries = await this.storage.list<AgentBlueprint>(NS_AGENTS);
    return entries.map((e) => e.value);
  }

  // ── Teams ─────────────────────────────────────────────────────────────

  async saveTeam(blueprint: TeamBlueprint): Promise<void> {
    await this.storage.set(NS_TEAMS, blueprint.name, blueprint);
  }

  async loadTeam(name: string): Promise<TeamBlueprint | null> {
    return this.storage.get<TeamBlueprint>(NS_TEAMS, name);
  }

  async deleteTeam(name: string): Promise<void> {
    await this.storage.delete(NS_TEAMS, name);
  }

  async listTeams(): Promise<TeamBlueprint[]> {
    const entries = await this.storage.list<TeamBlueprint>(NS_TEAMS);
    return entries.map((e) => e.value);
  }

  // ── Workflows ─────────────────────────────────────────────────────────

  async saveWorkflow(blueprint: WorkflowBlueprint): Promise<void> {
    await this.storage.set(NS_WORKFLOWS, blueprint.name, blueprint);
  }

  async loadWorkflow(name: string): Promise<WorkflowBlueprint | null> {
    return this.storage.get<WorkflowBlueprint>(NS_WORKFLOWS, name);
  }

  async deleteWorkflow(name: string): Promise<void> {
    await this.storage.delete(NS_WORKFLOWS, name);
  }

  async listWorkflows(): Promise<WorkflowBlueprint[]> {
    const entries = await this.storage.list<WorkflowBlueprint>(NS_WORKFLOWS);
    return entries.map((e) => e.value);
  }
}
