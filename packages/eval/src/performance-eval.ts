import type { Agent } from "@agentium/core";
import { positive, runCases, successful, validateConfig } from "./case-lifecycle.js";
import type { EvalCase, Reporter, ScorerResult } from "./types.js";
export interface PerformanceEvalConfig {
  name: string;
  agent: Agent;
  cases: EvalCase[];
  maxDurationMs?: number;
  maxTimeToFirstTokenMs?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PerformanceMetrics {
  durationMs: number;
  timeToFirstTokenMs?: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  memoryDeltaBytes?: number;
}

export class PerformanceEval {
  constructor(private config: PerformanceEvalConfig) {
    validateConfig(config);
    for (const [key, value] of Object.entries({
      maxDurationMs: config.maxDurationMs,
      maxTimeToFirstTokenMs: config.maxTimeToFirstTokenMs,
      maxTokens: config.maxTokens,
    }))
      if (value !== undefined) positive(value, key);
  }
  run(reporters?: Reporter[]) {
    return runCases(
      this.config,
      async (item, life) => {
        const start = Date.now();
        const memory = process.memoryUsage().heapUsed;
        const output = await life.agent(this.config.agent, item);
        const scores: Record<string, ScorerResult> = {};
        const compare = (key: string, value: number | undefined, limit: number | undefined) => {
          if (limit === undefined) return;
          const pass = value !== undefined && Number.isFinite(value) && value >= 0 && value <= limit;
          scores[key] = {
            score: pass ? 1 : 0,
            pass,
            reason: value === undefined ? "Required metric missing" : `${value} (limit: ${limit})`,
          };
        };
        compare("duration", Date.now() - start, this.config.maxDurationMs);
        compare("ttft", output.metrics?.timeToFirstTokenMs, this.config.maxTimeToFirstTokenMs);
        compare("tokens", output.usage.totalTokens, this.config.maxTokens);
        scores.memory = {
          score: 1,
          pass: true,
          reason: `Heap delta: ${((process.memoryUsage().heapUsed - memory) / 1024 / 1024).toFixed(2)}MB`,
        };
        return { output, scores, pass: successful(output) && Object.values(scores).every((s) => s.pass) };
      },
      reporters,
    );
  }
}
