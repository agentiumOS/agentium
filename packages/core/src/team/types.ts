import type { Agent } from "../agent/agent.js";
import type { RunOpts, RunOutput, StreamChunk } from "../agent/types.js";
import type { EventBus } from "../events/event-bus.js";
import type { UnifiedMemoryConfig } from "../memory/memory-config.js";
import type { ModelProvider } from "../models/provider.js";
import type { StorageDriver } from "../storage/driver.js";

export enum TeamMode {
  Coordinate = "coordinate",
  Route = "route",
  Broadcast = "broadcast",
  Collaborate = "collaborate",
  Handoff = "handoff",
}

export interface TeamConfig {
  name: string;
  mode: TeamMode;
  model: ModelProvider;
  members: Array<Agent | import("../a2a/a2a-remote-agent.js").A2ARemoteAgent>;
  instructions?: string;
  sessionState?: Record<string, unknown>;
  storage?: StorageDriver;
  maxRounds?: number;
  eventBus?: EventBus;
  /** Auto-register this team in the global registry. Default: true. Set false to opt out. */
  register?: boolean;
  /**
   * Shared memory across all team members. Member agents that don't have their own
   * memory config will use this shared memory, enabling cross-agent knowledge sharing.
   */
  memory?: UnifiedMemoryConfig;
}

export type { RunOpts, RunOutput, StreamChunk };
