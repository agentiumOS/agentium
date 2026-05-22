import type { TokenUsage } from "../models/types.js";
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
    audioInputTokens: (a.audioInputTokens ?? 0) + (b.audioInputTokens ?? 0) || undefined,
    audioOutputTokens: (a.audioOutputTokens ?? 0) + (b.audioOutputTokens ?? 0) || undefined,
  };
}

export class CostTracker {
  private entries: CostEntry[] = [];
  private pricing: Record<string, ModelPricing>;
  private budget: CostBudget | undefined;
  private maxEntries = 10000;

  constructor(config?: CostTrackerConfig) {
    this.pricing = config?.pricing ?? {};
    this.budget = config?.budget;
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
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
    return full;
  }

  checkBudget(runId: string, sessionId?: string, userId?: string): void {
    if (!this.budget) return;

    const mode = this.budget.onBudgetExceeded ?? "throw";

    if (this.budget.maxCostPerRun) {
      const runCost = this.entries.filter((e) => e.runId === runId).reduce((sum, e) => sum + e.cost, 0);
      if (runCost >= this.budget.maxCostPerRun) {
        const msg = `Run budget exceeded: $${runCost.toFixed(4)} >= $${this.budget.maxCostPerRun}`;
        if (mode === "throw") throw new Error(msg);
        else console.warn(`[agentium/cost] ${msg}`);
      }
    }

    if (this.budget.maxTokensPerRun) {
      const runTokens = this.entries.filter((e) => e.runId === runId).reduce((sum, e) => sum + e.usage.totalTokens, 0);
      if (runTokens >= this.budget.maxTokensPerRun) {
        const msg = `Run token budget exceeded: ${runTokens} >= ${this.budget.maxTokensPerRun}`;
        if (mode === "throw") throw new Error(msg);
        else console.warn(`[agentium/cost] ${msg}`);
      }
    }

    if (this.budget.maxCostPerSession && sessionId) {
      const sessionCost = this.entries.filter((e) => e.sessionId === sessionId).reduce((sum, e) => sum + e.cost, 0);
      if (sessionCost >= this.budget.maxCostPerSession) {
        const msg = `Session budget exceeded: $${sessionCost.toFixed(4)} >= $${this.budget.maxCostPerSession}`;
        if (mode === "throw") throw new Error(msg);
        else console.warn(`[agentium/cost] ${msg}`);
      }
    }

    if (this.budget.maxCostPerUser && userId) {
      const userCost = this.entries.filter((e) => e.userId === userId).reduce((sum, e) => sum + e.cost, 0);
      if (userCost >= this.budget.maxCostPerUser) {
        const msg = `User budget exceeded: $${userCost.toFixed(4)} >= $${this.budget.maxCostPerUser}`;
        if (mode === "throw") throw new Error(msg);
        else console.warn(`[agentium/cost] ${msg}`);
      }
    }
  }

  getSummary(filter?: { agentName?: string; userId?: string; since?: Date }): CostSummary {
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
    if (!this.budget) return false;

    const inProgressCost = this.calculateBreakdown(modelId, cumulativeUsage).total;
    const persistedRunCost = runId
      ? this.entries.filter((e) => e.runId === runId).reduce((sum, e) => sum + e.cost, 0)
      : 0;
    const totalRunCost = persistedRunCost + inProgressCost;

    if (this.budget.maxCostPerRun && totalRunCost >= this.budget.maxCostPerRun) return true;

    if (this.budget.maxTokensPerRun) {
      const persistedTokens = runId
        ? this.entries.filter((e) => e.runId === runId).reduce((sum, e) => sum + e.usage.totalTokens, 0)
        : 0;
      if (persistedTokens + cumulativeUsage.totalTokens >= this.budget.maxTokensPerRun) return true;
    }

    if (this.budget.maxCostPerSession && sessionId) {
      const sessionCost = this.entries.filter((e) => e.sessionId === sessionId).reduce((sum, e) => sum + e.cost, 0);
      if (sessionCost + inProgressCost >= this.budget.maxCostPerSession) return true;
    }

    if (this.budget.maxCostPerUser && userId) {
      const userCost = this.entries.filter((e) => e.userId === userId).reduce((sum, e) => sum + e.cost, 0);
      if (userCost + inProgressCost >= this.budget.maxCostPerUser) return true;
    }

    return false;
  }

  /** @deprecated Use checkInProgressBudget for mid-run checks. This now delegates to it. */
  isBudgetExceeded(runId: string, sessionId?: string, userId?: string): boolean {
    if (!this.budget) return false;

    if (this.budget.maxCostPerRun) {
      const runCost = this.entries.filter((e) => e.runId === runId).reduce((sum, e) => sum + e.cost, 0);
      if (runCost >= this.budget.maxCostPerRun) return true;
    }

    if (this.budget.maxTokensPerRun) {
      const runTokens = this.entries.filter((e) => e.runId === runId).reduce((sum, e) => sum + e.usage.totalTokens, 0);
      if (runTokens >= this.budget.maxTokensPerRun) return true;
    }

    if (this.budget.maxCostPerSession && sessionId) {
      const sessionCost = this.entries.filter((e) => e.sessionId === sessionId).reduce((sum, e) => sum + e.cost, 0);
      if (sessionCost >= this.budget.maxCostPerSession) return true;
    }

    if (this.budget.maxCostPerUser && userId) {
      const userCost = this.entries.filter((e) => e.userId === userId).reduce((sum, e) => sum + e.cost, 0);
      if (userCost >= this.budget.maxCostPerUser) return true;
    }

    return false;
  }

  estimateRemaining(runId: string): { costRemaining: number | null; tokensRemaining: number | null } {
    if (!this.budget) return { costRemaining: null, tokensRemaining: null };

    const runEntries = this.entries.filter((e) => e.runId === runId);
    const runCost = runEntries.reduce((sum, e) => sum + e.cost, 0);
    const runTokens = runEntries.reduce((sum, e) => sum + e.usage.totalTokens, 0);

    return {
      costRemaining: this.budget.maxCostPerRun != null ? this.budget.maxCostPerRun - runCost : null,
      tokensRemaining: this.budget.maxTokensPerRun != null ? this.budget.maxTokensPerRun - runTokens : null,
    };
  }

  getEntries(): readonly CostEntry[] {
    return this.entries;
  }

  reset(): void {
    this.entries = [];
  }

  private calculateBreakdown(modelId: string, usage: TokenUsage): CostBreakdown {
    const p = lookupPricing(modelId, this.pricing);
    if (!p) return emptyBreakdown();

    const cachedTokens = usage.cachedTokens ?? 0;
    // Non-cached prompt tokens: total prompt minus cached portion
    const nonCachedPrompt = Math.max(0, usage.promptTokens - cachedTokens);

    const input = (nonCachedPrompt / 1000) * p.promptPer1k;
    const output = (usage.completionTokens / 1000) * p.completionPer1k;
    const reasoning = usage.reasoningTokens && p.reasoningPer1k ? (usage.reasoningTokens / 1000) * p.reasoningPer1k : 0;
    const cached =
      cachedTokens > 0 && p.cachedPromptPer1k
        ? (cachedTokens / 1000) * p.cachedPromptPer1k
        : cachedTokens > 0
          ? (cachedTokens / 1000) * p.promptPer1k * 0.5 // default 50% discount if not specified
          : 0;
    const audioInput =
      usage.audioInputTokens && p.audioInputPer1k ? (usage.audioInputTokens / 1000) * p.audioInputPer1k : 0;
    const audioOutput =
      usage.audioOutputTokens && p.audioOutputPer1k ? (usage.audioOutputTokens / 1000) * p.audioOutputPer1k : 0;

    const total = input + output + reasoning + cached + audioInput + audioOutput;

    return { input, output, reasoning, cached, audioInput, audioOutput, total };
  }
}
