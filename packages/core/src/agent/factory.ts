import type { StorageDriver } from "../storage/driver.js";
import { ScopedStorage, type StorageScope } from "../storage/scoped.js";
import { Team } from "../team/team.js";
import type { TeamConfig } from "../team/types.js";
import type { WorkflowConfig } from "../workflow/types.js";
import { Workflow } from "../workflow/workflow.js";
import { Agent } from "./agent.js";
import type { AgentConfig } from "./types.js";

export type FactoryContext = StorageScope;

function scopeStorage<T extends { storage?: StorageDriver } | undefined>(node: T, scope: StorageScope): T {
  if (!node?.storage) return node;
  return { ...node, storage: new ScopedStorage(node.storage, scope) } as T;
}

function scopeAgentConfig(base: AgentConfig, scope: StorageScope): AgentConfig {
  const cloned: AgentConfig = { ...base, register: false };

  // Carry scope through to the Agent runtime.
  if (scope.userId) cloned.userId = scope.userId;

  if (base.memory) {
    cloned.memory = { ...base.memory };
    if (base.memory.storage) {
      cloned.memory.storage = new ScopedStorage(base.memory.storage, scope);
    }
  }

  cloned.checkpointing = scopeStorage(typeof base.checkpointing === "object" ? base.checkpointing : undefined, scope);
  if (cloned.checkpointing === undefined && base.checkpointing === true) {
    cloned.checkpointing = true;
  }

  cloned.culture = scopeStorage(base.culture, scope);
  cloned.versioning = scopeStorage(base.versioning, scope);

  return cloned;
}

/**
 * Factory for creating per-request `Agent` instances scoped to a tenant / user.
 *
 * @example
 * ```ts
 * const factory = new AgentFactory({
 *   name: "assistant",
 *   model: openai("gpt-4o"),
 *   memory: { storage: new SqliteStorage("data.db") },
 * });
 *
 * app.post("/chat", (req, res) => {
 *   const agent = factory.create({ tenantId: req.user.tenant, userId: req.user.id });
 *   return agent.run(req.body.input);
 * });
 * ```
 */
export class AgentFactory {
  constructor(private readonly base: AgentConfig) {}

  create(scope: FactoryContext = {}): Agent {
    return new Agent(scopeAgentConfig(this.base, scope));
  }
}

export class TeamFactory {
  constructor(private readonly base: TeamConfig) {}

  create(scope: FactoryContext = {}): Team {
    const cfg: TeamConfig = { ...this.base, register: false };
    if (cfg.memory) {
      cfg.memory = { ...cfg.memory };
      if (cfg.memory.storage) {
        cfg.memory.storage = new ScopedStorage(cfg.memory.storage, scope);
      }
    }
    return new Team(cfg);
  }
}

export class WorkflowFactory<TState extends Record<string, unknown> = Record<string, unknown>> {
  constructor(private readonly base: WorkflowConfig<TState>) {}

  create(_scope: FactoryContext = {}): Workflow<TState> {
    // Workflows don't currently take storage in their config; the per-step agents
    // (which are passed by reference) will pick up scope when constructed via
    // AgentFactory themselves. We just disable global registration here.
    return new Workflow<TState>({ ...this.base, register: false });
  }
}
