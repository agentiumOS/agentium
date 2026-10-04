import type { RunOutput } from "@agentium/core";
import type { Scorer, ScorerContext, ScorerResult } from "../types.js";

export function custom(
  name: string,
  fn: (
    input: string,
    output: RunOutput,
    expected?: string,
    context?: ScorerContext,
  ) => Promise<ScorerResult> | ScorerResult,
): Scorer {
  return {
    name,
    async score(input: string, output: RunOutput, expected?: string, context?: ScorerContext): Promise<ScorerResult> {
      return context === undefined ? fn(input, output, expected) : fn(input, output, expected, context);
    },
  };
}
