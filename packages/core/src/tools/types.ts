import type { RunContext } from "../agent/run-context.js";
import type { ToolParameterSchema } from "./schema.js";

export interface Artifact {
  type: string;
  data: unknown;
  mimeType?: string;
}

export interface ToolResult {
  content: string;
  artifacts?: Artifact[];
}

export interface ToolCacheConfig {
  /** Time-to-live in milliseconds. Cached results expire after this duration. */
  ttl: number;
}

export interface SandboxConfig {
  /** Explicit on/off toggle. Defaults to true when config object is provided. */
  enabled?: boolean;
  /** Execution timeout in milliseconds. Default: 30000 (30s). */
  timeout?: number;
  /** Maximum heap memory in MB. Default: 256. */
  maxMemoryMB?: number;
  /** Allow outbound network from the sandbox. Default: false. */
  allowNetwork?: boolean;
  /** Allow filesystem access. Default: false. */
  allowFS?: boolean | { readOnly?: string[]; readWrite?: string[] };
  /** Whitelisted environment variables forwarded to the sandbox. */
  env?: Record<string, string>;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
  execute: (args: Record<string, unknown>, ctx: RunContext) => Promise<string | ToolResult>;
  /** Raw JSON Schema to send to the LLM, bypassing Zod-to-JSON conversion (used by MCP tools). */
  rawJsonSchema?: Record<string, unknown>;
  /** Enable result caching for this tool. */
  cache?: ToolCacheConfig;
  /** Run this tool in a sandboxed subprocess. Off by default. */
  sandbox?: boolean | SandboxConfig;
  /**
   * Require approval before execution; no configured approval service denies the
   * call. False overrides legacy approval defaults, never mandatory host policy.
   */
  requiresApproval?: boolean | ((args: Record<string, unknown>) => boolean);
  /** Enable strict mode for OpenAI Structured Outputs on tool calls. Guarantees valid JSON matching the schema. */
  strict?: boolean;
  /**
   * Optional N-shot examples that demonstrate valid tool calls to the LLM.
   * Each example is rendered into the tool's JSON Schema description.
   */
  inputExamples?: Array<Record<string, unknown>>;
  /**
   * Optional async transformer applied to the tool result *after* execution but
   * *before* the result is appended to the LLM context. Use to compress, summarize,
   * redact, or otherwise reshape large outputs.
   */
  toModelOutput?: (result: string | ToolResult, ctx: RunContext) => Promise<string | ToolResult>;
}

export interface ToolCallResult {
  toolCallId: string;
  toolName: string;
  result: string | ToolResult;
  error?: string;
  /** Structured fail-closed execution outcome. */
  denial?: "policy" | "approval_required" | "approval_denied" | "cancelled";
}
