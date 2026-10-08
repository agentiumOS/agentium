import type { TokenUsage } from "../models/types.js";
import type {
  AccountingScope,
  AllocationMember,
  BillingContext,
  BudgetDecision,
  BudgetPolicy,
  PricingCatalog,
  ReportedCostInput,
  UsageQuery,
  UsageRecordInput,
} from "./accounting-types.js";
import { Decimal, nonnegativeDecimal } from "./decimal.js";
import { UsageLedger } from "./ledger.js";
import { lookupPricing } from "./pricing.js";
import type { CostBreakdown, CostBudget, CostEntry, CostSummary, CostTrackerConfig, ModelPricing } from "./types.js";

function emptyBreakdown(): CostBreakdown {
  return { input: 0, output: 0, reasoning: 0, cached: 0, audioInput: 0, audioOutput: 0, total: 0 };
}

function emptyTokens(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function addBreakdown(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cached: a.cached + b.cached,
    audioInput: a.audioInput + b.audioInput,
    audioOutput: a.audioOutput + b.audioOutput,
    total: a.total + b.total,
  };
}

function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0) || undefined,
    cachedTokens: (a.cachedTokens ?? 0) + (b.cachedTokens ?? 0) || undefined,
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0) || undefined,
    audioInputTokens: (a.audioInputTokens ?? 0) + (b.audioInputTokens ?? 0) || undefined,
    audioOutputTokens: (a.audioOutputTokens ?? 0) + (b.audioOutputTokens ?? 0) || undefined,
  };
}

export class CostTracker {
  private entries: CostEntry[] = [];
  private pricing: Record<string, ModelPricing>;
  private budget: CostBudget | undefined;
  private maxEntries = 10000;
  private readonly ledger: UsageLedger;
  private readonly inclusiveLegacy: boolean;
  private legacyTotals: CostEntry[] = [];
  private historyEvicted = false;
  private canonicalUsed = false;

  constructor(config?: CostTrackerConfig) {
    this.pricing = config?.pricing ?? {};
    this.budget = config?.budget && !("mode" in config.budget) ? config.budget : undefined;
    this.inclusiveLegacy = config?.legacyUsageSemantics === "inclusive";
    const canonicalBudget: BudgetPolicy | undefined =
      config?.budget && "mode" in config.budget
        ? config.budget
        : this.budget
          ? {
              mode: "threshold",
              onExceeded: this.budget.onBudgetExceeded ?? "throw",
              limits: [
                ...(this.budget.maxCostPerRun !== undefined
                  ? [
                      {
                        scope: "run" as const,
                        amount: String(this.budget.maxCostPerRun),
                        currency: "USD",
                        period: { start: "1970-01-01T00:00:00.000Z", end: "9999-01-01T00:00:00.000Z" },
                      },
                    ]
                  : []),
                ...(this.budget.maxCostPerSession !== undefined
                  ? [
                      {
                        scope: "session" as const,
                        amount: String(this.budget.maxCostPerSession),
                        currency: "USD",
                        period: { start: "1970-01-01T00:00:00.000Z", end: "9999-01-01T00:00:00.000Z" },
                      },
                    ]
                  : []),
                ...(this.budget.maxCostPerUser !== undefined
                  ? [
                      {
                        scope: "user" as const,
                        amount: String(this.budget.maxCostPerUser),
                        currency: "USD",
                        period: { start: "1970-01-01T00:00:00.000Z", end: "9999-01-01T00:00:00.000Z" },
                      },
                    ]
                  : []),
              ],
            }
          : undefined;
    this.ledger = new UsageLedger({
      catalog: config?.catalog,
      store: config?.store,
      budget: canonicalBudget,
      currency: config?.currency,
    });
  }

  track(entry: Omit<CostEntry, "cost" | "breakdown" | "timestamp">): CostEntry {
    const breakdown = this.calculateBreakdown(entry.modelId, entry.usage);
    const full: CostEntry = {
      ...entry,
      cost: breakdown.total,
      breakdown,
      timestamp: new Date(),
    };
    this.entries.push(full);
    this.legacyTotals.push(full);
    if (this.entries.length > this.maxEntries) {
      this.historyEvicted = true;
      this.entries = this.entries.slice(-this.maxEntries);
    }
    return full;
  }

  beginPendingAttempt(attemptId: string) {
    this.ledger.beginPendingAttempt(attemptId);
  }
  endPendingAttempt(attemptId: string) {
    this.ledger.endPendingAttempt(attemptId);
  }
  get currency(): string {
    return this.ledger.currency;
  }
  recordUsage(input: UsageRecordInput) {
    this.canonicalUsed = true;
    return this.ledger.recordUsage(input);
  }
  startAttempt(
    input: AccountingScope & {
      attemptId: string;
      operationId: string;
      context: BillingContext;
      attemptVisibility?: "physical" | "opaque";
    },
  ) {
    this.canonicalUsed = true;
    return this.ledger.startAttempt(input);
  }
  queryUsage(query: UsageQuery = {}) {
    return this.ledger.store.queryUsage(query);
  }
  queryCosts(query: UsageQuery = {}) {
    return this.ledger.store.queryCosts(query);
  }
  queryAssessments(query: UsageQuery & { selected?: boolean; targetId?: string } = {}) {
    return this.ledger.store.queryAssessments(query);
  }
  queryRunUsage(scope: AccountingScope) {
    return this.ledger.queryRunUsage(scope);
  }
  reprice(query: UsageQuery, catalog: PricingCatalog, view = "repriced") {
    return this.ledger.reprice(query, catalog, view);
  }
  recordReportedCost(input: ReportedCostInput, view?: string) {
    this.canonicalUsed = true;
    return this.ledger.recordReportedCost(input, view);
  }
  allocate(
    assessmentId: string,
    members: AllocationMember[],
    options: { tenantId?: string; policyVersion: string; view?: string },
  ) {
    return this.ledger.allocate(assessmentId, members, options);
  }
  queryAllocations(query: UsageQuery = {}) {
    return this.ledger.store.queryAllocations(query);
  }
  finalizeGroup(targetId: string, options: { tenantId?: string; view?: string; confirmedFinal: true }) {
    return this.ledger.finalizeGroup(targetId, options);
  }
  checkBudgetAfterUsage(scope: AccountingScope) {
    return this.ledger.checkBudgetAfterUsage(scope);
  }
  close() {
    return this.ledger.close();
  }
  flush() {
    return this.ledger.flush();
  }
  releaseReservation(tenantId: string, reservationId: string, confirmedNotAccepted: boolean) {
    return this.ledger.store.releaseReservation(tenantId, reservationId, confirmedNotAccepted);
  }
  checkBudget(
    scope: AccountingScope & { attemptId?: string; currency?: string },
    bound?: string,
  ): Promise<BudgetDecision>;
  checkBudget(runId: string, sessionId?: string, userId?: string): void;
  checkBudget(
    runId: string | (AccountingScope & { attemptId?: string; currency?: string }),
    sessionId?: string,
    userId?: string,
  ): undefined | Promise<BudgetDecision> {
    if (typeof runId !== "string")
      return (async () => {
        const decision = await this.ledger.checkBudget(runId, sessionId);
        if (decision.status === "blocked" || this.budget?.maxTokensPerRun === undefined || !runId.runId)
          return decision;
        const usage = await this.ledger.queryRunUsage(runId);
        if (usage.totalTokens < this.budget.maxTokensPerRun) return decision;
        if (decision.reservationId)
          await this.ledger.store.releaseReservation(runId.tenantId ?? "local", decision.reservationId, true);
        return {
          ...decision,
          status: this.budget.onBudgetExceeded === "warn" ? ("warned" as const) : ("blocked" as const),
          reason: "limit" as const,
          reservationId: undefined,
        };
      })();
    if (!this.budget) return;

    const mode = this.budget.onBudgetExceeded ?? "throw";

    if (this.budget.maxCostPerRun !== undefined) {
      const runCost = this.legacyTotals.filter((e) => e.runId === runId).reduce((sum, e) => sum + e.cost, 0);
      if (runCost >= this.budget.maxCostPerRun) {
        const msg = `Run budget exceeded: $${runCost.toFixed(4)} >= $${this.budget.maxCostPerRun}`;
        if (mode === "throw") throw new Error(msg);
        else console.warn(`[agentium/cost] ${msg}`);
      }
    }

    if (this.budget.maxTokensPerRun !== undefined) {
      const runTokens = this.legacyTotals
        .filter((e) => e.runId === runId)
        .reduce((sum, e) => sum + e.usage.totalTokens, 0);
      if (runTokens >= this.budget.maxTokensPerRun) {
        const msg = `Run token budget exceeded: ${runTokens} >= ${this.budget.maxTokensPerRun}`;
        if (mode === "throw") throw new Error(msg);
        else console.warn(`[agentium/cost] ${msg}`);
      }
    }

    if (this.budget.maxCostPerSession !== undefined && sessionId) {
      const sessionCost = this.legacyTotals
        .filter((e) => e.sessionId === sessionId)
        .reduce((sum, e) => sum + e.cost, 0);
      if (sessionCost >= this.budget.maxCostPerSession) {
        const msg = `Session budget exceeded: $${sessionCost.toFixed(4)} >= $${this.budget.maxCostPerSession}`;
        if (mode === "throw") throw new Error(msg);
        else console.warn(`[agentium/cost] ${msg}`);
      }
    }

    if (this.budget.maxCostPerUser !== undefined && userId) {
      const userCost = this.legacyTotals.filter((e) => e.userId === userId).reduce((sum, e) => sum + e.cost, 0);
      if (userCost >= this.budget.maxCostPerUser) {
        const msg = `User budget exceeded: $${userCost.toFixed(4)} >= $${this.budget.maxCostPerUser}`;
        if (mode === "throw") throw new Error(msg);
        else console.warn(`[agentium/cost] ${msg}`);
      }
    }
  }

  getSummary(filter?: { agentName?: string; userId?: string; since?: Date }): CostSummary {
    if (this.canonicalUsed)
      throw new IncompleteCostError(
        "Canonical accounting requires queryCosts; synchronous summaries cover only legacy local entries",
      );
    if (this.historyEvicted)
      throw new IncompleteCostError("Local display history was evicted; use queryCosts for ledger history");
    let filtered = this.entries;

    if (filter?.agentName) {
      filtered = filtered.filter((e) => e.agentName === filter.agentName);
    }
    if (filter?.userId) {
      filtered = filtered.filter((e) => e.userId === filter.userId);
    }
    if (filter?.since) {
      const since = filter.since.getTime();
      filtered = filtered.filter((e) => e.timestamp.getTime() >= since);
    }

    let totalTokens = emptyTokens();
    let totalBreakdown = emptyBreakdown();
    const byAgent: CostSummary["byAgent"] = {};
    const byModel: CostSummary["byModel"] = {};
    const byUser: CostSummary["byUser"] = {};
    let totalCost = 0;

    for (const entry of filtered) {
      totalCost += entry.cost;
      totalTokens = addTokens(totalTokens, entry.usage);
      totalBreakdown = addBreakdown(totalBreakdown, entry.breakdown);

      if (!byAgent[entry.agentName]) {
        byAgent[entry.agentName] = { cost: 0, breakdown: emptyBreakdown(), tokens: emptyTokens(), runs: 0 };
      }
      byAgent[entry.agentName].cost += entry.cost;
      byAgent[entry.agentName].breakdown = addBreakdown(byAgent[entry.agentName].breakdown, entry.breakdown);
      byAgent[entry.agentName].tokens = addTokens(byAgent[entry.agentName].tokens, entry.usage);
      byAgent[entry.agentName].runs++;

      if (!byModel[entry.modelId]) {
        byModel[entry.modelId] = { cost: 0, breakdown: emptyBreakdown(), tokens: emptyTokens() };
      }
      byModel[entry.modelId].cost += entry.cost;
      byModel[entry.modelId].breakdown = addBreakdown(byModel[entry.modelId].breakdown, entry.breakdown);
      byModel[entry.modelId].tokens = addTokens(byModel[entry.modelId].tokens, entry.usage);

      if (entry.userId) {
        if (!byUser[entry.userId]) {
          byUser[entry.userId] = { cost: 0, breakdown: emptyBreakdown(), tokens: emptyTokens() };
        }
        byUser[entry.userId].cost += entry.cost;
        byUser[entry.userId].breakdown = addBreakdown(byUser[entry.userId].breakdown, entry.breakdown);
        byUser[entry.userId].tokens = addTokens(byUser[entry.userId].tokens, entry.usage);
      }
    }

    return { totalCost, totalTokens, totalBreakdown, entries: filtered.length, byAgent, byModel, byUser };
  }

  /**
   * Check budget using in-progress (cumulative) usage without persisting an entry.
   * Called during multi-roundtrip runs (e.g. tool calling) to enforce limits mid-run.
   */
  checkInProgressBudget(
    modelId: string,
    cumulativeUsage: TokenUsage,
    runId?: string,
    sessionId?: string,
    userId?: string,
  ): boolean {
    if (!this.budget || this.budget.onBudgetExceeded === "warn") return false;

    const inProgressCost = this.calculateBreakdown(modelId, cumulativeUsage).total;
    const persistedRunCost = runId
      ? this.legacyTotals.filter((e) => e.runId === runId).reduce((sum, e) => sum + e.cost, 0)
      : 0;
    const totalRunCost = persistedRunCost + inProgressCost;

    if (this.budget.maxCostPerRun !== undefined && totalRunCost >= this.budget.maxCostPerRun) return true;

    if (this.budget.maxTokensPerRun !== undefined) {
      const persistedTokens = runId
        ? this.legacyTotals.filter((e) => e.runId === runId).reduce((sum, e) => sum + e.usage.totalTokens, 0)
        : 0;
      if (persistedTokens + cumulativeUsage.totalTokens >= this.budget.maxTokensPerRun) return true;
    }

    if (this.budget.maxCostPerSession !== undefined && sessionId) {
      const sessionCost = this.legacyTotals
        .filter((e) => e.sessionId === sessionId)
        .reduce((sum, e) => sum + e.cost, 0);
      if (sessionCost + inProgressCost >= this.budget.maxCostPerSession) return true;
    }

    if (this.budget.maxCostPerUser !== undefined && userId) {
      const userCost = this.legacyTotals.filter((e) => e.userId === userId).reduce((sum, e) => sum + e.cost, 0);
      if (userCost + inProgressCost >= this.budget.maxCostPerUser) return true;
    }

    return false;
  }

  /** @deprecated Use checkInProgressBudget for mid-run checks. This now delegates to it. */
  isBudgetExceeded(runId: string, sessionId?: string, userId?: string): boolean {
    if (!this.budget || this.budget.onBudgetExceeded === "warn") return false;

    if (this.budget.maxCostPerRun !== undefined) {
      const runCost = this.legacyTotals.filter((e) => e.runId === runId).reduce((sum, e) => sum + e.cost, 0);
      if (runCost >= this.budget.maxCostPerRun) return true;
    }

    if (this.budget.maxTokensPerRun !== undefined) {
      const runTokens = this.legacyTotals
        .filter((e) => e.runId === runId)
        .reduce((sum, e) => sum + e.usage.totalTokens, 0);
      if (runTokens >= this.budget.maxTokensPerRun) return true;
    }

    if (this.budget.maxCostPerSession !== undefined && sessionId) {
      const sessionCost = this.legacyTotals
        .filter((e) => e.sessionId === sessionId)
        .reduce((sum, e) => sum + e.cost, 0);
      if (sessionCost >= this.budget.maxCostPerSession) return true;
    }

    if (this.budget.maxCostPerUser !== undefined && userId) {
      const userCost = this.legacyTotals.filter((e) => e.userId === userId).reduce((sum, e) => sum + e.cost, 0);
      if (userCost >= this.budget.maxCostPerUser) return true;
    }

    return false;
  }

  estimateRemaining(runId: string): { costRemaining: number | null; tokensRemaining: number | null } {
    if (!this.budget) return { costRemaining: null, tokensRemaining: null };

    const runEntries = this.legacyTotals.filter((e) => e.runId === runId);
    const runCost = runEntries.reduce((sum, e) => sum + e.cost, 0);
    const runTokens = runEntries.reduce((sum, e) => sum + e.usage.totalTokens, 0);

    return {
      costRemaining: this.budget.maxCostPerRun != null ? this.budget.maxCostPerRun - runCost : null,
      tokensRemaining: this.budget.maxTokensPerRun != null ? this.budget.maxTokensPerRun - runTokens : null,
    };
  }

  getEntries(): readonly CostEntry[] {
    if (this.canonicalUsed)
      throw new IncompleteCostError(
        "Canonical accounting requires queryUsage or queryAssessments; getEntries is a legacy local snapshot",
      );
    return this.entries;
  }

  reset(): void {
    this.entries = [];
    this.legacyTotals = [];
    this.historyEvicted = false;
  }

  private calculateBreakdown(modelId: string, usage: TokenUsage): CostBreakdown {
    const pricing = lookupPricing(usage.pricingKey ?? modelId, this.pricing);
    if (!pricing)
      throw new IncompleteCostError(`No exact legacy tariff for ${modelId}; use recordUsage and queryCosts`);
    const read = usage.cachedTokens ?? 0;
    const write = usage.cacheWriteTokens ?? 0;
    for (const quantity of [
      usage.promptTokens,
      usage.completionTokens,
      usage.totalTokens,
      read,
      write,
      usage.reasoningTokens ?? 0,
    ])
      if (!Number.isSafeInteger(quantity) || quantity < 0)
        throw new LegacyUsageError("Token counts must be nonnegative safe integers");
    if (usage.audioInputTokens || usage.audioOutputTokens)
      throw new LegacyUsageError(
        "Legacy audio/cache marginals do not establish a billing partition; use canonical measurements",
      );
    if (!this.inclusiveLegacy && !usage.accounting && (read > 0 || write > 0 || (usage.reasoningTokens ?? 0) > 0))
      throw new LegacyUsageError("Set legacyUsageSemantics: inclusive or provide canonical accounting usage");
    if (read + write > usage.promptTokens || (usage.reasoningTokens ?? 0) > usage.completionTokens)
      throw new LegacyUsageError("Legacy usage subsets exceed their inclusive totals");
    if (usage.totalTokens !== usage.promptTokens + usage.completionTokens)
      throw new LegacyUsageError("Legacy totalTokens must equal inclusive input plus output");
    if (read > 0 && pricing.cachedPromptPer1k === undefined)
      throw new IncompleteCostError("Cache-read rate is missing");
    if (write > 0 && pricing.cacheWritePer1k === undefined)
      throw new IncompleteCostError("Cache-write rate is missing");
    const price = (quantity: number, rate: number) =>
      Number(
        nonnegativeDecimal(String(quantity))
          .multiply(nonnegativeDecimal(String(rate)))
          .divide(Decimal.from("1000"))
          .toString(),
      );
    const input = price(usage.promptTokens - read - write, pricing.promptPer1k);
    const output = price(usage.completionTokens, pricing.completionPer1k);
    const cached = price(read, pricing.cachedPromptPer1k ?? 0) + price(write, pricing.cacheWritePer1k ?? 0);
    return { input, output, reasoning: 0, cached, audioInput: 0, audioOutput: 0, total: input + output + cached };
  }
}
export class IncompleteCostError extends Error {
  readonly code = "COST_INCOMPLETE";
  constructor(message: string) {
    super(message);
    this.name = "IncompleteCostError";
  }
}
export class LegacyUsageError extends Error {
  readonly code = "COST_LEGACY_USAGE_AMBIGUOUS";
  constructor(message: string) {
    super(message);
    this.name = "LegacyUsageError";
  }
}
