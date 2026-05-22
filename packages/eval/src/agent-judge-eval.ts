import type { Agent, ModelProvider, RunOutput } from "@agentium/core";
import { getTextContent } from "@agentium/core";
import type { EvalCase, EvalResult, Reporter, ScorerResult } from "./types.js";

export interface AgentJudgeEvalConfig {
  name: string;
  agent: Agent;
  cases: EvalCase[];
  judge: ModelProvider;
  criteria: string[];
  scoringMode?: "numeric" | "binary";
  threshold?: number;
  timeoutMs?: number;
}

export class AgentJudgeEval {
  private config: AgentJudgeEvalConfig;

  constructor(config: AgentJudgeEvalConfig) {
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

      const scores = await this.judgeWithCriteria(inputText, output, evalCase.expected);
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
      return {
        caseName: evalCase.name,
        input: inputText,
        scores: {},
        durationMs: Date.now() - startTime,
        pass: false,
        error: (err as Error).message,
      };
    }
  }

  private async judgeWithCriteria(
    input: string,
    output: RunOutput,
    expected?: string,
  ): Promise<Record<string, ScorerResult>> {
    const mode = this.config.scoringMode ?? "numeric";
    const results: Record<string, ScorerResult> = {};

    for (const criterion of this.config.criteria) {
      const prompt =
        mode === "binary"
          ? `Evaluate if the response meets this criterion: "${criterion}"

Input: ${input}
${expected ? `Expected: ${expected}` : ""}
Response: ${output.text}

Answer ONLY "PASS" or "FAIL".`
          : `Score from 0.0 to 1.0 how well the response meets this criterion: "${criterion}"

Input: ${input}
${expected ? `Expected: ${expected}` : ""}
Response: ${output.text}

Return ONLY a number between 0.0 and 1.0.`;

      try {
        const response = await this.config.judge.generate([{ role: "user", content: prompt }], {
          maxTokens: 10,
          temperature: 0,
        });
        const text = (getTextContent(response.message.content) ?? "").trim();

        if (mode === "binary") {
          const pass = text.toUpperCase().includes("PASS");
          results[criterion] = { score: pass ? 1 : 0, pass, reason: text };
        } else {
          const score = Number.parseFloat(text);
          const s = Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0;
          results[criterion] = { score: s, pass: s >= (this.config.threshold ?? 0.7), reason: `Score: ${s}` };
        }
      } catch (err) {
        results[criterion] = { score: 0, pass: false, reason: `Judge error: ${(err as Error).message}` };
      }
    }

    return results;
  }
}
