import type { Agent } from "../agent/agent.js";
import type { RunContext } from "../agent/run-context.js";
import type { RunOutput } from "../agent/types.js";

export interface HandoffTarget {
  agent: Agent;
  description: string;
  onHandoff?: (ctx: RunContext) => Promise<void>;
}

export interface HandoffConfig {
  targets: HandoffTarget[];
  maxHandoffs?: number;
  carryMessages?: boolean;
  carrySessionState?: boolean;
}

export interface HandoffResult extends RunOutput {
  handoffChain: string[];
  finalAgent: string;
}

export class HandoffSignal extends Error {
  readonly targetAgent: string;
  readonly reason: string;

  constructor(targetAgent: string, reason: string) {
    super(`Handoff to "${targetAgent}": ${reason}`);
    this.name = "HandoffSignal";
    this.targetAgent = targetAgent;
    this.reason = reason;
  }
}
