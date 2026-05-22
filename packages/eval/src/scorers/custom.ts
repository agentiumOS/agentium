import type { RunOutput } from "@agentium/core";
import type { Scorer, ScorerResult } from "../types.js";

export function custom(
  name: string,
  fn: (input: string, output: RunOutput, expected?: string) => Promise<ScorerResult> | ScorerResult,
): Scorer {
  return {
    name,
    async score(input: string, output: RunOutput, expected?: string): Promise<ScorerResult> {
      return fn(input, output, expected);
    },
  };
}
