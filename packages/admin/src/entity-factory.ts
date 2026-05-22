import type { ToolDef } from "@agentium/core";
import { Agent, modelRegistry, registry, Team, TeamMode } from "@agentium/core";
import type { AgentBlueprint, TeamBlueprint } from "./types.js";

/**
 * Resolves serializable blueprints into live Agent/Team instances
 * that auto-register into the global registry.
 *
 * The `toolSource` can be a static record or a function that returns one,
 * enabling dynamic tool libraries that grow as toolkit configs are added.
 */
export class EntityFactory {
  private readonly toolSource: (() => Record<string, ToolDef>) | Record<string, ToolDef>;

  constructor(toolSource: (() => Record<string, ToolDef>) | Record<string, ToolDef> = {}) {
    this.toolSource = toolSource;
  }

  private get toolLibrary(): Record<string, ToolDef> {
    return typeof this.toolSource === "function" ? this.toolSource() : this.toolSource;
  }

  createAgent(blueprint: AgentBlueprint): Agent {
    this.validateProvider(blueprint.provider);
    const tools = this.resolveTools(blueprint.tools ?? []);
    const model = modelRegistry.resolve(blueprint.provider, blueprint.model, blueprint.providerConfig);

    return new Agent({
      name: blueprint.name,
      model,
      instructions: blueprint.instructions,
      tools: tools.length > 0 ? tools : undefined,
      temperature: blueprint.temperature,
    });
  }

  createTeam(blueprint: TeamBlueprint): Team {
    this.validateProvider(blueprint.provider);
    const members = this.resolveMembers(blueprint.members);
    const mode = this.resolveTeamMode(blueprint.mode);
    const model = modelRegistry.resolve(blueprint.provider, blueprint.model, blueprint.providerConfig);

    return new Team({
      name: blueprint.name,
      mode,
      model,
      members,
      instructions: blueprint.instructions,
    });
  }

  /**
   * Destroy a live entity by removing it from the global registry.
   * Returns true if found and removed.
   */
  destroyAgent(name: string): boolean {
    const agent = registry.getAgent(name);
    if (!agent) return false;
    return registry.remove(agent);
  }

  destroyTeam(name: string): boolean {
    const team = registry.getTeam(name);
    if (!team) return false;
    return registry.remove(team);
  }

  destroyWorkflow(name: string): boolean {
    const workflow = registry.getWorkflow(name);
    if (!workflow) return false;
    return registry.remove(workflow);
  }

  private validateProvider(provider: string): void {
    if (!modelRegistry.has(provider)) {
      throw new Error(
        `Unknown model provider "${provider}". Registered providers can be checked via modelRegistry.has().`,
      );
    }
  }

  private resolveTools(toolNames: string[]): ToolDef[] {
    const resolved: ToolDef[] = [];
    for (const name of toolNames) {
      const tool = this.toolLibrary[name];
      if (!tool) {
        const available = Object.keys(this.toolLibrary).join(", ") || "(none)";
        throw new Error(`Tool "${name}" not found in toolLibrary. Available: ${available}`);
      }
      resolved.push(tool);
    }
    return resolved;
  }

  private resolveMembers(memberNames: string[]): Agent[] {
    const members: Agent[] = [];
    for (const name of memberNames) {
      const agent = registry.getAgent(name);
      if (!agent) {
        const available = registry.list().agents.join(", ") || "(none)";
        throw new Error(`Agent "${name}" not found in registry. Available agents: ${available}`);
      }
      members.push(agent);
    }
    return members;
  }

  private resolveTeamMode(mode: string): TeamMode {
    const normalized = mode.toLowerCase();
    const modeMap: Record<string, TeamMode> = {
      coordinate: TeamMode.Coordinate,
      route: TeamMode.Route,
      broadcast: TeamMode.Broadcast,
      collaborate: TeamMode.Collaborate,
      handoff: TeamMode.Handoff,
    };
    const resolved = modeMap[normalized];
    if (!resolved) {
      throw new Error(`Unknown team mode "${mode}". Expected: ${Object.keys(modeMap).join(", ")}`);
    }
    return resolved;
  }
}
