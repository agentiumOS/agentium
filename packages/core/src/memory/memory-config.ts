import type { GraphStore } from "../graph/types.js";
import type { ModelProvider } from "../models/provider.js";
import type { StorageDriver } from "../storage/driver.js";
import type { VectorStore } from "../vector/types.js";

// ── Sub-feature configs ──────────────────────────────────────────────────

export interface SummaryConfig {
  /** Maximum number of summaries kept per session (oldest pruned first). Default: 10 */
  maxCount?: number;
  /** Token budget for summary context injected into the system prompt. Default: 2000 */
  maxTokens?: number;
}

export interface UserFactsConfig {
  /** Maximum number of facts stored per user. Default: 100 */
  maxFacts?: number;
}

export interface UserProfileConfig {
  /** Additional custom fields to track beyond the built-in ones (name, role, etc.). */
  customFields?: string[];
}

export interface EntityConfig {
  /** Namespace for entity scoping. Supports hierarchical paths like "org/team/project". Default: "global" */
  namespace?: string;
}

export interface DecisionConfig {
  /** Maximum recent decisions injected into context. Default: 5 */
  maxContextDecisions?: number;
}

export interface LearningsConfig {
  /** Vector store for semantic search over learned insights. Required. */
  vectorStore: VectorStore;
  /** Collection name in the vector store. Default: "agentium_learnings" */
  collection?: string;
  /** Number of relevant learnings to inject into context. Default: 3 */
  topK?: number;
  /**
   * Relevance floor (0–1) — matches below this similarity are never injected
   * into context. Prevents weak matches from polluting the prompt.
   * Recommended: 0.3–0.5 with real embeddings. Default: no floor.
   */
  minScore?: number;
}

export interface CorrectionsConfig {
  /** Vector store for semantic search over past corrections. Required. */
  vectorStore: VectorStore;
  /** Collection name in the vector store. Default: "agentium_corrections" */
  collection?: string;
  /** Number of relevant corrections to inject into context. Default: 3 */
  topK?: number;
  /**
   * Relevance floor (0–1) — matches below this similarity are never injected
   * into context. Recommended: 0.3–0.5 with real embeddings. Default: no floor.
   */
  minScore?: number;
  /**
   * When a correction is recorded, automatically invalidate unverified
   * (llm-extracted) learnings that semantically collide with it at or above
   * `contradictionThreshold` similarity. Human-authored learnings are never
   * auto-invalidated. Default: true.
   */
  invalidateContradicted?: boolean;
  /** Similarity threshold for contradiction invalidation. Default: 0.85 */
  contradictionThreshold?: number;
}

export interface GraphMemoryConfig {
  /** Graph store backend for knowledge graph. */
  store: GraphStore;
  /** Automatically extract entities and relationships from conversations. Default: true */
  autoExtract?: boolean;
  /** Maximum number of graph nodes in context. Default: 10 */
  maxContextNodes?: number;
}

export interface ProceduresConfig {
  /** Maximum stored procedures. Default: 50 */
  maxProcedures?: number;
}

export interface ContextBudgetConfig {
  /** Maximum total tokens for the memory context string. */
  maxTokens?: number;
  /** Priority weights for each section (higher = gets more token budget). */
  priorities?: Partial<Record<string, number>>;
}

// ── Unified MemoryConfig ─────────────────────────────────────────────────

export interface UnifiedMemoryConfig {
  /** Storage backend shared by all memory subsystems. */
  storage: StorageDriver;

  /** Maximum messages kept in session history. Oldest are trimmed first. Default: 50 */
  maxMessages?: number;

  /** Maximum context window tokens for history. History is auto-trimmed to fit. */
  maxTokens?: number;

  /**
   * Long-term conversation summaries. Auto-summarizes overflow messages.
   * ON by default. Pass `false` to disable, `true` for defaults, or a config object.
   */
  summaries?: boolean | SummaryConfig;

  /**
   * User fact extraction — "user prefers dark mode", "lives in Mumbai".
   * OFF by default. Pass `true` for defaults, or a config object.
   */
  userFacts?: boolean | UserFactsConfig;

  /**
   * Structured user profile — name, role, timezone, language, custom fields.
   * OFF by default. Pass `true` for defaults, or a config object.
   */
  userProfile?: boolean | UserProfileConfig;

  /**
   * Entity memory — companies, people, projects extracted from conversations.
   * OFF by default. Pass `true` for defaults, or a config object.
   */
  entities?: boolean | EntityConfig;

  /**
   * Decision audit trail — what the agent decided and why.
   * OFF by default. Pass `true` for defaults, or a config object.
   */
  decisions?: boolean | DecisionConfig;

  /**
   * Learned knowledge — vector-backed insights from interactions.
   * OFF by default. Pass a config with a vectorStore to enable.
   */
  learnings?: LearningsConfig;

  /**
   * Correction capture — structured records of humans correcting agent
   * output, embedded and retrieved at inference time so mistakes are not
   * repeated. OFF by default. Pass a config with a vectorStore to enable.
   */
  corrections?: CorrectionsConfig;

  /**
   * Knowledge graph — entity-relationship graph with traversal and temporal awareness.
   * OFF by default. Pass a config with a GraphStore to enable.
   */
  graph?: GraphMemoryConfig;

  /**
   * Procedural memory — records successful tool-call workflows for reuse.
   * OFF by default. Pass `true` for defaults, or a config object.
   */
  procedures?: boolean | ProceduresConfig;

  /**
   * Token budget allocation for context building.
   * Controls how memory context is distributed across sections.
   */
  contextBudget?: ContextBudgetConfig;

  /**
   * Separate (cheaper) model used for all background extraction operations.
   * Falls back to the agent's primary model if not set.
   */
  model?: ModelProvider;

  /**
   * IANA timezone (e.g. "Asia/Kolkata") used to anchor date-relative extraction
   * ("today", "yesterday"). Falls back to UTC when omitted. Always set this in
   * production — otherwise users near midnight get wrong dates extracted.
   */
  timezone?: string;

  /**
   * Tenant identifier — when set, learnings and procedures saved with
   * `scope: "tenant"` are visible to every user/agent under this tenant.
   * Required for tenant-scoped reads to return anything.
   */
  tenantId?: string;

  /**
   * Optional event bus — when supplied, memory extraction failures and
   * other framework events are emitted here so they can be wired into
   * observability (OpenTelemetry, Langfuse, Prometheus, etc.).
   */
  eventBus?: import("../events/event-bus.js").EventBus;
}
