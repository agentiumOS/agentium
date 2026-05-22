import type { EventBus } from "../events/event-bus.js";
import { kvBytesPerToken } from "./kv-estimator.js";
import type { ModelArchitecture, SessionCategory, WorkloadMix } from "./types.js";
import { SESSION_CATEGORY_THRESHOLDS } from "./types.js";

interface SessionRecord {
  totalTokens: number;
  category: SessionCategory;
}

export interface SessionProfilerConfig {
  /** Model architecture for KV size estimation. Optional. */
  modelArch?: ModelArchitecture;
  /** Emit "capacity.warning" when estimated KV exceeds this (GB). */
  kvWarningThresholdGb?: number;
}

/**
 * Tracks session-level token accumulation and classifies sessions into
 * light / medium / heavy / extreme categories based on cumulative tokens.
 *
 * Attaches to the core EventBus (same pattern as MetricsExporter).
 */
export class SessionProfiler {
  private sessions = new Map<string, SessionRecord>();
  private listeners: Array<{ event: string; handler: (...args: any[]) => void }> = [];
  private config: SessionProfilerConfig;

  constructor(config?: SessionProfilerConfig) {
    this.config = config ?? {};
  }

  attach(eventBus: EventBus): void {
    const on = (event: string, handler: (data: any) => void) => {
      (eventBus as any).on(event, handler);
      this.listeners.push({ event, handler });
    };

    on("run.complete", (data: { runId: string; output: any }) => {
      const output = data.output;
      if (!output?.usage) return;

      const sessionId = output.sessionId || output.runId || data.runId;
      const tokens = output.usage.totalTokens ?? 0;

      const existing = this.sessions.get(sessionId);
      const prevCategory = existing?.category;
      const totalTokens = (existing?.totalTokens ?? 0) + tokens;
      const newCategory = this.classify(totalTokens);

      this.sessions.set(sessionId, { totalTokens, category: newCategory });

      if (prevCategory !== newCategory) {
        (eventBus as any).emit("capacity.session.classified", {
          sessionId,
          category: newCategory,
          totalTokens,
          previousCategory: prevCategory,
        });
      }

      if (this.config.kvWarningThresholdGb && this.config.modelArch) {
        const stats = this.getSessionStats();
        if (stats.estimatedKvGb > this.config.kvWarningThresholdGb) {
          (eventBus as any).emit("capacity.warning", {
            type: "kv_pressure",
            message: `Estimated KV cache (${stats.estimatedKvGb.toFixed(1)} GB) exceeds threshold (${this.config.kvWarningThresholdGb} GB)`,
            estimatedKvGb: stats.estimatedKvGb,
            sessionCount: this.sessions.size,
          });
        }
      }
    });
  }

  detach(eventBus: EventBus): void {
    for (const { event, handler } of this.listeners) {
      (eventBus as any).off(event, handler);
    }
    this.listeners = [];
  }

  classify(totalTokens: number): SessionCategory {
    if (totalTokens <= SESSION_CATEGORY_THRESHOLDS.light) return "light";
    if (totalTokens <= SESSION_CATEGORY_THRESHOLDS.medium) return "medium";
    if (totalTokens <= SESSION_CATEGORY_THRESHOLDS.heavy) return "heavy";
    return "extreme";
  }

  getSessionStats(): {
    byCategory: Record<SessionCategory, number>;
    totalTokens: number;
    avgTokensPerSession: number;
    estimatedKvGb: number;
  } {
    const byCategory: Record<SessionCategory, number> = { light: 0, medium: 0, heavy: 0, extreme: 0 };
    let totalTokens = 0;

    for (const record of this.sessions.values()) {
      byCategory[record.category]++;
      totalTokens += record.totalTokens;
    }

    const count = this.sessions.size || 1;
    let estimatedKvGb = 0;
    if (this.config.modelArch) {
      const bpt = kvBytesPerToken(this.config.modelArch, "bf16");
      estimatedKvGb = (totalTokens * bpt) / (1024 * 1024 * 1024);
    }

    return {
      byCategory,
      totalTokens,
      avgTokensPerSession: Math.round(totalTokens / count),
      estimatedKvGb,
    };
  }

  getWorkloadMix(): WorkloadMix {
    const stats = this.getSessionStats();
    return {
      extreme: stats.byCategory.extreme,
      heavy: stats.byCategory.heavy,
      medium: stats.byCategory.medium,
      light: stats.byCategory.light,
    };
  }

  reset(): void {
    this.sessions.clear();
  }
}
