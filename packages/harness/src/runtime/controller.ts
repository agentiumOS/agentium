import type { ModelConfig, ModelResponse, RunContext, ToolDefinition } from "@agentium/core";
import type { ContextPolicy } from "./context-policy.js";

export interface StepOverrides {
  activeToolIds?: readonly string[];
  modelRole?: string;
  options?: ModelConfig;
  contextPolicy?: ContextPolicy;
  stop?: { reason: string };
}
export interface StepController {
  id: string;
  prepareRun?: (ctx: RunContext) => Promise<StepOverrides | undefined>;
  prepareStep?: (
    step: { index: number; tools: readonly ToolDefinition[] },
    ctx: RunContext,
  ) => Promise<StepOverrides | undefined>;
}
export type CompletionDecision =
  | { action: "accept"; reason: string; evidence?: readonly string[] }
  | { action: "revise"; reason: string; instruction: string; evidence?: readonly string[] }
  | { action: "await_input" | "stop"; reason: string; evidence?: readonly string[] };
export interface CompletionPolicy {
  id: string;
  evaluate: (
    response: { text: string; structured?: unknown; revision: number },
    ctx: RunContext,
  ) => Promise<CompletionDecision>;
}
export interface ModelRoleBinding {
  provider: import("@agentium/core").ModelProvider;
  /** Explicit allowlist of ModelConfig keys supported by this binding. */
  options?: readonly (keyof ModelConfig)[];
}
export interface ModelInvocation {
  response: ModelResponse;
  modelRole: string;
}
