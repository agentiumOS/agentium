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
   * `fileMemory` and `filesystem` reuse this storage when they do not set their own.
   */
  memory?: UnifiedMemoryConfig;
  /**
   * Folder the agent may read and write on the host disk. Paths cannot leave
   * this folder. Turns on filesystem tools (`fs_read_file`, `fs_list_directory`,
   * `fs_file_info`, `fs_write_file`).
   */
  workspace?: string;
  /**
   * Folders to scan for Agent Skills (`SKILL.md`). The prompt only sees a short
   * name + description until the agent calls `get_skill_instructions`.
   */
  skillDirs?: string[];
  /**
   * Load project instruction files (`AGENTS.md`, `CLAUDE.md`, `.agentium.md`,
   * `.cursorrules`) and add them to the system prompt. Default: false.
   * `Agent.deep()` turns this on.
   */
  contextFiles?: boolean | import("../context/context-files.js").LoadContextFilesOptions;
  /**
   * Durable notes the agent writes for its future self (not the host disk).
   * Tools: `agent_fs_write`, `agent_fs_read`, `agent_fs_list`, `agent_fs_search`.
   */
  filesystem?: boolean | import("../fs/agent-fs.js").AgentFileSystemConfig;
  /**
   * Isolated child agents via the `task` tool. The child gets a fresh chat and
   * returns one final report. Default: false. `Agent.deep()` turns this on.
   */
  subagents?: boolean | { maxDepth?: number };
  /**
   * Tiny standing memory files (MEMORY.md / USER.md) with a hard character cap.
   * Default: false. `Agent.deep()` turns this on.
   */
  fileMemory?: boolean | import("../memory/file-memory.js").FileMemoryConfig;
  /**
   * Vector-backed learnings. Requires a real vector store — pass
   * `{ vectorStore }` here or set `memory.learnings`.
   */
  learning?: import("../memory/memory-config.js").LearningsConfig;
  /**
   * Give the agent a `search_past_sessions` tool to look up older chats by keyword.
   */
  searchPastSessions?: boolean;
  /**
   * Use the process-wide `EventBus.shared` so one tracer can see every agent.
   */
  sharedEventBus?: boolean;
  /** Alias for `eventBus`. */
  events?: EventBus;
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
  /**
   * Custom event bus. Default: a private bus for this agent.
   * Pass `EventBus.shared` (or `sharedEventBus: true`) so one tracer sees everything.
   */
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
  /** Agent reflection and self-correction. */
  reflection?: import("./reflection.js").ReflectionConfig;
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
  /** Continue this conversation. Same id = the agent remembers prior turns. */
  sessionId?: string;
  /** Who is talking. Used by memory, fileMemory (USER.md), and isolation. */
  userId?: string;
  /** Which customer/org this run belongs to (multi-tenant apps). */
  tenantId?: string;
  /** Extra facts your tools and instruction functions can read via `ctx.metadata`. */
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
