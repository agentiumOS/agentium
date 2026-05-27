import type { ChatMessage } from "../models/types.js";
import { SessionManager } from "../session/session-manager.js";
import type { Session } from "../session/types.js";
import type { ToolDef } from "../tools/types.js";
import { countTokens } from "../utils/token-counter.js";
import { Curator } from "./curator.js";
import type {
  ContextBudgetConfig,
  DecisionConfig,
  EntityConfig,
  ProceduresConfig,
  SummaryConfig,
  UnifiedMemoryConfig,
  UserFactsConfig,
  UserProfileConfig,
} from "./memory-config.js";
import type { ScoredMemory } from "./scoring.js";
import { computeCompositeScore } from "./scoring.js";
import { DecisionLog } from "./stores/decision-log.js";
import { EntityMemory } from "./stores/entity-memory.js";
import { GraphMemory } from "./stores/graph-memory.js";
import { LearnedKnowledge } from "./stores/learned-knowledge.js";
import { ProcedureMemory } from "./stores/procedure-memory.js";
import { Summaries } from "./stores/summaries.js";
import { UserFacts } from "./stores/user-facts.js";
import { UserProfile } from "./stores/user-profile.js";

export class MemoryManager {
  readonly sessionManager: SessionManager;
  readonly curator: Curator;

  private summaries: Summaries | null = null;
  private userFacts: UserFacts | null = null;
  private userProfile: UserProfile | null = null;
  private entityMemory: EntityMemory | null = null;
  private decisionLog: DecisionLog | null = null;
  private learnedKnowledge: LearnedKnowledge | null = null;
  private graphMemory: GraphMemory | null = null;
  private procedureMemory: ProcedureMemory | null = null;

  private config: UnifiedMemoryConfig;
  private contextBudget: ContextBudgetConfig | null = null;
  private storageInitPromise: Promise<void> | null = null;
  private pendingExtractions: Set<Promise<unknown>> = new Set();

  constructor(config: UnifiedMemoryConfig) {
    this.config = config;
    const storage = config.storage;

    if (typeof (storage as any).initialize === "function") {
      this.storageInitPromise = (storage as any).initialize();
    }

    this.sessionManager = new SessionManager(storage, {
      maxMessages: config.maxMessages ?? 50,
    });

    const summaryConfig = resolveFeatureConfig<SummaryConfig>(config.summaries, true);
    if (summaryConfig) {
      this.summaries = new Summaries(storage, {
        model: config.model,
        maxCount: summaryConfig.maxCount,
        maxTokens: summaryConfig.maxTokens,
      });
    }

    const userFactsConfig = resolveFeatureConfig<UserFactsConfig>(config.userFacts, false);
    if (userFactsConfig) {
      this.userFacts = new UserFacts(storage, {
        model: config.model,
        maxFacts: userFactsConfig.maxFacts,
      });
    }

    const userProfileConfig = resolveFeatureConfig<UserProfileConfig>(config.userProfile, false);
    if (userProfileConfig) {
      this.userProfile = new UserProfile(storage, {
        model: config.model,
        customFields: userProfileConfig.customFields,
      });
    }

    const entityConfig = resolveFeatureConfig<EntityConfig>(config.entities, false);
    if (entityConfig) {
      this.entityMemory = new EntityMemory(storage, {
        model: config.model,
        namespace: entityConfig.namespace,
      });
    }

    const decisionConfig = resolveFeatureConfig<DecisionConfig>(config.decisions, false);
    if (decisionConfig) {
      this.decisionLog = new DecisionLog(storage, {
        maxContextDecisions: decisionConfig.maxContextDecisions,
      });
    }

    if (config.learnings) {
      this.learnedKnowledge = new LearnedKnowledge(config.learnings.vectorStore, storage, {
        model: config.model,
        collection: config.learnings.collection,
        topK: config.learnings.topK,
      });
    }

    if (config.graph) {
      this.graphMemory = new GraphMemory({
        graphStore: config.graph.store,
        model: config.model,
        autoExtract: config.graph.autoExtract,
        maxContextNodes: config.graph.maxContextNodes,
      });
    }

    const proceduresConfig = resolveFeatureConfig<ProceduresConfig>(config.procedures, false);
    if (proceduresConfig) {
      this.procedureMemory = new ProcedureMemory(storage, {
        model: config.model,
        maxProcedures: proceduresConfig.maxProcedures,
      });
    }

    if (config.contextBudget) {
      this.contextBudget = config.contextBudget;
    }

    this.curator = new Curator(storage, {
      userFacts: this.userFacts,
      userProfile: this.userProfile,
      entityMemory: this.entityMemory,
      decisionLog: this.decisionLog,
      learnedKnowledge: this.learnedKnowledge,
    });
  }

  async ensureReady(): Promise<void> {
    if (this.storageInitPromise) await this.storageInitPromise;
    if (this.graphMemory) await this.graphMemory.initialize();
  }

  // ── Session delegation ────────────────────────────────────────────────

  async getOrCreateSession(sessionId: string, userId?: string): Promise<Session> {
    await this.ensureReady();
    return this.sessionManager.getOrCreate(sessionId, userId);
  }

  async appendMessages(
    sessionId: string,
    messages: ChatMessage[],
    agentModel?: import("../models/provider.js").ModelProvider,
  ): Promise<{ overflow: ChatMessage[] }> {
    const { overflow } = await this.sessionManager.appendMessages(sessionId, messages);

    if (this.summaries && overflow.length > 0) {
      this.summaries
        .summarize(sessionId, overflow, agentModel ?? this.config.model)
        .catch((e) => console.warn("[MemoryManager] Summary failed:", e));
    }

    return { overflow };
  }

  async getHistory(sessionId: string, limit?: number): Promise<ChatMessage[]> {
    return this.sessionManager.getHistory(sessionId, limit);
  }

  async updateState(sessionId: string, patch: Record<string, unknown>): Promise<void> {
    return this.sessionManager.updateState(sessionId, patch);
  }

  // ── Context building (with token budget) ───────────────────────────────

  async buildContext(sessionId: string, userId?: string, currentInput?: string, agentName?: string): Promise<string> {
    const sections: Array<{ key: string; content: string; priority: number }> = [];

    const defaultPriorities: Record<string, number> = {
      summaries: 0.25,
      userProfile: 0.15,
      userFacts: 0.15,
      entities: 0.15,
      graph: 0.1,
      decisions: 0.1,
      learnings: 0.05,
      procedures: 0.05,
    };
    const priorities = { ...defaultPriorities, ...this.contextBudget?.priorities };

    if (this.summaries) {
      const ctx = await this.summaries.getContextString(sessionId, currentInput);
      if (ctx) sections.push({ key: "summaries", content: ctx, priority: priorities.summaries ?? 0.25 });
    }

    if (this.userProfile && userId) {
      const ctx = await this.userProfile.getContextString(userId);
      if (ctx) sections.push({ key: "userProfile", content: ctx, priority: priorities.userProfile ?? 0.15 });
    }

    if (this.userFacts && userId) {
      const ctx = await this.userFacts.getContextString(userId);
      if (ctx) sections.push({ key: "userFacts", content: ctx, priority: priorities.userFacts ?? 0.15 });
    }

    if (this.entityMemory) {
      const ctx = await this.entityMemory.getContextString(userId, currentInput);
      if (ctx) sections.push({ key: "entities", content: ctx, priority: priorities.entities ?? 0.15 });
    }

    if (this.graphMemory) {
      const ctx = await this.graphMemory.getContextString(currentInput, userId);
      if (ctx) sections.push({ key: "graph", content: ctx, priority: priorities.graph ?? 0.1 });
    }

    if (this.decisionLog && agentName) {
      const ctx = await this.decisionLog.getContextString(agentName, sessionId);
      if (ctx) sections.push({ key: "decisions", content: ctx, priority: priorities.decisions ?? 0.1 });
    }

    if (this.learnedKnowledge && currentInput) {
      const ctx = await this.learnedKnowledge.getContextString(currentInput, userId);
      if (ctx) sections.push({ key: "learnings", content: ctx, priority: priorities.learnings ?? 0.05 });
    }

    if (this.procedureMemory && currentInput) {
      const ctx = await this.procedureMemory.getContextString(currentInput, userId);
      if (ctx) sections.push({ key: "procedures", content: ctx, priority: priorities.procedures ?? 0.05 });
    }

    if (sections.length === 0) return "";

    const maxBudget = this.contextBudget?.maxTokens;
    const assembled = maxBudget ? this.allocateBudget(sections, maxBudget) : this.assemble(sections);
    return assembled;
  }

  /**
   * Wraps each section in an explicit scope marker so the LLM doesn't
   * conflate different memory sources or treat other-user/other-session data
   * as authoritative for the current turn.
   */
  private assemble(sections: Array<{ key: string; content: string; priority: number }>): string {
    // Stable, priority-desc order so dev (no budget) and prod (with budget)
    // produce the same prompt layout.
    const ordered = [...sections].sort((a, b) => b.priority - a.priority);
    return ordered
      .map((s) => `<memory section="${s.key}" scope="current_user">\n${s.content}\n</memory>`)
      .join("\n\n");
  }

  private allocateBudget(
    sections: Array<{ key: string; content: string; priority: number }>,
    maxTokens: number,
  ): string {
    const totalPriority = sections.reduce((sum, s) => sum + s.priority, 0);
    const allocated = sections.map((s) => ({
      ...s,
      budget: Math.floor((s.priority / totalPriority) * maxTokens),
      tokens: countTokens(s.content),
    }));

    const totalTokens = allocated.reduce((sum, s) => sum + s.tokens, 0);

    if (totalTokens <= maxTokens) {
      return allocated.map((s) => s.content).join("\n\n");
    }

    allocated.sort((a, b) => a.priority - b.priority);

    let remaining = maxTokens;
    const included: typeof allocated = [];

    for (const section of [...allocated].reverse()) {
      if (section.tokens <= remaining) {
        included.push(section);
        remaining -= section.tokens;
      } else if (remaining > 50) {
        // For time-ordered sections (summaries, decisions, entity lists),
        // keeping the FIRST lines drops the freshest content. Walk from the
        // bottom (most recent) instead so we keep the latest info first.
        const lines = section.content.split("\n");
        // The header (first non-bullet line, e.g. "Recent decisions:") should
        // always be kept; trim from the bottom of the data lines.
        const headerLines: string[] = [];
        let i = 0;
        while (i < lines.length && !lines[i].trimStart().startsWith("- ")) {
          headerLines.push(lines[i]);
          i++;
        }
        const dataLines = lines.slice(i);
        const headerStr = headerLines.join("\n");
        const headerTokens = countTokens(headerStr);
        let trimmed = headerStr;
        let used = headerTokens;
        // Walk newest-first (assuming the list is oldest→newest, reverse).
        for (const line of [...dataLines].reverse()) {
          const candidate = trimmed ? `${trimmed}\n${line}` : line;
          const tk = countTokens(candidate);
          if (tk > remaining) break;
          trimmed = candidate;
          used = tk;
        }
        if (trimmed && trimmed !== headerStr) {
          included.push({ ...section, content: trimmed });
          remaining -= used;
        }
      }
    }

    included.sort((a, b) => b.priority - a.priority);
    return included
      .map((s) => `<memory section="${s.key}" scope="current_user">\n${s.content}\n</memory>`)
      .join("\n\n");
  }

  // ── After-run extraction (fire-and-forget) ────────────────────────────

  /**
   * Runs every background memory extraction (user facts, profile, entities,
   * learnings, graph, procedures).
   *
   * Returns a Promise that resolves once every extraction has completed. The
   * Agent fires this without awaiting (to keep run() latency low), but callers
   * that need to inspect memory immediately after a turn can `await` it.
   */
  afterRun(
    _sessionId: string,
    userId: string | undefined,
    messages: ChatMessage[],
    agentModel?: import("../models/provider.js").ModelProvider,
    agentName?: string,
    /** IANA timezone for date-anchored extraction. Falls back to UTC. */
    timezone?: string,
  ): Promise<void> {
    const model = this.config.model ?? agentModel;
    const tasks: Promise<unknown>[] = [];
    const tz = timezone ?? this.config.timezone;
    const eventBus = this.config.eventBus;
    const emitError = (store: string, error: unknown) => {
      const err = error instanceof Error ? error : new Error(String(error));
      console.warn(`[MemoryManager] ${store} extraction failed:`, err.message);
      // Surface the failure to observability — silent failures are how memory
      // appears empty after a turn that should have written facts.
      eventBus?.emit("memory.error", { store, error: err, agentName: agentName ?? "" });
    };

    if (this.userFacts && userId) {
      tasks.push(
        this.userFacts.extractAndStore(userId, messages, model, tz).catch((e) => emitError("userFacts", e)),
      );
    }

    if (this.userProfile && userId) {
      tasks.push(
        this.userProfile.extractAndUpdate(userId, messages, model).catch((e) => emitError("userProfile", e)),
      );
    }

    if (this.entityMemory) {
      tasks.push(
        this.entityMemory.extractEntities(userId, messages, model).catch((e) => emitError("entityMemory", e)),
      );
    }

    if (this.learnedKnowledge) {
      tasks.push(
        this.learnedKnowledge.extractLearnings(messages, model, userId).catch((e) => emitError("learnedKnowledge", e)),
      );
    }

    if (this.graphMemory) {
      tasks.push(
        this.graphMemory
          .extractFromConversation(userId, messages, model)
          .catch((e) => emitError("graphMemory", e)),
      );
    }

    if (this.procedureMemory) {
      tasks.push(
        this.procedureMemory
          .extractProcedures(userId, messages, model)
          .catch((e) => emitError("procedureMemory", e)),
      );
    }

    const combined = Promise.all(tasks).then(() => undefined);
    this.pendingExtractions.add(combined);
    combined.finally(() => this.pendingExtractions.delete(combined));
    return combined;
  }

  /**
   * Wait for every in-flight background extraction (user facts, profile,
   * entities, learnings, graph, procedures) to settle.
   *
   * Useful in tests, demos, and graceful-shutdown paths where you want to be
   * sure all extractions for prior turns are persisted before reading or
   * exiting. Normal agent.run() callers do NOT need this — extraction runs in
   * the background and is best-effort.
   */
  async awaitExtractions(): Promise<void> {
    while (this.pendingExtractions.size > 0) {
      await Promise.allSettled([...this.pendingExtractions]);
    }
  }

  // ── Simplified API ────────────────────────────────────────────────────

  /**
   * Store a piece of information. Dispatches to the appropriate store based on context:
   * user-scoped facts when userId is provided, entities otherwise.
   */
  async remember(content: string, opts?: { userId?: string; scope?: string; importance?: number }): Promise<void> {
    await this.ensureReady();

    if (opts?.userId && this.userFacts) {
      await this.userFacts.addFacts(
        opts.userId,
        [{ fact: content, topics: [], importance: opts.importance }],
        "manual",
      );
      return;
    }

    if (this.learnedKnowledge) {
      await this.learnedKnowledge.saveLearning({
        title: content.slice(0, 60),
        content,
        context: opts?.scope ?? "general",
        tags: [],
        namespace: opts?.scope ?? "global",
        userId: opts?.userId,
      });
      return;
    }

    if (this.entityMemory && opts?.userId) {
      await this.entityMemory.addFact(opts.userId, "_manual", content);
    }
  }

  /**
   * Recall memories matching a query. Searches across all enabled stores,
   * applies composite scoring, and returns ranked results.
   */
  async recall(query: string, opts?: { userId?: string; topK?: number; scope?: string }): Promise<ScoredMemory[]> {
    await this.ensureReady();
    const topK = opts?.topK ?? 10;
    const results: ScoredMemory[] = [];

    if (this.userFacts && opts?.userId) {
      const facts = await this.userFacts.getActiveFacts(opts.userId);
      for (const f of facts) {
        const qLower = query.toLowerCase();
        const semantic = f.fact.toLowerCase().includes(qLower) ? 0.8 : 0.2;
        results.push({
          content: f.fact,
          score: computeCompositeScore({
            semanticSimilarity: semantic,
            createdAt: f.createdAt,
            importance: f.importance,
          }),
          source: "userFacts",
        });
      }
    }

    if (this.entityMemory && opts?.userId) {
      const entities = await this.entityMemory.listEntities(opts.userId);
      for (const e of entities) {
        const qLower = query.toLowerCase();
        const nameMatch = e.name.toLowerCase().includes(qLower);
        if (!nameMatch) continue;
        const activeFacts = (e.facts ?? []).filter((f) => !f.invalidatedAt);
        const content = `${e.name} (${e.entityType}): ${activeFacts.map((f) => f.fact).join("; ")}`;
        results.push({
          content,
          score: computeCompositeScore({
            semanticSimilarity: nameMatch ? 0.9 : 0.3,
            createdAt: e.createdAt,
          }),
          source: "entities",
        });
      }
    }

    if (this.learnedKnowledge) {
      try {
        const learnings = await this.learnedKnowledge.searchLearnings(query, topK);
        for (const l of learnings) {
          results.push({
            content: `${l.title}: ${l.content}`,
            score: computeCompositeScore({
              semanticSimilarity: 0.7,
              createdAt: l.createdAt,
              importance: l.importance,
            }),
            source: "learnings",
          });
        }
      } catch {}
    }

    if (this.graphMemory) {
      try {
        const nodes = await this.graphMemory.getStore().search(query, { limit: 5 });
        for (const n of nodes) {
          const propsStr = Object.entries(n.properties)
            .filter(([, v]) => v != null)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ");
          results.push({
            content: `${n.name} (${n.type})${propsStr ? ` — ${propsStr}` : ""}`,
            score: computeCompositeScore({
              semanticSimilarity: 0.75,
              createdAt: n.createdAt,
            }),
            source: "graph",
          });
        }
      } catch {}
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  /**
   * Remove memories matching the given criteria. Returns count of items removed.
   */
  async forget(opts: { userId?: string; factId?: string; entityId?: string; scope?: string }): Promise<number> {
    await this.ensureReady();
    let removed = 0;

    if (opts.factId && opts.userId && this.userFacts) {
      await this.userFacts.removeFact(opts.userId, opts.factId);
      removed++;
    }

    if (opts.entityId && opts.userId && this.entityMemory) {
      await this.entityMemory.deleteEntity(opts.userId, opts.entityId);
      removed++;
    }

    if (opts.userId && !opts.factId && !opts.entityId) {
      if (this.userFacts) {
        await this.userFacts.clear(opts.userId);
        removed++;
      }
      if (this.userProfile) {
        await this.userProfile.clear(opts.userId);
        removed++;
      }
    }

    return removed;
  }

  // ── Tool collection ───────────────────────────────────────────────────

  getTools(): ToolDef[] {
    const tools: ToolDef[] = [];

    if (this.entityMemory) {
      tools.push(...this.entityMemory.getTools());
    }

    if (this.decisionLog) {
      tools.push(...this.decisionLog.getTools());
    }

    if (this.learnedKnowledge) {
      tools.push(...this.learnedKnowledge.getTools());
    }

    if (this.graphMemory) {
      tools.push(...this.graphMemory.getTools());
    }

    if (this.procedureMemory) {
      tools.push(...this.procedureMemory.getTools());
    }

    return tools;
  }

  // ── Accessors for direct store access ─────────────────────────────────

  getUserFacts(): UserFacts | null {
    return this.userFacts;
  }

  getUserProfile(): UserProfile | null {
    return this.userProfile;
  }

  getEntityMemory(): EntityMemory | null {
    return this.entityMemory;
  }

  getDecisionLog(): DecisionLog | null {
    return this.decisionLog;
  }

  getLearnedKnowledge(): LearnedKnowledge | null {
    return this.learnedKnowledge;
  }

  getSummaries(): Summaries | null {
    return this.summaries;
  }

  getGraphMemory(): GraphMemory | null {
    return this.graphMemory;
  }

  getProcedureMemory(): ProcedureMemory | null {
    return this.procedureMemory;
  }

  getMaxTokens(): number | undefined {
    return this.config.maxTokens;
  }

  getMaxMessages(): number {
    return this.config.maxMessages ?? 50;
  }
}

function resolveFeatureConfig<T>(value: boolean | T | undefined, defaultEnabled: boolean): T | null {
  if (value === false) return null;
  if (value === true || (value === undefined && defaultEnabled)) return {} as T;
  if (value === undefined) return null;
  return value;
}
