import type { EventBus } from "@agentium/core";
import type { MetricsSnapshot } from "./types.js";

export class MetricsCollector {
  private counters = {
    runs_total: 0,
    runs_success: 0,
    runs_error: 0,
    tool_calls_total: 0,
    handoffs_total: 0,
    cache_hits: 0,
    cache_misses: 0,
  };

  private histograms = {
    run_duration_ms: [] as number[],
    tool_latency_ms: [] as number[],
  };

  private gauges = {
    total_cost_usd: 0,
    total_tokens: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    reasoning_tokens: 0,
    cached_tokens: 0,
    audio_input_tokens: 0,
    audio_output_tokens: 0,
  };

  private readonly MAX_HISTOGRAM_SIZE = 10000;
  private toolStartTimes = new Map<string, number>();
  private runStartTimes = new Map<string, number>();
  private listeners: Array<{ event: string; handler: (...args: any[]) => void }> = [];

  attach(eventBus: EventBus): void {
    const on = (event: string, handler: (data: any) => void) => {
      (eventBus as any).on(event, handler);
      this.listeners.push({ event, handler });
    };

    on("run.start", (data: { runId: string }) => {
      this.counters.runs_total++;
      this.runStartTimes.set(data.runId, Date.now());
    });

    on("run.complete", (data: { runId: string; output: any }) => {
      this.counters.runs_success++;
      const startTime = this.runStartTimes.get(data.runId);
      if (startTime) {
        const duration = Date.now() - startTime;
        this.histograms.run_duration_ms.push(duration);
        if (this.histograms.run_duration_ms.length > this.MAX_HISTOGRAM_SIZE) {
          this.histograms.run_duration_ms = this.histograms.run_duration_ms.slice(-this.MAX_HISTOGRAM_SIZE);
        }
        this.runStartTimes.delete(data.runId);
      }
      if (data.output?.usage) {
        this.gauges.total_tokens += data.output.usage.totalTokens ?? 0;
        this.gauges.prompt_tokens += data.output.usage.promptTokens ?? 0;
        this.gauges.completion_tokens += data.output.usage.completionTokens ?? 0;
        this.gauges.reasoning_tokens += data.output.usage.reasoningTokens ?? 0;
        this.gauges.cached_tokens += data.output.usage.cachedTokens ?? 0;
        this.gauges.audio_input_tokens += data.output.usage.audioInputTokens ?? 0;
        this.gauges.audio_output_tokens += data.output.usage.audioOutputTokens ?? 0;
      }
      for (const key of this.toolStartTimes.keys()) {
        if (key.startsWith(`${data.runId}:`)) this.toolStartTimes.delete(key);
      }
    });

    on("run.error", (data: { runId: string }) => {
      this.counters.runs_error++;
      const startTime = this.runStartTimes.get(data.runId);
      if (startTime) {
        const duration = Date.now() - startTime;
        this.histograms.run_duration_ms.push(duration);
        if (this.histograms.run_duration_ms.length > this.MAX_HISTOGRAM_SIZE) {
          this.histograms.run_duration_ms = this.histograms.run_duration_ms.slice(-this.MAX_HISTOGRAM_SIZE);
        }
        this.runStartTimes.delete(data.runId);
      }
      for (const key of this.toolStartTimes.keys()) {
        if (key.startsWith(`${data.runId}:`)) this.toolStartTimes.delete(key);
      }
    });

    on("tool.call", (data: { runId: string; toolName: string }) => {
      this.counters.tool_calls_total++;
      this.toolStartTimes.set(`${data.runId}:${data.toolName}`, Date.now());
    });

    on("tool.result", (data: { runId: string; toolName: string }) => {
      const key = `${data.runId}:${data.toolName}`;
      const start = this.toolStartTimes.get(key);
      if (start) {
        this.histograms.tool_latency_ms.push(Date.now() - start);
        if (this.histograms.tool_latency_ms.length > this.MAX_HISTOGRAM_SIZE) {
          this.histograms.tool_latency_ms = this.histograms.tool_latency_ms.slice(-this.MAX_HISTOGRAM_SIZE);
        }
        this.toolStartTimes.delete(key);
      }
    });

    on("handoff.transfer", () => {
      this.counters.handoffs_total++;
    });

    on("cache.hit", () => {
      this.counters.cache_hits++;
    });

    on("cache.miss", () => {
      this.counters.cache_misses++;
    });

    on("cost.tracked", (data: { runId: string; agentName: string; modelId: string; usage: any; cost?: number }) => {
      // Token counting is done via run.complete to avoid double-counting.
      // cost.tracked only contributes dollar cost from CostTracker.
      const cost = data.cost ?? data.usage?.cost ?? 0;
      if (cost) {
        this.gauges.total_cost_usd += cost;
      }
    });
  }

  detach(eventBus: EventBus): void {
    for (const { event, handler } of this.listeners) {
      (eventBus as any).off(event, handler);
    }
    this.listeners = [];
  }

  getMetrics(): MetricsSnapshot {
    const totalCacheAttempts = this.counters.cache_hits + this.counters.cache_misses;

    return {
      counters: { ...this.counters },
      histograms: {
        run_duration_ms: [...this.histograms.run_duration_ms],
        tool_latency_ms: [...this.histograms.tool_latency_ms],
      },
      gauges: { ...this.gauges },
      rates: {
        cache_hit_ratio: totalCacheAttempts > 0 ? this.counters.cache_hits / totalCacheAttempts : 0,
        error_rate: this.counters.runs_total > 0 ? this.counters.runs_error / this.counters.runs_total : 0,
      },
      timestamp: Date.now(),
    };
  }

  reset(): void {
    this.counters = {
      runs_total: 0,
      runs_success: 0,
      runs_error: 0,
      tool_calls_total: 0,
      handoffs_total: 0,
      cache_hits: 0,
      cache_misses: 0,
    };
    this.histograms = {
      run_duration_ms: [],
      tool_latency_ms: [],
    };
    this.gauges = {
      total_cost_usd: 0,
      total_tokens: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      reasoning_tokens: 0,
      cached_tokens: 0,
      audio_input_tokens: 0,
      audio_output_tokens: 0,
    };
    this.toolStartTimes.clear();
    this.runStartTimes.clear();
  }
}
