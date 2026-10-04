import type { RunContext } from "../agent/run-context.js";

export type RunMode = "execute" | "plan";
export type ToolEffect = "read" | "write" | "execute" | "external" | "unknown";

export interface ValidatedToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface ExecutionDecision {
  action: "allow" | "ask" | "deny";
  reason?: string;
}

/**
 * Host-supplied mandatory policy. Model arguments and MCP annotations are not
 * effect authority. The validated arguments must support Node's structured
 * serialization (ordinary data, dates, maps and typed arrays; not functions).
 * Mutating reviewed arguments fails closed before execution.
 */
export interface ExecutionPolicy {
  decide: (call: ValidatedToolCall, ctx: RunContext) => ExecutionDecision | Promise<ExecutionDecision>;
  /** Classifies the complete tool execution, including its result transformer. */
  resolveEffect?: (call: ValidatedToolCall, ctx: RunContext) => ToolEffect | Promise<ToolEffect>;
}

export async function evaluateExecutionPolicy(
  policy: ExecutionPolicy | undefined,
  call: ValidatedToolCall,
  ctx: RunContext,
): Promise<ExecutionDecision> {
  const decision = policy ? await policy.decide(call, ctx) : { action: "allow" as const };
  if (!["allow", "ask", "deny"].includes(decision?.action)) {
    return { action: "deny", reason: "Execution policy returned an invalid decision" };
  }
  if (decision.action === "deny" || ctx.runMode !== "plan") return decision;
  const effect = (await policy?.resolveEffect?.(call, ctx)) ?? "unknown";
  if (effect === "unknown") return { action: "ask", reason: "Plan mode requires review for an unknown tool effect" };
  if (effect !== "read") return { action: "deny", reason: `Plan mode prohibits tool effect: ${effect}` };
  return decision;
}
