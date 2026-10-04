import {
  inputText,
  runCases,
  scoresPass,
  successful,
  validateConfig,
  validateScore,
  validateScorers,
} from "./case-lifecycle.js";
import type { EvalSuiteConfig, Reporter, ScorerResult } from "./types.js";
export class EvalSuite {
  constructor(private config: EvalSuiteConfig) {
    validateConfig(config);
    validateScorers(config.scorers, true);
  }
  run(reporters?: Reporter[]) {
    return runCases(
      this.config,
      async (item, life) => {
        const output = await life.agent(this.config.agent, item);
        const scores: Record<string, ScorerResult> = Object.create(null);
        for (const scorer of this.config.scorers) {
          life.check();
          try {
            scores[scorer.name] = validateScore(
              await life.wait(() => scorer.score(inputText(item), output, item.expected, life)),
            );
          } catch (error) {
            life.check();
            scores[scorer.name] = {
              score: 0,
              pass: false,
              reason: error instanceof Error ? error.message : String(error),
            };
          }
        }
        return { output, scores, pass: successful(output) && scoresPass(scores, this.config.threshold ?? 0.7) };
      },
      reporters,
    );
  }
}
