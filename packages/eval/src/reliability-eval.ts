import type { Agent } from "@agentium/core";
import { getTextContent } from "@agentium/core";
import type { EvalCase, EvalResult, Reporter, ScorerResult } from "./types.js";

export interface ReliabilityEvalConfig {
  name: string;
  agent: Agent;
  cases: Array<EvalCase & { expectedTools?: string[]; shouldError?: boolean }>;
  threshold?: number;
  timeoutMs?: number;
}

export class ReliabilityEval {
  private config: ReliabilityEvalConfig;

  constructor(config: ReliabilityEvalConfig) {
    this.config = config;
  }

  async run(reporters?: Reporter[]) {
    const startTime = Date.now();
    const threshold = this.config.threshold ?? 0.7;
    const results: EvalResult[] = [];

    for (const evalCase of this.config.cases) {
      results.push(await this.runCase(evalCase, threshold));
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

  private async runCase(
    evalCase: EvalCase & { expectedTools?: string[]; shouldError?: boolean },
    threshold: number,
  ): Promise<EvalResult> {
    const startTime = Date.now();
    const inputText = typeof evalCase.input === "string" ? evalCase.input : getTextContent(evalCase.input);
    const scores: Record<string, ScorerResult> = {};

    try {
      const timeoutMs = this.config.timeoutMs ?? 30000;
      const output = await Promise.race([
        this.config.agent.run(evalCase.input, evalCase.runOpts),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);

      if (evalCase.shouldError) {
        scores.errorHandling = { score: 0, pass: false, reason: "Expected an error but got success" };
      } else {
        scores.completion = { score: 1, pass: true, reason: "Completed without error" };
      }

      if (evalCase.expectedTools && evalCase.expectedTools.length > 0) {
        const calledTools = output.toolCalls.map((tc) => tc.toolName);
        const matched = evalCase.expectedTools.filter((t) => calledTools.includes(t));
        const score = matched.length / evalCase.expectedTools.length;
        scores.toolCalls = {
          score,
          pass: score >= threshold,
          reason: `Called ${matched.length}/${evalCase.expectedTools.length} expected tools: [${matched.join(", ")}]`,
        };
      }

      const nonEmpty = output.text.trim().length > 0;
      scores.nonEmpty = {
        score: nonEmpty ? 1 : 0,
        pass: nonEmpty,
        reason: nonEmpty ? "Non-empty response" : "Empty response",
      };

      const avgScore = Object.values(scores).reduce((s, r) => s + r.score, 0) / Object.keys(scores).length;

      return {
        caseName: evalCase.name,
        input: inputText,
        output,
        scores,
        durationMs: Date.now() - startTime,
        pass: avgScore >= threshold,
      };
    } catch (err) {
      if (evalCase.shouldError) {
        scores.errorHandling = { score: 1, pass: true, reason: `Got expected error: ${(err as Error).message}` };
        return {
          caseName: evalCase.name,
          input: inputText,
          scores,
          durationMs: Date.now() - startTime,
          pass: true,
        };
      }

      scores.completion = { score: 0, pass: false, reason: `Unexpected error: ${(err as Error).message}` };
      return {
        caseName: evalCase.name,
        input: inputText,
        scores,
        durationMs: Date.now() - startTime,
        pass: false,
        error: (err as Error).message,
      };
    }
  }
}
