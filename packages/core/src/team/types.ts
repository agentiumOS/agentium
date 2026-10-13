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
  /**
   * @deprecated Native Agent tools return settled transfer control, which this
   * legacy Team protocol does not own. Configure Agent handoff targets outside
   * controlled execution, or use host-owned routing / Team route, broadcast or
   * coordinate within a controlled runtime. Preserved through this major.
   */
  Handoff = "handoff",
}

export interface TeamConfig {
  cost?: boolean | import("../cost/types.js").CostTrackerConfig;
  costTracker?: import("../cost/cost-tracker.js").CostTracker;
  name: string;
  mode: TeamMode;
  model: ModelProvider;
  members: Array<Agent | import("../a2a/a2a-remote-agent.js").A2ARemoteAgent>;
  instructions?: string;
  sessionState?: Record<string, unknown>;
  /** Retained configuration field; configure storage on borrowed member Agents explicitly. */
  storage?: StorageDriver;
  maxRounds?: number;
  eventBus?: EventBus;
  /** Auto-register this team in the global registry. Default: true. Set false to opt out. */
  register?: boolean;
  /**
   * Retained configuration field. Team does not reconfigure borrowed Agents'
   * memory or storage; configure those explicitly on each member.
   */
  memory?: UnifiedMemoryConfig;
}

export type { RunOpts, RunOutput, StreamChunk };
