import type { ABMetrics, ABTestConfig } from "./types.js";

interface RunRecord {
  variant: "control" | "variant";
  success: boolean;
  latencyMs: number;
  tokens: number;
  timestamp: number;
}

function hashToFloat(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) / 2147483647;
}

export class ABRouter {
  private config: ABTestConfig;
  private records: RunRecord[] = [];
  private maxRecords = 10000;

  constructor(config: ABTestConfig) {
    this.config = config;
  }

  route(opts: { userId?: string; sessionId?: string }): "control" | "variant" {
    const routing = this.config.routing;

    if (routing === "user" && opts.userId) {
      return hashToFloat(opts.userId) < this.config.trafficSplit ? "variant" : "control";
    }

    if (routing === "session" && opts.sessionId) {
      return hashToFloat(opts.sessionId) < this.config.trafficSplit ? "variant" : "control";
    }

    return Math.random() < this.config.trafficSplit ? "variant" : "control";
  }

  recordRun(variant: "control" | "variant", success: boolean, latencyMs: number, tokens: number): void {
    this.records.push({ variant, success, latencyMs, tokens, timestamp: Date.now() });
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }
  }

  shouldAutoRollback(): boolean {
    if (!this.config.autoRollback) return false;

    const { errorRateThreshold, windowMs } = this.config.autoRollback;
    const cutoff = Date.now() - windowMs;
    const recent = this.records.filter((r) => r.variant === "variant" && r.timestamp >= cutoff);

    if (recent.length < 5) return false;

    const errorRate = recent.filter((r) => !r.success).length / recent.length;
    return errorRate > errorRateThreshold;
  }

  getMetrics(): { control: ABMetrics; variant: ABMetrics } {
    const compute = (variant: "control" | "variant"): ABMetrics => {
      const runs = this.records.filter((r) => r.variant === variant);
      const successes = runs.filter((r) => r.success);
      return {
        variant,
        totalRuns: runs.length,
        successCount: successes.length,
        errorCount: runs.length - successes.length,
        avgLatencyMs: runs.length > 0 ? runs.reduce((s, r) => s + r.latencyMs, 0) / runs.length : 0,
        avgTokens: runs.length > 0 ? runs.reduce((s, r) => s + r.tokens, 0) / runs.length : 0,
        totalCost: 0,
      };
    };

    return { control: compute("control"), variant: compute("variant") };
  }

  reset(): void {
    this.records = [];
  }
}
