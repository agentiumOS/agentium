import type { Agent, ModelProvider } from "@agentium/core";
import { positive, validateConfig, validateScorers } from "../case-lifecycle.js";
import type { Reporter } from "../types.js";
import { ConversationRunner } from "./scenario-runner.js";
import type { ConversationEvalResult, ConversationSuiteConfig, ConversationSuiteResult } from "./types.js";

export class ConversationSuite {
  private config: ConversationSuiteConfig;
  private model: ModelProvider;

  constructor(config: ConversationSuiteConfig, model: ModelProvider) {
    validateConfig(config);
    validateScorers(config.scorers ?? []);
    for (const scenario of config.scenarios) {
      positive(scenario.persona.maxTurns ?? 20, "maxTurns");
      if (!scenario.successCriteria.trim()) throw new Error("Conversation success criteria must not be empty");
    }
    this.config = config;
    this.model = config.judgeModel ?? model;
  }

  async run(agent: Agent, reporters?: Reporter[]): Promise<ConversationSuiteResult> {
    const startTime = Date.now();
    const runner = new ConversationRunner(this.model);
    const concurrency = this.config.concurrency ?? 1;
    const results: ConversationEvalResult[] = [];

    const scenarios = [...this.config.scenarios];
    for (let i = 0; i < scenarios.length; i += concurrency) {
      const batch = scenarios.slice(i, i + concurrency);
      const batchResults = await Promise.allSettled(
        batch.map((scenario) =>
          runner.run(agent, scenario, this.config.scorers, {
            timeoutMs: this.config.timeoutMs,
            signal: this.config.signal,
          }),
        ),
      );

      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];
        if (result.status === "fulfilled") {
          results.push(result.value);
        } else {
          results.push({
            caseName: batch[j].name,
            input: batch[j].initialMessage,
            scores: {},
            durationMs: 0,
            pass: false,
            error: result.reason?.message ?? "Unknown error",
            turns: [],
            turnCount: 0,
          });
        }
      }
    }

    const passed = results.filter((r) => r.pass).length;
    const scoreValues = results.flatMap((r) => Object.values(r.scores).map((s) => s.score));
    const averageScore = scoreValues.length > 0 ? scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length : 0;
    const averageTurns = results.length > 0 ? results.reduce((a, r) => a + r.turnCount, 0) / results.length : 0;

    const suiteResult: ConversationSuiteResult = {
      name: this.config.name,
      results,
      passed,
      failed: results.length - passed,
      total: results.length,
      averageTurns,
      averageScore,
      durationMs: Date.now() - startTime,
    };

    if (reporters) {
      for (const reporter of reporters) {
        await reporter.report(suiteResult as any);
      }
    }

    return suiteResult;
  }
}
