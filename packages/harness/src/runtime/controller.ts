import type { ModelConfig, ModelResponse, RunContext, ToolDefinition } from "@agentium/core";
import { z } from "zod/v3";
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
const detail = {
  reason: z.string().trim().min(1),
  evidence: z.array(z.string().trim().min(1)).max(32).optional(),
};
const completionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept"), ...detail }).strict(),
  z.object({ action: z.literal("revise"), instruction: z.string().trim().min(1), ...detail }).strict(),
  z.object({ action: z.literal("stop"), ...detail }).strict(),
  z.object({ action: z.literal("await_input"), ...detail }).strict(),
]);
export class CompletionDecisionError extends Error {
  readonly code = "invalid_completion";
  constructor(cause?: unknown) {
    super("Completion decision must be valid and fit 32 evidence references and 8192 UTF-8 bytes", { cause });
    this.name = "CompletionDecisionError";
  }
}
/** Validate trusted integration output before it can authorize acceptance or revisions. */
export function validateCompletionDecision(value: unknown): CompletionDecision {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > 8192) throw new CompletionDecisionError();
    return completionSchema.parse(value);
  } catch (error) {
    if (error instanceof CompletionDecisionError) throw error;
    throw new CompletionDecisionError(error);
  }
}
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
