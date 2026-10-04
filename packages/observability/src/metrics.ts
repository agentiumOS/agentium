import type { EventBus } from "@agentium/core";
import { Accounting, type AccountingOptions } from "./accounting.js";
import { Attachments } from "./safety.js";
import type { MetricsSnapshot } from "./types.js";
export class MetricsCollector {
  private accounting: Accounting;
  private attachments = new Attachments();
  constructor(private options: AccountingOptions = {}) {
    this.accounting = new Accounting(options);
  }
  attach(bus: EventBus) {
    this.attachments.attach(bus, (event, data) => {
      this.accounting.accept(event, data);
    });
  }
  detach(bus: EventBus) {
    this.attachments.detach(bus);
  }
  shutdown() {
    this.attachments.close();
  }
  getMetrics(): MetricsSnapshot {
    const { counters, totals, durations, latencies } = this.accounting;
    return {
      counters: { ...counters },
      histograms: { run_duration_ms: [...durations], tool_latency_ms: [...latencies] },
      gauges: { ...totals },
      rates: {
        cache_hit_ratio: counters.cache_hits / (counters.cache_hits + counters.cache_misses || 1),
        error_rate: counters.runs_error / (counters.runs_total || 1),
      },
      timestamp: Date.now(),
    };
  }
  getDiagnostics() {
    return this.accounting.stats();
  }
  reset() {
    this.accounting = new Accounting(this.options);
  }
}
