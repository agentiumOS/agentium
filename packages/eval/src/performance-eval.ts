import type { Agent } from "@agentium/core";
import { getTextContent } from "@agentium/core";
import type { EvalCase, EvalResult, Reporter } from "./types.js";

export interface PerformanceEvalConfig {
  name: string;
  agent: Agent;
  cases: EvalCase[];
  maxDurationMs?: number;
  maxTimeToFirstTokenMs?: number;
  maxTokens?: number;
  timeoutMs?: number;
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
  private config: PerformanceEvalConfig;

  constructor(config: PerformanceEvalConfig) {
    this.config = config;
  }

  async run(reporters?: Reporter[]) {
    const startTime = Date.now();
    const results: EvalResult[] = [];

    for (const evalCase of this.config.cases) {
      results.push(await this.runCase(evalCase));
    }

    const passed = results.filter((r) => r.pass).length;
    const allScores = results.flatMap((r) => Object.values(r.scores).map((s) => s.score));
    const averageScore = allScores.length > 0 ? allScores.reduce((a, b) => a + b, 0) / allScores.length : 0;

    const suiteResult = {
      name: this.config.name,
      results,
      passed,
      failed: results.length - passed,
      total: results.length,
      averageScore,
      durationMs: Date.now() - startTime,
    };

    if (reporters) {
      for (const reporter of reporters) {
        await reporter.report(suiteResult);
      }
    }

    return suiteResult;
  }

  private async runCase(evalCase: EvalCase): Promise<EvalResult> {
    const inputText = typeof evalCase.input === "string" ? evalCase.input : getTextContent(evalCase.input);
    const memBefore = process.memoryUsage().heapUsed;
    const caseStart = Date.now();

    try {
      const timeoutMs = this.config.timeoutMs ?? 30000;
      const output = await Promise.race([
        this.config.agent.run(evalCase.input, evalCase.runOpts),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);

      const durationMs = Date.now() - caseStart;
      const memAfter = process.memoryUsage().heapUsed;

      const scores: Record<string, { score: number; pass: boolean; reason: string }> = {};
      let allPass = true;

      if (this.config.maxDurationMs) {
        const pass = durationMs <= this.config.maxDurationMs;
        scores.duration = {
          score: pass ? 1 : Math.max(0, 1 - (durationMs - this.config.maxDurationMs) / this.config.maxDurationMs),
          pass,
          reason: `${durationMs}ms (limit: ${this.config.maxDurationMs}ms)`,
        };
        if (!pass) allPass = false;
      }

      if (this.config.maxTimeToFirstTokenMs && output.metrics?.timeToFirstTokenMs !== undefined) {
        const ttft = output.metrics.timeToFirstTokenMs;
        const pass = ttft <= this.config.maxTimeToFirstTokenMs;
        scores.ttft = {
          score: pass
            ? 1
            : Math.max(0, 1 - (ttft - this.config.maxTimeToFirstTokenMs) / this.config.maxTimeToFirstTokenMs),
          pass,
          reason: `${ttft}ms (limit: ${this.config.maxTimeToFirstTokenMs}ms)`,
        };
        if (!pass) allPass = false;
      }

      if (this.config.maxTokens) {
        const total = output.usage.totalTokens;
        const pass = total <= this.config.maxTokens;
        scores.tokens = {
          score: pass ? 1 : Math.max(0, 1 - (total - this.config.maxTokens) / this.config.maxTokens),
          pass,
          reason: `${total} tokens (limit: ${this.config.maxTokens})`,
        };
        if (!pass) allPass = false;
      }

      scores.memory = {
        score: 1,
        pass: true,
        reason: `Heap delta: ${((memAfter - memBefore) / 1024 / 1024).toFixed(2)}MB`,
      };

      if (Object.keys(scores).length === 0) {
        scores.completed = { score: 1, pass: true, reason: "Completed successfully" };
      }

      return {
        caseName: evalCase.name,
        input: inputText,
        output,
        scores,
        durationMs,
        pass: allPass,
      };
    } catch (err) {
      return {
        caseName: evalCase.name,
        input: inputText,
        scores: { error: { score: 0, pass: false, reason: (err as Error).message } },
        durationMs: Date.now() - caseStart,
        pass: false,
        error: (err as Error).message,
      };
    }
  }
}
