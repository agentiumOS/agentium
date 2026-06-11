import type { Agent } from "./agent/agent.js";
import type { Team } from "./team/team.js";
import type { Workflow } from "./workflow/workflow.js";

export type Servable = Agent | Team | Workflow<any>;

export interface ClassifiedServables {
  agents: Record<string, Agent>;
  teams: Record<string, Team>;
  workflows: Record<string, Workflow<any>>;
}

/**
 * Live registry for Agents, Teams, and Workflows.
 *
 * Instances auto-register on construction (unless `register: false`).
 * Transport layers (Express, Socket.IO) read from the registry dynamically —
 * agents created after the gateway starts are immediately available.
 *
 * Names are labels, not unique keys: registering an item with an existing
 * name replaces the previous entry (last-write-wins). This allows the same
 * agent definition to be constructed repeatedly (loops, factories,
 * concurrent requests) without conflicts.
 *
 * @example
 * ```ts
 * createAgentGateway({ io });
 *
 * new Agent({ name: "bot", model: openai("gpt-4o") });
 * // "bot" is immediately reachable via the gateway
 * ```
 */
export class Registry {
  readonly agents = new Map<string, Agent>();
  readonly teams = new Map<string, Team>();
  readonly workflows = new Map<string, Workflow<any>>();

  add(item: Servable): void {
    const kind = (item as any).kind;
    const name = (item as any).name;

    if (!name || typeof name !== "string") {
      throw new Error('Servable item is missing a "name" property');
    }

    switch (kind) {
      case "agent":
        this.agents.set(name, item as Agent);
        break;
      case "team":
        this.teams.set(name, item as Team);
        break;
      case "workflow":
        this.workflows.set(name, item as Workflow<any>);
        break;
      default:
        throw new Error(`Unknown servable kind "${kind}" on "${name}". Expected Agent, Team, or Workflow.`);
    }
  }

  remove(item: Servable): boolean {
    const kind = (item as any).kind;
    const name = (item as any).name;

    switch (kind) {
      case "agent":
        return this.agents.delete(name);
      case "team":
        return this.teams.delete(name);
      case "workflow":
        return this.workflows.delete(name);
      default:
        return false;
    }
  }

  getAgent(name: string): Agent | undefined {
    return this.agents.get(name);
  }

  getTeam(name: string): Team | undefined {
    return this.teams.get(name);
  }

  getWorkflow(name: string): Workflow<any> | undefined {
    return this.workflows.get(name);
  }

  clear(): void {
    this.agents.clear();
    this.teams.clear();
    this.workflows.clear();
  }

  list(): { agents: string[]; teams: string[]; workflows: string[] } {
    return {
      agents: [...this.agents.keys()],
      teams: [...this.teams.keys()],
      workflows: [...this.workflows.keys()],
    };
  }

  describeAgents(): Array<{
    name: string;
    model: string;
    provider: string;
    tools: string[];
    hasStructuredOutput: boolean;
    description?: string;
    capabilities: string[];
    version?: string;
  }> {
    return [...this.agents.values()].map((a) => ({
      name: a.name,
      model: (a as any).modelId ?? "unknown",
      provider: (a as any).providerId ?? "unknown",
      tools: ((a as any).tools ?? []).map((t: any) => t.name),
      hasStructuredOutput: !!(a as any).hasStructuredOutput,
      description: this.extractDescription(a),
      capabilities: this.detectCapabilities(a),
    }));
  }

  getAgentCard(name: string): object | null {
    const agent = this.agents.get(name);
    if (!agent) return null;

    const tools = ((agent as any).tools ?? []).map((t: any) => ({
      name: t.name,
      description: t.description,
    }));

    return {
      name: agent.name,
      description: this.extractDescription(agent),
      model: (agent as any).modelId ?? "unknown",
      provider: (agent as any).providerId ?? "unknown",
      url: `/agents/${agent.name}`,
      capabilities: this.detectCapabilities(agent),
      tools,
      hasStructuredOutput: !!(agent as any).hasStructuredOutput,
      inputSchema: (agent as any).structuredOutputSchema
        ? { type: "string", description: "Natural language input" }
        : undefined,
      outputSchema: (agent as any).structuredOutputSchema ? "structured" : "text",
      version: "1.0.0",
    };
  }

  getAllAgentCards(): object[] {
    return [...this.agents.keys()].map((name) => this.getAgentCard(name)).filter(Boolean) as object[];
  }

  private extractDescription(agent: Agent): string | undefined {
    const instructions = (agent as any).instructions;
    if (!instructions) return undefined;
    const text = typeof instructions === "function" ? undefined : instructions;
    if (!text) return undefined;
    const firstSentence = text.split(/[.!?\n]/)[0]?.trim();
    return firstSentence || undefined;
  }

  private detectCapabilities(agent: Agent): string[] {
    const caps: string[] = [];
    if ((agent as any).memory) caps.push("memory");
    if (((agent as any).tools ?? []).length > 0) caps.push("tools");
    if ((agent as any).hasStructuredOutput) caps.push("structured_output");
    const config = (agent as any).config;
    if (config?.handoff) caps.push("handoff");
    if (config?.costTracker) caps.push("cost_tracking");
    if (config?.semanticCache) caps.push("caching");
    if (config?.contextCompactor) caps.push("context_compaction");
    if (config?.checkpointing) caps.push("checkpointing");
    caps.push("streaming");
    return caps;
  }

  describeTeams(): Array<{ name: string }> {
    return [...this.teams.values()].map((t) => ({ name: t.name }));
  }

  describeWorkflows(): Array<{ name: string }> {
    return [...this.workflows.values()].map((w) => ({ name: w.name }));
  }
}

/** Global default registry. Agents/Teams/Workflows auto-register here. */
export const registry = new Registry();

/**
 * Classify an array of mixed Agent/Team/Workflow instances into
 * separate maps keyed by each instance's `.name` property.
 */
export function classifyServables(items: Servable[]): ClassifiedServables {
  const result: ClassifiedServables = {
    agents: {},
    teams: {},
    workflows: {},
  };

  for (const item of items) {
    const kind = (item as any).kind;
    const name = (item as any).name;

    if (!name || typeof name !== "string") {
      throw new Error(`Servable item is missing a "name" property`);
    }

    switch (kind) {
      case "agent":
        result.agents[name] = item as Agent;
        break;
      case "team":
        result.teams[name] = item as Team;
        break;
      case "workflow":
        result.workflows[name] = item as Workflow<any>;
        break;
      default:
        throw new Error(`Unknown servable kind "${kind}" on "${name}". Expected Agent, Team, or Workflow.`);
    }
  }

  return result;
}
