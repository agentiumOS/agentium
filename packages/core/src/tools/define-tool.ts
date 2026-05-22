import type { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { SandboxConfig, ToolCacheConfig, ToolDef, ToolResult } from "./types.js";

export function defineTool<T extends z.ZodObject<any>>(config: {
  name: string;
  description: string;
  parameters: T;
  execute: (args: z.infer<T>, ctx: RunContext) => Promise<string | ToolResult>;
  cache?: ToolCacheConfig;
  sandbox?: boolean | SandboxConfig;
  requiresApproval?: boolean | ((args: Record<string, unknown>) => boolean);
  strict?: boolean;
  /** N-shot examples that demonstrate valid tool calls to the LLM. */
  inputExamples?: Array<z.infer<T>>;
  /** Async transformer applied to the tool result before it is appended to the LLM context. */
  toModelOutput?: (result: string | ToolResult, ctx: RunContext) => Promise<string | ToolResult>;
}): ToolDef {
  return {
    name: config.name,
    description: config.description,
    parameters: config.parameters,
    execute: config.execute as ToolDef["execute"],
    cache: config.cache,
    sandbox: config.sandbox,
    requiresApproval: config.requiresApproval,
    strict: config.strict,
    inputExamples: config.inputExamples as ToolDef["inputExamples"],
    toModelOutput: config.toModelOutput,
  };
}
