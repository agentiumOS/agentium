import type { Agent } from "../agent/agent.js";
import type { RunContext } from "../agent/run-context.js";
import type { RunOpts, RunOutput } from "../agent/types.js";
import type { EventBus } from "../events/event-bus.js";
import type { StorageDriver } from "../storage/driver.js";

export type StepDef<TState> =
  | AgentStep<TState>
  | FunctionStep<TState>
  | ConditionStep<TState>
  | ParallelStep<TState>
  | GraphStep<TState>
  | RepeatStep<TState>;

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
  /** Later declarations win collisions by default; error rejects conflicting owned keys. */
  merge?: "declaration_order" | "error";
}

/** A complete dependency episode; executable steps come from the trusted host. */
export interface WorkflowGraphNode<TState> {
  id: string;
  step: StepDef<TState>;
  /** Control gates accept done/skipped predecessors, but never failed ones. */
  dependsOn?: string[];
  /** Data edges also gate readiness and require a done producer. */
  inputsFrom?: string[];
}

export interface GraphStep<TState> {
  name: string;
  graph: WorkflowGraphNode<TState>[] | ((state: TState) => WorkflowGraphNode<TState>[]);
  /** Positive safe integer, default 5. */
  maxConcurrency?: number;
  /** Positive safe integer, default 100; checked on each materialization. */
  maxNodes?: number;
  /** Stable topological joins; strict mode rejects incomparable writers. Default error. */
  merge?: "error" | "declaration_order";
}

/** Intentional cycles are bounded episodes, rather than back edges in a DAG. */
export interface RepeatStep<TState> {
  name: string;
  repeat: StepDef<TState>[];
  /** Pre-test, with zero-based number of completed iterations. */
  while: (state: TState, iteration: number) => boolean;
  maxIterations: number;
}

export interface WorkflowConfig<TState extends Record<string, unknown> = Record<string, unknown>> {
  cost?: boolean | import("../cost/types.js").CostTrackerConfig;
  costTracker?: import("../cost/cost-tracker.js").CostTracker;
  name: string;
  initialState: TState;
  steps: StepDef<TState>[];
  storage?: StorageDriver;
  /** Ordinary errors are collected by default; stop skips later serial work. */
  failurePolicy?: "continue" | "stop";
  /** Supply together with validateCheckpointState to enable versioned continuation. */
  definitionVersion?: string;
  validateCheckpointState?: (value: unknown) => TState;
  retryPolicy?: { maxRetries: number; backoffMs: number };
  eventBus?: EventBus;
  /** Auto-register this workflow in the global registry. Default: true. Set false to opt out. */
  register?: boolean;
  /**
   * Save state after each top-level step. Continuation reruns later effects;
   * checkpoints do not provide recorded playback or exactly-once execution.
   */
  checkpointStore?: import("./checkpoints.js").WorkflowCheckpointStore<TState>;
}

export interface WorkflowResult<TState> {
  costs?: import("../cost/accounting-types.js").RunCostSnapshot;
  status?: "completed" | "failed";
  reason?: { code: "workflow_step_failed" | "workflow_iteration_limit"; message: string };
  state: TState;
  stepResults: StepResult[];
}

export interface StepResult {
  stepName: string;
  status: "done" | "error" | "skipped";
  error?: string;
  /** Scoped graph node / repeat iteration identity. Not an idempotency key. */
  executionPath?: string;
  reason?: { code: string; message: string };
  /** Partial child output is evidence and never a successful named state patch. */
  output?: { text: string; status: RunOutput["status"]; reason?: RunOutput["reason"] };
  durationMs: number;
}

/** Caller-owned identity, policy and dependencies for a fresh continuation run. */
export type WorkflowContinuationOptions = RunOpts;
