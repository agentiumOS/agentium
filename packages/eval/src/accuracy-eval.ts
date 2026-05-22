import type { Agent, ModelProvider, RunOutput } from "@agentium/core";
import { getTextContent } from "@agentium/core";
import type { EvalCase, EvalResult, Reporter } from "./types.js";

export interface AccuracyEvalConfig {
  name: string;
  agent: Agent;
  cases: EvalCase[];
  judge: ModelProvider;
  threshold?: number;
  timeoutMs?: number;
}

export class AccuracyEval {
  private config: AccuracyEvalConfig;

  constructor(config: AccuracyEvalConfig) {
    this.config = config;
  }

  async run(reporters?: Reporter[]) {
    const startTime = Date.now();
    const threshold = this.config.threshold ?? 0.7;
    const results: EvalResult[] = [];

    for (const evalCase of this.config.cases) {
      const result = await this.runCase(evalCase, threshold);
      results.push(result);
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

  private async runCase(evalCase: EvalCase, threshold: number): Promise<EvalResult> {
    const startTime = Date.now();
    const inputText = typeof evalCase.input === "string" ? evalCase.input : getTextContent(evalCase.input);

    try {
      const timeoutMs = this.config.timeoutMs ?? 30000;
      const output = await Promise.race([
        this.config.agent.run(evalCase.input, evalCase.runOpts),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);

      const score = await this.judgeAccuracy(inputText, output, evalCase.expected);

      return {
        caseName: evalCase.name,
        input: inputText,
        output,
        scores: { accuracy: { score, pass: score >= threshold, reason: `Accuracy score: ${score}` } },
        durationMs: Date.now() - startTime,
        pass: score >= threshold,
      };
    } catch (err) {
      return {
        caseName: evalCase.name,
        input: inputText,
        scores: { accuracy: { score: 0, pass: false, reason: `Error: ${(err as Error).message}` } },
        durationMs: Date.now() - startTime,
        pass: false,
        error: (err as Error).message,
      };
    }
  }

  private async judgeAccuracy(input: string, output: RunOutput, expected?: string): Promise<number> {
    const prompt = `You are an accuracy evaluator. Score from 0.0 to 1.0 how accurately the response answers the input.

Input: ${input}
${expected ? `Expected answer: ${expected}` : ""}
Actual response: ${output.text}

Return ONLY a number between 0.0 and 1.0, nothing else.`;

    const response = await this.config.judge.generate([{ role: "user", content: prompt }], {
      maxTokens: 10,
      temperature: 0,
    });
    const text = getTextContent(response.message.content);
    const score = Number.parseFloat(text?.trim() ?? "0");
    return Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0;
  }
}
