import type { EventBus } from "@agentium/core";

export interface AgentMetrics {
  runs: number;
  errors: number;
  avgDurationMs: number;
  p95DurationMs: number;
  totalCost: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  audioInputTokens: number;
  audioOutputTokens: number;
  toolCallCount: number;
  toolUsageFrequency: Record<string, number>;
  errorRate: number;
  tokensPerRun: number;
  /** Total human corrections recorded against this agent's output. */
  correctionsTotal: number;
  /** Corrections per run — the inverse of first-pass accuracy. */
  correctionRate: number;
  /** Average self-critique score (0-1) from reflection, if enabled. */
  avgCritiqueScore?: number;
  /** Estimated total KV cache memory (GB) across all sessions. Requires capacity module. */
  estimatedKvCacheGb?: number;
  /** Average context length (tokens) per run. */
  avgContextLength?: number;
  /** Session count by category (light/medium/heavy/extreme). */
  sessionCategories?: Record<string, number>;
}

export interface MetricEvent {
  type: string;
  agentName?: string;
  timestamp: number;
  data: Record<string, unknown>;
}

interface RunRecord {
  agentName: string;
  durationMs: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  audioInputTokens: number;
  audioOutputTokens: number;
  providerMetrics?: Record<string, unknown>;
  cost: number;
  toolCalls: number;
  success: boolean;
  timestamp: number;
}

export class MetricsExporter {
  private runs: RunRecord[] = [];
  private toolUsage: Record<string, Record<string, number>> = {};
  private runStartTimes = new Map<string, { agentName: string; start: number }>();
  private runToolCounts = new Map<string, number>();
  private listeners: Array<{ event: string; handler: (...args: any[]) => void }> = [];
  private subscribers = new Set<(event: MetricEvent) => void>();
  private maxRecords = 50_000;
  private sessionCategories: Record<string, number> = {};
  private estimatedKvCacheGb?: number;
  private corrections: Record<string, number> = {};
  private critiqueScores: Record<string, number[]> = {};

  attach(eventBus: EventBus): void {
    const on = (event: string, handler: (data: any) => void) => {
      (eventBus as any).on(event, handler);
      this.listeners.push({ event, handler });
    };

    on("run.start", (data: { runId: string; agentName: string }) => {
      this.runStartTimes.set(data.runId, { agentName: data.agentName, start: Date.now() });
      this.runToolCounts.set(data.runId, 0);
      this.emit({ type: "run.start", agentName: data.agentName, timestamp: Date.now(), data: { runId: data.runId } });
    });

    on("run.complete", (data: { runId: string; output: any }) => {
      const info = this.runStartTimes.get(data.runId);
      if (!info) return;
      const duration = Date.now() - info.start;
      const usage = data.output?.usage;
      const tokens = usage?.totalTokens ?? 0;
      this.addRecord({
        agentName: info.agentName,
        durationMs: duration,
        tokens,
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        reasoningTokens: usage?.reasoningTokens ?? 0,
        cachedTokens: usage?.cachedTokens ?? 0,
        audioInputTokens: usage?.audioInputTokens ?? 0,
        audioOutputTokens: usage?.audioOutputTokens ?? 0,
        providerMetrics: usage?.providerMetrics,
        cost: 0,
        toolCalls: this.runToolCounts.get(data.runId) ?? 0,
        success: true,
        timestamp: Date.now(),
      });
      this.runStartTimes.delete(data.runId);
      this.runToolCounts.delete(data.runId);
      this.emit({
        type: "run.complete",
        agentName: info.agentName,
        timestamp: Date.now(),
        data: { durationMs: duration, tokens },
      });
    });

    on("run.error", (data: { runId: string }) => {
      const info = this.runStartTimes.get(data.runId);
      if (!info) return;
      const duration = Date.now() - info.start;
      this.addRecord({
        agentName: info.agentName,
        durationMs: duration,
        tokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        cachedTokens: 0,
        audioInputTokens: 0,
        audioOutputTokens: 0,
        cost: 0,
        toolCalls: this.runToolCounts.get(data.runId) ?? 0,
        success: false,
        timestamp: Date.now(),
      });
      this.runStartTimes.delete(data.runId);
      this.runToolCounts.delete(data.runId);
      this.emit({
        type: "run.error",
        agentName: info.agentName,
        timestamp: Date.now(),
        data: { durationMs: duration },
      });
    });

    on("tool.call", (data: { runId: string; toolName: string }) => {
      const info = this.runStartTimes.get(data.runId);
      const agentName = info?.agentName ?? "unknown";
      this.runToolCounts.set(data.runId, (this.runToolCounts.get(data.runId) ?? 0) + 1);
      if (!this.toolUsage[agentName]) this.toolUsage[agentName] = {};
      this.toolUsage[agentName][data.toolName] = (this.toolUsage[agentName][data.toolName] ?? 0) + 1;
    });

    on("cost.tracked", (data: { runId: string; agentName: string; usage: any }) => {
      for (let i = this.runs.length - 1; i >= 0; i--) {
        if (this.runs[i].agentName === data.agentName) {
          if (data.usage?.cost) this.runs[i].cost = data.usage.cost;
          break;
        }
      }
    });

    on("capacity.session.classified", (data: { category: string }) => {
      this.sessionCategories[data.category] = (this.sessionCategories[data.category] ?? 0) + 1;
    });

    on("capacity.warning", (data: { estimatedKvGb?: number }) => {
      if (data.estimatedKvGb !== undefined) {
        this.estimatedKvCacheGb = data.estimatedKvGb;
      }
    });

    on("memory.correction.recorded", (data: { correctionId: string; agentName: string; entityKey?: string }) => {
      this.corrections[data.agentName] = (this.corrections[data.agentName] ?? 0) + 1;
      this.emit({
        type: "correction.recorded",
        agentName: data.agentName,
        timestamp: Date.now(),
        data: { correctionId: data.correctionId, entityKey: data.entityKey },
      });
    });

    on("reflection.critique", (data: { runId: string; pass: boolean; score: number }) => {
      const agentName = this.runStartTimes.get(data.runId)?.agentName ?? "unknown";
      if (!this.critiqueScores[agentName]) this.critiqueScores[agentName] = [];
      this.critiqueScores[agentName].push(data.score);
    });
  }

  detach(eventBus: EventBus): void {
    for (const { event, handler } of this.listeners) {
      (eventBus as any).off(event, handler);
    }
    this.listeners = [];
  }

  private addRecord(record: RunRecord): void {
    this.runs.push(record);
    if (this.runs.length > this.maxRecords) {
      this.runs = this.runs.slice(-this.maxRecords);
    }
  }

  private emit(event: MetricEvent): void {
    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch {}
    }
  }

  getMetrics(agentName?: string): AgentMetrics {
    const filtered = agentName ? this.runs.filter((r) => r.agentName === agentName) : this.runs;
    const successful = filtered.filter((r) => r.success);
    const durations = filtered.map((r) => r.durationMs).sort((a, b) => a - b);

    const totalRuns = filtered.length;
    const errors = filtered.filter((r) => !r.success).length;
    const totalTokens = filtered.reduce((s, r) => s + r.tokens, 0);
    const promptTokens = filtered.reduce((s, r) => s + r.promptTokens, 0);
    const completionTokens = filtered.reduce((s, r) => s + r.completionTokens, 0);
    const reasoningTokens = filtered.reduce((s, r) => s + r.reasoningTokens, 0);
    const cachedTokens = filtered.reduce((s, r) => s + r.cachedTokens, 0);
    const audioInputTokens = filtered.reduce((s, r) => s + r.audioInputTokens, 0);
    const audioOutputTokens = filtered.reduce((s, r) => s + r.audioOutputTokens, 0);
    const totalCost = filtered.reduce((s, r) => s + r.cost, 0);
    const totalToolCalls = filtered.reduce((s, r) => s + r.toolCalls, 0);
    const avgDuration = durations.length > 0 ? durations.reduce((s, d) => s + d, 0) / durations.length : 0;
    const p95Idx = Math.floor(durations.length * 0.95);
    const p95 = durations.length > 0 ? durations[Math.min(p95Idx, durations.length - 1)] : 0;

    const toolFreq: Record<string, number> = {};
    if (agentName && this.toolUsage[agentName]) {
      Object.assign(toolFreq, this.toolUsage[agentName]);
    } else {
      for (const usage of Object.values(this.toolUsage)) {
        for (const [tool, count] of Object.entries(usage)) {
          toolFreq[tool] = (toolFreq[tool] ?? 0) + count;
        }
      }
    }

    const avgContextLength = successful.length > 0 ? Math.round(promptTokens / successful.length) : 0;

    const correctionsTotal = agentName
      ? (this.corrections[agentName] ?? 0)
      : Object.values(this.corrections).reduce((s, c) => s + c, 0);

    const scores = agentName ? (this.critiqueScores[agentName] ?? []) : Object.values(this.critiqueScores).flat();
    const avgCritiqueScore = scores.length > 0 ? scores.reduce((s, v) => s + v, 0) / scores.length : undefined;

    return {
      runs: totalRuns,
      errors,
      avgDurationMs: Math.round(avgDuration),
      p95DurationMs: Math.round(p95),
      totalCost,
      totalTokens,
      promptTokens,
      completionTokens,
      reasoningTokens,
      cachedTokens,
      audioInputTokens,
      audioOutputTokens,
      toolCallCount: totalToolCalls,
      toolUsageFrequency: toolFreq,
      errorRate: totalRuns > 0 ? errors / totalRuns : 0,
      tokensPerRun: successful.length > 0 ? Math.round(totalTokens / successful.length) : 0,
      correctionsTotal,
      correctionRate: totalRuns > 0 ? correctionsTotal / totalRuns : 0,
      avgCritiqueScore,
      avgContextLength,
      sessionCategories: this.sessionCategories,
      estimatedKvCacheGb: this.estimatedKvCacheGb,
    };
  }

  toPrometheus(): string {
    const lines: string[] = [];
    const allAgents = new Set([...this.runs.map((r) => r.agentName), ...Object.keys(this.corrections)]);

    lines.push("# HELP agentium_agent_runs_total Total agent runs");
    lines.push("# TYPE agentium_agent_runs_total counter");
    for (const agent of allAgents) {
      const m = this.getMetrics(agent);
      lines.push(`agentium_agent_runs_total{agent="${agent}"} ${m.runs}`);
    }

    lines.push("# HELP agentium_agent_errors_total Total agent errors");
    lines.push("# TYPE agentium_agent_errors_total counter");
    for (const agent of allAgents) {
      const m = this.getMetrics(agent);
      lines.push(`agentium_agent_errors_total{agent="${agent}"} ${m.errors}`);
    }

    lines.push("# HELP agentium_agent_duration_ms_avg Average run duration in ms");
    lines.push("# TYPE agentium_agent_duration_ms_avg gauge");
    for (const agent of allAgents) {
      const m = this.getMetrics(agent);
      lines.push(`agentium_agent_duration_ms_avg{agent="${agent}"} ${m.avgDurationMs}`);
    }

    lines.push("# HELP agentium_agent_duration_ms_p95 P95 run duration in ms");
    lines.push("# TYPE agentium_agent_duration_ms_p95 gauge");
    for (const agent of allAgents) {
      const m = this.getMetrics(agent);
      lines.push(`agentium_agent_duration_ms_p95{agent="${agent}"} ${m.p95DurationMs}`);
    }

    lines.push("# HELP agentium_agent_tokens_total Total tokens consumed");
    lines.push("# TYPE agentium_agent_tokens_total counter");
    for (const agent of allAgents) {
      const m = this.getMetrics(agent);
      lines.push(`agentium_agent_tokens_total{agent="${agent}"} ${m.totalTokens}`);
    }

    lines.push("# HELP agentium_agent_cost_usd_total Total cost in USD");
    lines.push("# TYPE agentium_agent_cost_usd_total counter");
    for (const agent of allAgents) {
      const m = this.getMetrics(agent);
      lines.push(`agentium_agent_cost_usd_total{agent="${agent}"} ${m.totalCost}`);
    }

    lines.push("# HELP agentium_agent_tool_calls_total Total tool calls");
    lines.push("# TYPE agentium_agent_tool_calls_total counter");
    for (const agent of allAgents) {
      const m = this.getMetrics(agent);
      lines.push(`agentium_agent_tool_calls_total{agent="${agent}"} ${m.toolCallCount}`);
    }

    lines.push("# HELP agentium_agent_corrections_total Total human corrections recorded");
    lines.push("# TYPE agentium_agent_corrections_total counter");
    for (const agent of allAgents) {
      const m = this.getMetrics(agent);
      lines.push(`agentium_agent_corrections_total{agent="${agent}"} ${m.correctionsTotal}`);
    }

    lines.push("# HELP agentium_agent_correction_rate Corrections per run (inverse of first-pass accuracy)");
    lines.push("# TYPE agentium_agent_correction_rate gauge");
    for (const agent of allAgents) {
      const m = this.getMetrics(agent);
      lines.push(`agentium_agent_correction_rate{agent="${agent}"} ${m.correctionRate}`);
    }

    const agentsWithCritiques = [...allAgents].filter((a) => (this.critiqueScores[a] ?? []).length > 0);
    if (agentsWithCritiques.length > 0) {
      lines.push("# HELP agentium_agent_critique_score_avg Average reflection self-critique score (0-1)");
      lines.push("# TYPE agentium_agent_critique_score_avg gauge");
      for (const agent of agentsWithCritiques) {
        const m = this.getMetrics(agent);
        lines.push(`agentium_agent_critique_score_avg{agent="${agent}"} ${m.avgCritiqueScore}`);
      }
    }

    if (this.estimatedKvCacheGb !== undefined) {
      lines.push("# HELP agentium_kv_cache_estimated_gb Estimated KV cache size in GB");
      lines.push("# TYPE agentium_kv_cache_estimated_gb gauge");
      lines.push(`agentium_kv_cache_estimated_gb ${this.estimatedKvCacheGb}`);
    }

    const categories = Object.entries(this.sessionCategories);
    if (categories.length > 0) {
      lines.push("# HELP agentium_session_category_total Sessions by category");
      lines.push("# TYPE agentium_session_category_total counter");
      for (const [category, count] of categories) {
        lines.push(`agentium_session_category_total{category="${category}"} ${count}`);
      }

      const totalSessions = categories.reduce((s, [, c]) => s + c, 0);
      lines.push("# HELP agentium_capacity_sessions_total Total tracked sessions");
      lines.push("# TYPE agentium_capacity_sessions_total counter");
      lines.push(`agentium_capacity_sessions_total ${totalSessions}`);
    }

    return `${lines.join("\n")}\n`;
  }

  toJSON(): object {
    const allAgents = new Set([...this.runs.map((r) => r.agentName), ...Object.keys(this.corrections)]);
    const byAgent: Record<string, AgentMetrics> = {};
    for (const agent of allAgents) {
      byAgent[agent] = this.getMetrics(agent);
    }
    return {
      global: this.getMetrics(),
      byAgent,
      timestamp: Date.now(),
    };
  }

  async *stream(): AsyncIterable<MetricEvent> {
    const queue: MetricEvent[] = [];
    let resolve: (() => void) | null = null;

    const handler = (event: MetricEvent) => {
      queue.push(event);
      if (resolve) {
        resolve();
        resolve = null;
      }
    };

    this.subscribers.add(handler);
    try {
      while (true) {
        while (queue.length > 0) {
          yield queue.shift()!;
        }
        await new Promise<void>((r) => {
          resolve = r;
        });
      }
    } finally {
      this.subscribers.delete(handler);
    }
  }

  reset(): void {
    this.runs = [];
    this.toolUsage = {};
    this.runStartTimes.clear();
    this.runToolCounts.clear();
    this.corrections = {};
    this.critiqueScores = {};
  }
}
