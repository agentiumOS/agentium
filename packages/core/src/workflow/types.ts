import type { Agent } from "../agent/agent.js";
import type { RunContext } from "../agent/run-context.js";
import type { EventBus } from "../events/event-bus.js";
import type { StorageDriver } from "../storage/driver.js";

export type StepDef<TState> = AgentStep<TState> | FunctionStep<TState> | ConditionStep<TState> | ParallelStep<TState>;

export interface AgentStep<TState> {
  name: string;
  agent: Agent;
  inputFrom?: (state: TState) => string;
}

export interface FunctionStep<TState> {
  name: string;
  run: (state: TState, ctx: RunContext) => Promise<Partial<TState>>;
}

export interface ConditionStep<TState> {
  name: string;
  condition: (state: TState) => boolean;
  steps: StepDef<TState>[];
}

export interface ParallelStep<TState> {
  name: string;
  parallel: StepDef<TState>[];
}

export interface WorkflowConfig<TState extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  initialState: TState;
  steps: StepDef<TState>[];
  storage?: StorageDriver;
  retryPolicy?: { maxRetries: number; backoffMs: number };
  eventBus?: EventBus;
  /** Auto-register this workflow in the global registry. Default: true. Set false to opt out. */
  register?: boolean;
}

export interface WorkflowResult<TState> {
  state: TState;
  stepResults: StepResult[];
}

export interface StepResult {
  stepName: string;
  status: "done" | "error" | "skipped";
  error?: string;
  durationMs: number;
}
