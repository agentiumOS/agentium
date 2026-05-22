import { getTextContent } from "@agentium/core";
import type { EvalCase, EvalResult, EvalSuiteConfig, EvalSuiteResult, Reporter, ScorerResult } from "./types.js";

export class EvalSuite {
  private config: EvalSuiteConfig;

  constructor(config: EvalSuiteConfig) {
    this.config = config;
  }

  async run(reporters?: Reporter[]): Promise<EvalSuiteResult> {
    const startTime = Date.now();
    const threshold = this.config.threshold ?? 0.7;
    const concurrency = this.config.concurrency ?? 1;
    const results: EvalResult[] = [];

    const chunks = this.chunk(this.config.cases, concurrency);

    for (const batch of chunks) {
      const batchResults = await Promise.allSettled(batch.map((c) => this.runCase(c, threshold)));
      for (const result of batchResults) {
        if (result.status === "fulfilled") {
          results.push(result.value);
        } else {
          results.push({
            input: "unknown",
            scores: {},
            pass: false,
            durationMs: 0,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      }
    }

    const passed = results.filter((r) => r.pass).length;
    const failed = results.length - passed;

    const allScores = results.flatMap((r) => Object.values(r.scores).map((s) => s.score));
    const averageScore = allScores.length > 0 ? allScores.reduce((a, b) => a + b, 0) / allScores.length : 0;

    const suiteResult: EvalSuiteResult = {
      name: this.config.name,
      results,
      passed,
      failed,
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

  private async runCase(evalCase: EvalCase, threshold: number): Promise<EvalResult> {
    const startTime = Date.now();
    const inputText = typeof evalCase.input === "string" ? evalCase.input : getTextContent(evalCase.input);

    const timeoutMs = this.config.timeoutMs ?? 30000;
    const output = await Promise.race([
      this.config.agent.run(evalCase.input, evalCase.runOpts),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Eval case timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);

    const scores: Record<string, ScorerResult> = {};

    for (const scorer of this.config.scorers) {
      try {
        scores[scorer.name] = await scorer.score(inputText, output, evalCase.expected);
      } catch (err) {
        scores[scorer.name] = {
          score: 0,
          pass: false,
          reason: `Scorer error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    const allPass = Object.values(scores).every((s) => s.score >= threshold);

    return {
      caseName: evalCase.name,
      input: inputText,
      output,
      scores,
      durationMs: Date.now() - startTime,
      pass: allPass,
    };
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}
