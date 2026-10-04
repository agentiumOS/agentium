import type { EventBus } from "@agentium/core";
import { Accounting, type AccountingOptions } from "./accounting.js";
import { Attachments, boundedText, positive } from "./safety.js";
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
  /** Average context length (tokens) per run. */
  avgContextLength?: number;
}

export interface MetricEvent {
  type: string;
  agentName?: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface MetricsExporterOptions extends AccountingOptions {
  maxSubscribers?: number;
  maxSubscriberEvents?: number;
  maxSubscriberBytes?: number;
}
export class MetricsExporter {
  private accounting: Accounting;
  private attachments = new Attachments();
  private subscribers = new Set<{ queue: MetricEvent[]; bytes: number; wake?: () => void; closed: boolean }>();
  private readonly maxSubscribers: number;
  private readonly maxEvents: number;
  private dropped = 0;
  private readonly maxBytes: number;
  constructor(private options: MetricsExporterOptions = {}) {
    this.accounting = new Accounting(options);
    this.maxSubscribers = positive(options.maxSubscribers ?? 32, "maxSubscribers");
    this.maxBytes = positive(options.maxSubscriberBytes ?? 262144, "maxSubscriberBytes");
    this.maxEvents = positive(options.maxSubscriberEvents ?? 128, "maxSubscriberEvents");
  }
  attach(bus: EventBus) {
    this.attachments.attach(bus, (event, raw) => {
      const data = raw as any;
      const record = this.accounting.accept(event, raw);
      if (event === "run.start" || record || event === "memory.correction.recorded")
        this.emit({
          type: event === "memory.correction.recorded" ? "correction.recorded" : event,
          agentName:
            typeof (record?.agentName ?? data.agentName) === "string"
              ? boundedText(record?.agentName ?? data.agentName, 256)
              : undefined,
          timestamp: Date.now(),
          data: {
            ...(typeof data.runId === "string" ? { runId: data.runId.slice(0, 512) } : {}),
            ...(record ? { durationMs: record.durationMs, tokens: record.tokens, status: record.status } : {}),
          },
        });
    });
  }
  detach(bus: EventBus) {
    this.attachments.detach(bus);
  }
  private emit(event: MetricEvent) {
    const size = Buffer.byteLength(JSON.stringify(event));
    for (const subscriber of this.subscribers) {
      if (size > this.maxBytes) {
        this.dropped++;
        continue;
      }
      while (
        subscriber.queue.length &&
        (subscriber.queue.length >= this.maxEvents || subscriber.bytes + size > this.maxBytes)
      ) {
        subscriber.bytes -= Buffer.byteLength(JSON.stringify(subscriber.queue.shift()));
        this.dropped++;
      }
      subscriber.queue.push(structuredClone(event));
      subscriber.bytes += size;
      subscriber.wake?.();
      subscriber.wake = undefined;
    }
  }
  getMetrics(agentName?: string): AgentMetrics {
    const records = this.accounting.records.filter((r) => !agentName || r.agentName === agentName);
    const stats = [...this.accounting.agents.entries()]
      .filter(([name]) => !agentName || name === agentName)
      .map(([, value]) => value);
    const sum = (
      key:
        | "tokens"
        | "promptTokens"
        | "completionTokens"
        | "reasoningTokens"
        | "cachedTokens"
        | "audioInputTokens"
        | "audioOutputTokens"
        | "cost"
        | "toolCalls",
    ) => records.reduce((n, r) => n + r[key], 0);
    const durations = records.map((r) => r.durationMs).sort((a, b) => a - b);
    const successes = records.filter((r) => r.success).length;
    const tools: Record<string, number> = Object.create(null);
    for (const r of records)
      for (const [name, count] of Object.entries(r.toolUsage)) tools[name] = (tools[name] ?? 0) + count;
    const corrections = stats.reduce((n, s) => n + s.corrections, 0);
    const scoreCount = stats.reduce((n, s) => n + s.scoreCount, 0);
    return {
      runs: records.length,
      errors: records.length - successes,
      avgDurationMs: Math.round(durations.reduce((a, b) => a + b, 0) / (durations.length || 1)),
      p95DurationMs: Math.round(durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] ?? 0),
      totalCost: sum("cost"),
      totalTokens: sum("tokens"),
      promptTokens: sum("promptTokens"),
      completionTokens: sum("completionTokens"),
      reasoningTokens: sum("reasoningTokens"),
      cachedTokens: sum("cachedTokens"),
      audioInputTokens: sum("audioInputTokens"),
      audioOutputTokens: sum("audioOutputTokens"),
      toolCallCount: sum("toolCalls"),
      toolUsageFrequency: tools,
      errorRate: (records.length - successes) / (records.length || 1),
      tokensPerRun: Math.round(sum("tokens") / (successes || 1)),
      correctionsTotal: corrections,
      correctionRate: corrections / (records.length || 1),
      avgCritiqueScore: scoreCount ? stats.reduce((n, s) => n + s.scoreSum, 0) / scoreCount : undefined,
      avgContextLength: Math.round(sum("promptTokens") / (successes || 1)),
    };
  }
  toPrometheus(): string {
    const lines: string[] = [];
    const definitions = {
      runs_total: ["counter", "runs"],
      errors_total: ["counter", "errors"],
      tokens_total: ["counter", "tokens"],
      cost_usd_total: ["counter", "cost"],
      tool_calls_total: ["counter", "tools"],
      corrections_total: ["counter", "corrections"],
    } as const;
    const escapeLabel = (value: string) =>
      value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
    for (const [metric, [, field]] of Object.entries(definitions)) {
      lines.push(`# HELP agentium_agent_${metric} Cumulative since reset`, `# TYPE agentium_agent_${metric} counter`);
      for (const [name, stats] of this.accounting.agents)
        lines.push(`agentium_agent_${metric}{agent="${escapeLabel(name)}"} ${stats[field]}`);
    }
    const gauges = new Set<string>();
    for (const [name] of this.accounting.agents) {
      const metrics = this.getMetrics(name);
      for (const [metric, value] of [
        ["duration_ms_avg", metrics.avgDurationMs],
        ["duration_ms_p95", metrics.p95DurationMs],
        ["correction_rate", metrics.correctionRate],
        ["critique_score_avg", metrics.avgCritiqueScore],
      ] as const) {
        if (value === undefined) continue;
        if (!gauges.has(metric)) {
          lines.push(`# TYPE agentium_agent_${metric} gauge`);
          gauges.add(metric);
        }
        lines.push(`agentium_agent_${metric}{agent="${escapeLabel(name)}"} ${value}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }
  toJSON() {
    return {
      global: this.getMetrics(),
      byAgent: Object.fromEntries([...this.accounting.agents.keys()].map((name) => [name, this.getMetrics(name)])),
      window: "retained runs",
      timestamp: Date.now(),
    };
  }
  stream(): AsyncIterableIterator<MetricEvent> {
    if (this.subscribers.size >= this.maxSubscribers) throw new Error("Metrics subscriber limit reached");
    const subscriber: { queue: MetricEvent[]; bytes: number; wake?: () => void; closed: boolean } = {
      queue: [],
      bytes: 0,
      closed: false,
    };
    this.subscribers.add(subscriber);
    let chain: Promise<unknown> = Promise.resolve();
    const close = () => {
      subscriber.closed = true;
      subscriber.queue = [];
      subscriber.bytes = 0;
      this.subscribers.delete(subscriber);
      subscriber.wake?.();
    };
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => {
        const work = chain.then(async (): Promise<IteratorResult<MetricEvent>> => {
          while (!subscriber.closed && !subscriber.queue.length)
            await new Promise<void>((resolve) => {
              subscriber.wake = resolve;
            });
          if (subscriber.closed) return { done: true, value: undefined };
          const value = subscriber.queue.shift()!;
          subscriber.bytes -= Buffer.byteLength(JSON.stringify(value));
          return { done: false, value };
        });
        chain = work;
        return work;
      },
      return: async () => {
        close();
        return { done: true, value: undefined };
      },
      throw: async (error) => {
        close();
        throw error;
      },
    };
  }
  shutdown() {
    this.attachments.close();
    for (const subscriber of this.subscribers) {
      subscriber.closed = true;
      subscriber.queue = [];
      subscriber.bytes = 0;
      subscriber.wake?.();
    }
    this.subscribers.clear();
  }
  getDiagnostics() {
    return {
      ...this.accounting.stats(),
      subscribers: this.subscribers.size,
      subscriberBytes: [...this.subscribers].reduce((total, s) => total + s.bytes, 0),
      droppedSubscriberEvents: this.dropped,
    };
  }
  reset() {
    this.accounting = new Accounting(this.options);
  }
}
