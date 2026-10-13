import type {
  Agent,
  DurableActionConnector,
  DurableJSON,
  ModelProvider,
  RootExecutionLimits,
  ToolDef,
} from "@agentium/core";

/** Host-owned schema boundary; validators/code/credentials never come from proposals. */
export interface GraphValueSchema {
  parse(value: unknown): unknown;
}
interface GraphBindingBase {
  id: string;
  version: string;
  input: GraphValueSchema;
  output: GraphValueSchema;
  /** Dot-separated supported reference paths; empty string denotes the whole value. */
  referenceInputs?: readonly string[];
  referenceOutputs?: readonly string[];
  /** Required for templates containing future values: pure literal/template validation. */
  validateTemplate?: (template: Record<string, DurableJSON>) => void;
}
export interface GraphToolBinding extends GraphBindingBase {
  kind: "tool";
  tool: ToolDef;
  /** Pure is a trusted host declaration of no external mutation. */
  recovery?:
    | "pure"
    | {
        connector: DurableActionConnector;
        destination: string;
        resolveResult(resultRef: string): Promise<DurableJSON>;
      };
}
export interface GraphAgentBinding extends GraphBindingBase {
  kind: "agent";
  agent: Agent;
  /** Explicit approved tool binding IDs, including any static Agent-local tools. */
  tools: readonly string[];
}
export interface GraphNestedBinding extends GraphBindingBase {
  kind: "graph";
  program: ExecutionGraphProgram;
}
export interface GraphRepeatBinding extends GraphBindingBase {
  kind: "repeat";
  program: ExecutionGraphProgram;
  maxIterations: number;
  /** Pinned by binding version; evaluated decisions are persisted before child work. */
  while(output: DurableJSON, completedIterations: number): boolean;
}
export type GraphBinding = GraphToolBinding | GraphAgentBinding | GraphNestedBinding | GraphRepeatBinding;
export interface ExecutionPlanNode {
  id: string;
  binding: string;
  version: string;
  args: Record<string, DurableJSON>;
  dependsOn?: readonly string[];
  inputsFrom?: readonly string[];
}
export interface ExecutionPlan {
  schemaVersion: 1;
  revision: number;
  nodes: readonly ExecutionPlanNode[];
  maxConcurrency?: number;
  merge?: "error" | "declaration_order";
}
export interface PlanValidationLimits {
  maxBytes: number;
  maxNodes: number;
  maxDepth: number;
  maxConcurrency: number;
  durable: boolean;
}
export interface PlanReferenceRequirement {
  consumer: string;
  producer: string;
  outputPath: readonly string[];
  argumentPath: readonly string[];
}
export interface ValidatedExecutionPlan {
  plan: ExecutionPlan;
  order: readonly string[];
  referenceRequirements: readonly PlanReferenceRequirement[];
  digest: string;
  catalogDigest: string;
  bindingKinds: Record<string, GraphBinding["kind"]>;
}
export interface PlanCommitFrame {
  baseRevision: number;
  plan: ExecutionPlan;
}
export interface ValidatedPlanCommitFrame {
  baseRevision: number;
  validated: ValidatedExecutionPlan;
}
export interface PlanStreamLimits {
  maxFrameBytes: number;
  maxTotalBytes: number;
  maxFrames: number;
  /** Per planning call, default 30 seconds; original root deadline still applies. */
  maxLatencyMs?: number;
}
export interface ExecutionGraphPlannerOptions {
  provider: ModelProvider;
  hostInstructions: string;
  maxCorrections: number;
  maxOutputTokens: number;
  stream: PlanStreamLimits;
}
/** A complete static proposal or an authorized planner; nested programs inherit the root catalog. */
export interface ExecutionGraphProgram {
  id: string;
  version: string;
  plan?: ExecutionPlan;
  planner?: ExecutionGraphPlannerOptions & { mode?: "complete" | "stream" };
}
export interface ExecutionGraphLimits extends RootExecutionLimits {
  plan?: Partial<Omit<PlanValidationLimits, "durable">>;
}
