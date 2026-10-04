import { boundedText, positive } from "./safety.js";
export type Outcome = "completed" | "failed" | "cancelled" | "stopped" | "awaiting_input";
export function outcome(event: string, data: any): Outcome {
  if (event === "run.cancelled") return "cancelled";
  if (event === "run.error")
    return data.status === "cancelled" || ["AbortError", "RunCancelledError"].includes(data.error?.name)
      ? "cancelled"
      : "failed";
  const status = data.output?.status ?? "completed";
  return ["completed", "cancelled", "stopped", "awaiting_input"].includes(status) ? status : "failed";
}
export const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
export function usage(value: any) {
  return {
    tokens: number(value?.totalTokens),
    promptTokens: number(value?.promptTokens),
    completionTokens: number(value?.completionTokens),
    reasoningTokens: number(value?.reasoningTokens),
    cachedTokens: number(value?.cachedTokens),
    audioInputTokens: number(value?.audioInputTokens),
    audioOutputTokens: number(value?.audioOutputTokens),
  };
}
export interface RunRecord extends ReturnType<typeof usage> {
  runId: string;
  agentName: string;
  durationMs: number;
  cost: number;
  toolCalls: number;
  toolUsage: Record<string, number>;
  success: boolean;
  status: Outcome;
  timestamp: number;
}
export interface AccountingOptions {
  maxRecords?: number;
  maxActiveRuns?: number;
  maxActiveTools?: number;
  maxAgents?: number;
  maxHistogramSize?: number;
}
type Active = { agent: string; start: number; cost: number; toolCalls: number; toolUsage: Record<string, number> };
export class Accounting {
  readonly records: RunRecord[] = [];
  readonly agents = new Map<
    string,
    {
      runs: number;
      errors: number;
      tools: number;
      tokens: number;
      cost: number;
      corrections: number;
      scoreSum: number;
      scoreCount: number;
    }
  >();
  counters = {
    runs_total: 0,
    runs_success: 0,
    runs_error: 0,
    runs_cancelled: 0,
    runs_stopped: 0,
    tool_calls_total: 0,
    handoffs_total: 0,
    cache_hits: 0,
    cache_misses: 0,
  };
  totals = {
    total_cost_usd: 0,
    total_tokens: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    reasoning_tokens: 0,
    cached_tokens: 0,
    audio_input_tokens: 0,
    audio_output_tokens: 0,
  };
  readonly durations: number[] = [];
  readonly latencies: number[] = [];
  private active = new Map<string, Active>();
  private tools = new Map<string, { runId: string; name: string; callId?: string; start: number }>();
  private sequence = 0;
  dropped = 0;
  private bounds: Required<AccountingOptions>;
  constructor(options: AccountingOptions = {}) {
    this.bounds = {
      maxRecords: options.maxRecords ?? 1000,
      maxActiveRuns: options.maxActiveRuns ?? 1000,
      maxActiveTools: options.maxActiveTools ?? 10000,
      maxAgents: options.maxAgents ?? 256,
      maxHistogramSize: options.maxHistogramSize ?? 10000,
    };
    for (const [key, value] of Object.entries(this.bounds)) positive(value, key);
  }
  private agent(name: unknown) {
    let key = boundedText(typeof name === "string" ? name : "unknown", 256);
    if (!this.agents.has(key) && this.agents.size >= this.bounds.maxAgents - 1) key = "__other__";
    if (!this.agents.has(key))
      this.agents.set(key, {
        runs: 0,
        errors: 0,
        tools: 0,
        tokens: 0,
        cost: 0,
        corrections: 0,
        scoreSum: 0,
        scoreCount: 0,
      });
    return key;
  }
  private histogram(values: number[], value: number) {
    values.push(value);
    if (values.length > this.bounds.maxHistogramSize) values.shift();
  }
  accept(event: string, data: any): RunRecord | undefined {
    const id = data?.runId;
    const now = Date.now();
    if (event === "run.start") {
      if (this.active.has(id) || this.records.some((r) => r.runId === id)) return;
      if (typeof id !== "string" || id.length > 512 || this.active.size >= this.bounds.maxActiveRuns) {
        this.dropped++;
        return;
      }
      const agent = this.agent(data.agentName);
      this.active.set(id, { agent, start: now, cost: 0, toolCalls: 0, toolUsage: Object.create(null) });
      this.counters.runs_total++;
    } else if (["run.complete", "run.error", "run.cancelled"].includes(event)) {
      const active = this.active.get(id);
      if (!active) {
        // A cancellation notice can precede the terminal output carrying actual usage.
        const existing = this.records.find((r) => r.runId === id);
        if (existing && event === "run.complete" && existing.status === "cancelled")
          this.updateUsage(existing, usage(data.output?.usage));
        return;
      }
      const status = outcome(event, data);
      const record: RunRecord = {
        ...usage(data.output?.usage),
        runId: id,
        agentName: active.agent,
        durationMs: number(data.output?.durationMs) || now - active.start,
        cost: active.cost,
        toolCalls: active.toolCalls,
        toolUsage: active.toolUsage,
        success: status === "completed",
        status,
        timestamp: now,
      };
      const stats = this.agents.get(active.agent)!;
      stats.runs++;
      if (!record.success) stats.errors++;
      stats.tokens += record.tokens;
      this.counters.runs_success += Number(record.success);
      this.counters.runs_error += Number(!record.success);
      this.counters.runs_cancelled += Number(status === "cancelled");
      this.counters.runs_stopped += Number(status === "stopped");
      this.addUsage(record, 1);
      this.histogram(this.durations, record.durationMs);
      this.active.delete(id);
      for (const [key, tool] of this.tools) if (tool.runId === id) this.tools.delete(key);
      this.records.push(record);
      if (this.records.length > this.bounds.maxRecords) this.records.shift();
      return record;
    } else if (event === "tool.call") {
      if (
        typeof id !== "string" ||
        id.length > 512 ||
        (data.toolCallId !== undefined && (typeof data.toolCallId !== "string" || data.toolCallId.length > 512)) ||
        this.tools.size >= this.bounds.maxActiveTools
      ) {
        this.dropped++;
        return;
      }
      const name = boundedText(String(data.toolName ?? "unknown"), 256);
      const key = JSON.stringify([id, name, data.toolCallId ?? ++this.sequence]);
      if (this.tools.has(key)) return;
      this.tools.set(key, { runId: id, name, callId: data.toolCallId, start: now });
      this.counters.tool_calls_total++;
      const active = this.active.get(id);
      if (active) {
        active.toolCalls++;
        if (Object.keys(active.toolUsage).length < 256 || active.toolUsage[name])
          active.toolUsage[name] = (active.toolUsage[name] ?? 0) + 1;
        this.agents.get(active.agent)!.tools++;
      }
    } else if (event === "tool.result") {
      const candidates = [...this.tools.entries()].filter(
        ([, tool]) =>
          tool.runId === id &&
          tool.name === boundedText(String(data.toolName ?? "unknown"), 256) &&
          (!data.toolCallId || tool.callId === data.toolCallId),
      );
      if (candidates.length === 1) {
        this.histogram(this.latencies, now - candidates[0][1].start);
        this.tools.delete(candidates[0][0]);
      }
    } else if (event === "cost.tracked") {
      const value = number(data.cost ?? data.usage?.cost);
      const active = this.active.get(id);
      const record = this.records.find((r) => r.runId === id);
      const target = active ?? record;
      if (target) {
        const delta = value - target.cost;
        target.cost = value;
        this.totals.total_cost_usd += delta;
        this.agents.get(active?.agent ?? record!.agentName)!.cost += delta;
      }
    } else if (event === "cache.hit") this.counters.cache_hits++;
    else if (event === "cache.miss") this.counters.cache_misses++;
    else if (event === "handoff.transfer") this.counters.handoffs_total++;
    else if (event === "memory.correction.recorded") this.agents.get(this.agent(data.agentName))!.corrections++;
    else if (event === "reflection.critique" && typeof data.score === "number" && data.score >= 0 && data.score <= 1) {
      const stats = this.agents.get(this.agent(this.active.get(id)?.agent))!;
      stats.scoreCount++;
      stats.scoreSum += data.score;
    }
  }
  private updateUsage(record: RunRecord, next: ReturnType<typeof usage>) {
    this.addUsage(record, -1);
    this.agents.get(record.agentName)!.tokens += next.tokens - record.tokens;
    Object.assign(record, next);
    this.addUsage(record, 1);
  }
  private addUsage(value: ReturnType<typeof usage>, sign: number) {
    this.totals.total_tokens += sign * value.tokens;
    this.totals.prompt_tokens += sign * value.promptTokens;
    this.totals.completion_tokens += sign * value.completionTokens;
    this.totals.reasoning_tokens += sign * value.reasoningTokens;
    this.totals.cached_tokens += sign * value.cachedTokens;
    this.totals.audio_input_tokens += sign * value.audioInputTokens;
    this.totals.audio_output_tokens += sign * value.audioOutputTokens;
  }
  stats() {
    return {
      activeRuns: this.active.size,
      activeTools: this.tools.size,
      records: this.records.length,
      dropped: this.dropped,
    };
  }
}
