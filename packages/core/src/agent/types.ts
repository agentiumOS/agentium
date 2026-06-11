import type { z } from "zod";
import type { EventBus } from "../events/event-bus.js";
import type { LogLevel } from "../logger/logger.js";
import type { UnifiedMemoryConfig } from "../memory/memory-config.js";
import type { ModelProvider } from "../models/provider.js";
import type { ChatMessage, MessageContent, ReasoningConfig, StreamChunk, TokenUsage } from "../models/types.js";
import type { ApprovalConfig } from "../tools/approval.js";
import type { SandboxConfig, ToolCallResult, ToolDef } from "../tools/types.js";
import type { RetryConfig } from "../utils/retry.js";
import type { RunContext } from "./run-context.js";

export interface AgentConfig {
  name: string;
  model: ModelProvider;
  tools?: ToolDef[];
  instructions?: string | ((ctx: RunContext) => string);
  /** Auto-register this agent in the global registry. Default: true. Set false to opt out. */
  register?: boolean;
  /**
   * Unified memory config — sessions, summaries, user facts, user profile,
   * entities, decisions, and learnings. Pass an object with a `storage` field
   * to enable persistent memory. All subsystems share this single storage.
   */
  memory?: UnifiedMemoryConfig;
  sessionId?: string;
  userId?: string;
  maxToolRoundtrips?: number;
  temperature?: number;
  /** Maximum output tokens per LLM call. */
  maxTokens?: number;
  structuredOutput?: z.ZodSchema;
  hooks?: AgentHooks;
  guardrails?: {
    input?: InputGuardrail[];
    output?: OutputGuardrail[];
  };
  eventBus?: EventBus;
  /** Logging level. Set to "debug" for tool call details, "info" for summaries, "silent" to disable. Default: "silent". */
  logLevel?: LogLevel;
  /** Enable extended thinking / reasoning for the model. */
  reasoning?: ReasoningConfig;
  /** Retry configuration for transient LLM API failures (429, 5xx, network errors). */
  retry?: Partial<RetryConfig>;
  /** Default sandbox config applied to ALL tools unless the tool explicitly sets sandbox: false. Off by default. */
  sandbox?: boolean | SandboxConfig;
  /** Human-in-the-loop approval configuration for tool calls. */
  approval?: ApprovalConfig;
  /**
   * Skills — pre-packaged or learned tool bundles.
   * Accepts loaded Skill objects or source strings (paths, npm packages, URLs).
   */
  skills?: Array<import("../skills/types.js").Skill | string>;
  /** Agent handoff — transfer conversations to specialist agents. */
  handoff?: import("../handoff/types.js").HandoffConfig;
  /** Cost tracker — track token usage and enforce budgets. */
  costTracker?: import("../cost/cost-tracker.js").CostTracker;
  /** Semantic cache — cache LLM responses by semantic similarity. */
  semanticCache?: import("../cache/types.js").SemanticCacheConfig;
  /** Webhooks — push events to external destinations (HTTP, Slack, Email). */
  webhooks?: import("../webhooks/types.js").WebhookConfig;
  /**
   * Tool router — use a cheap model to pre-select relevant tools per query.
   * Dramatically reduces prompt tokens when the agent has many tools (e.g. 50+ MCP tools).
   */
  toolRouter?: import("../tools/tool-router.js").ToolRouterConfig;
  /**
   * Limit large tool results to prevent prompt token explosion.
   * When a tool returns more than `maxChars`, the result is either smart-truncated
   * (JSON arrays are sliced, objects trimmed) or summarized via a cheap model.
   *
   * Default: off (no limit). Recommended: `{ maxChars: 20000 }` for MCP-heavy agents.
   */
  toolResultLimit?: ToolResultLimitConfig;
  /** Per-roundtrip hooks for fine-grained LLM loop control (cost auto-stop, checkpointing, context compaction). */
  loopHooks?: LoopHooks;
  /** Dynamic tool resolver — called at the start of each run to provide context-dependent tools. */
  toolResolver?: (ctx: RunContext) => Promise<import("../tools/types.js").ToolDef[]>;
  /** Token-aware context compaction to prevent context window overflow. */
  contextCompactor?: ContextCompactorConfig;
  /** Auto-checkpoint after each tool roundtrip for rollback support. */
  checkpointing?: boolean | { storage: import("../storage/driver.js").StorageDriver };
  /** Context compression — auto-compress verbose tool results. Set `true` for defaults or provide a CompressionManager. */
  compressToolResults?: boolean;
  compressionManager?: import("../compression/compression-manager.js").CompressionManager;
  /** Runtime dependency injection — inject variables into instructions/messages via {key} templates. */
  dependencies?: Record<string, unknown | (() => unknown) | (() => Promise<unknown>)>;
  /** Auto-generate followup prompt suggestions after each response. */
  generateFollowups?: boolean | { count?: number; model?: ModelProvider };
  /** Culture system — shared organizational knowledge layer. */
  culture?: {
    storage: import("../storage/driver.js").StorageDriver;
    addToContext?: boolean;
    autoUpdate?: boolean;
    model?: ModelProvider;
  };

  /** Agent reflection and self-correction. */
  reflection?: import("./reflection.js").ReflectionConfig;
  /** Context pollution prevention. */
  contextCurator?: import("../context/context-curator.js").ContextCuratorConfig;
  /** Agent versioning — persist config snapshots. */
  versioning?: { storage: import("../storage/driver.js").StorageDriver };
  /** Compliance and audit trail. */
  compliance?: import("../compliance/types.js").ComplianceConfig;
  /** Multi-tenant isolation. */
  tenant?: import("../tenant/types.js").TenantConfig;
  /** Token-aware rate limiting and backpressure. */
  rateLimit?: import("../rate-limit/types.js").RateLimitConfig;
  /**
   * Memory Pointer Pattern: auto-inject `storeArtifact` / `getArtifact` / `listArtifacts`
   * tools and automatically convert large tool outputs into pointers.
   * Off by default.
   */
  artifacts?: ArtifactsConfig;
}

export interface ArtifactsConfig {
  enabled?: boolean;
  /**
   * Maximum byte size of a tool result before it auto-converts to an `art:` pointer.
   * Default: 51200 (50KB).
   */
  maxToolOutputBytes?: number;
  /** Characters kept in the preview surfaced to the LLM. Default: 200. */
  previewChars?: number;
}

export interface ContextCompactorConfig {
  maxContextTokens: number;
  reserveTokens?: number;
  strategy: "trim" | "summarize" | "hybrid";
  summarizeModel?: ModelProvider;
  priorityOrder?: ("system" | "recentHistory" | "memory" | "tools")[];
}

export interface ToolResultLimitConfig {
  /** Max characters before the strategy kicks in. Default: 20000 (~5K tokens). */
  maxChars?: number;
  /**
   * `"truncate"` — smart JSON truncation: arrays are sliced, remainder noted.
   * `"summarize"` — sends the full result to a cheap model for summarization.
   * Default: `"truncate"`.
   */
  strategy?: "truncate" | "summarize";
  /** Model used for summarization. Required when strategy is `"summarize"`. */
  model?: ModelProvider;
}

export interface RunOpts {
  sessionId?: string;
  userId?: string;
  tenantId?: string;
  metadata?: Record<string, unknown>;
  /** Per-request API key override passed to the model provider. */
  apiKey?: string;
  /** AbortSignal to cancel the run mid-execution. */
  signal?: AbortSignal;
  /** Per-run dependency overrides (merged with agent-level dependencies). */
  dependencies?: Record<string, unknown | (() => unknown) | (() => Promise<unknown>)>;
}

export interface RunMetrics {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  audioInputTokens?: number;
  audioOutputTokens?: number;
  /** Time from request start to first LLM response (ms). */
  timeToFirstTokenMs?: number;
  /** Total wall-clock duration (ms). */
  durationMs?: number;
}

export interface RunOutput {
  text: string;
  toolCalls: ToolCallResult[];
  usage: TokenUsage;
  /** Parsed structured output if structuredOutput schema is set. */
  structured?: unknown;
  /** Model's internal reasoning / thinking content (when reasoning is enabled). */
  thinking?: string;
  durationMs?: number;

  /** Unique run identifier. */
  runId?: string;
  /** Name of the agent that produced this output. */
  agentName?: string;
  /** Session identifier for multi-turn conversations. */
  sessionId?: string;
  /** User identifier (when provided). */
  userId?: string;
  /** Model ID used for this run (e.g. "gpt-4o", "gemini-2.5-flash"). */
  model?: string;
  /** Provider ID (e.g. "openai", "vertex", "anthropic"). */
  modelProvider?: string;
  /** Run completion status. */
  status?: "completed" | "error" | "stopped" | "cancelled";
  /** Unix timestamp (ms) when the run was created. */
  createdAt?: number;

  /** Enhanced metrics with timing and token breakdown. */
  metrics?: RunMetrics;

  /** Full conversation messages sent to the LLM (system + history + user input). */
  messages?: ChatMessage[];

  /** Provider-specific response identifier (e.g. OpenAI's chatcmpl-xxx). */
  responseId?: string;

  /** Auto-generated followup prompt suggestions. */
  followupSuggestions?: string[];

  /**
   * Self-critique result when reflection is enabled. Low scores indicate the
   * output may need human review — use for confidence-gated escalation.
   */
  critique?: { pass: boolean; score: number; feedback: string; revisions: number };
}

export interface AgentHooks {
  beforeRun?: (ctx: RunContext) => Promise<void>;
  afterRun?: (ctx: RunContext, output: RunOutput) => Promise<void>;
  onToolCall?: (ctx: RunContext, toolName: string, args: unknown) => Promise<void>;
  onError?: (ctx: RunContext, error: Error) => Promise<void>;
}

export type GuardrailResult = { pass: true } | { pass: false; reason: string };

export interface InputGuardrail {
  name: string;
  validate: (input: MessageContent, ctx: RunContext) => Promise<GuardrailResult>;
}

export interface OutputGuardrail {
  name: string;
  validate: (output: RunOutput, ctx: RunContext) => Promise<GuardrailResult>;
}

/** Per-roundtrip hooks injected into the LLM loop for fine-grained control. */
export interface LoopHooks {
  /** Called before each LLM API call. Return modified messages to override, or void to pass through. */
  beforeLLMCall?: (
    messages: import("../models/types.js").ChatMessage[],
    roundtrip: number,
    // biome-ignore lint/suspicious/noConfusingVoidType: callbacks may not return a value
  ) => Promise<import("../models/types.js").ChatMessage[] | void>;
  /** Called after each LLM API response. */
  afterLLMCall?: (response: { finishReason: string; usage: TokenUsage }, roundtrip: number) => Promise<void>;
  /** Called before each individual tool execution. Return `{ skip: true, result }` to skip execution. */
  // biome-ignore lint/suspicious/noConfusingVoidType: callbacks may not return a value
  beforeToolExec?: (toolName: string, args: unknown) => Promise<{ skip?: boolean; result?: string } | void>;
  /** Called after each individual tool execution. Return a string to replace the result. */
  // biome-ignore lint/suspicious/noConfusingVoidType: callbacks may not return a value
  afterToolExec?: (toolName: string, result: string) => Promise<string | void>;
  /** Called after all tools in a roundtrip complete. Return `{ stop: true }` to break the loop early. */
  // biome-ignore lint/suspicious/noConfusingVoidType: callbacks may not return a value
  onRoundtripComplete?: (roundtrip: number, tokensSoFar: TokenUsage) => Promise<{ stop?: boolean } | void>;
}

export type { StreamChunk };
