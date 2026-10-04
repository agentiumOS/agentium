import type { Agent } from "@agentium/core";
import { EvalInterruption, runCases, scoresPass, successful, validateConfig } from "./case-lifecycle.js";
import type { EvalCase, Reporter, ScorerResult } from "./types.js";
export interface ReliabilityEvalConfig {
  name: string;
  agent: Agent;
  cases: Array<EvalCase & { expectedTools?: string[]; shouldError?: boolean }>;
  threshold?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class ReliabilityEval {
  constructor(private config: ReliabilityEvalConfig) {
    validateConfig(config);
  }
  run(reporters?: Reporter[]) {
    return runCases(
      this.config,
      async (item, life) => {
        let output;
        try {
          output = await life.agent(this.config.agent, item);
        } catch (error) {
          life.check();
          if (!item.shouldError || error instanceof EvalInterruption) throw error;
          return {
            scores: {
              errorHandling: {
                score: 1,
                pass: true,
                reason: `Got expected error: ${error instanceof Error ? error.message : String(error)}`,
              },
            },
            pass: true,
          };
        }
        const complete = successful(output);
        const scores: Record<string, ScorerResult> = item.shouldError
          ? { errorHandling: { score: 0, pass: false, reason: "Expected an error but got success" } }
          : {
              completion: {
                score: complete ? 1 : 0,
                pass: complete,
                reason: complete ? "Completed without error" : `Run ended with status ${output.status}`,
              },
            };
        if (item.expectedTools?.length) {
          const called = output.toolCalls.filter((tc) => !tc.error && !tc.denial).map((tc) => tc.toolName);
          const count = item.expectedTools.filter((t) => called.includes(t)).length;
          scores.toolCalls = {
            score: count / item.expectedTools.length,
            pass: count === item.expectedTools.length,
            reason: `Successfully called ${count}/${item.expectedTools.length} expected tools`,
          };
        }
        const nonEmpty = output.text.trim().length > 0;
        scores.nonEmpty = {
          score: nonEmpty ? 1 : 0,
          pass: nonEmpty,
          reason: nonEmpty ? "Non-empty response" : "Empty response",
        };
        return { output, scores, pass: complete && scoresPass(scores, this.config.threshold ?? 0.7) };
      },
      reporters,
    );
  }
}
