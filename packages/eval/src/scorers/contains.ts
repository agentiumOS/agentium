import type { RunOutput } from "@agentium/core";
import type { Scorer, ScorerResult } from "../types.js";

export function contains(expected: string, options?: { caseSensitive?: boolean }): Scorer {
  const caseSensitive = options?.caseSensitive ?? false;

  return {
    name: "contains",
    async score(_input: string, output: RunOutput, _expected?: string): Promise<ScorerResult> {
      const text = caseSensitive ? (output.text ?? "") : (output.text ?? "").toLowerCase();
      const target = caseSensitive ? expected : expected.toLowerCase();
      const pass = text.includes(target);

      return {
        score: pass ? 1.0 : 0.0,
        pass,
        reason: pass ? undefined : `Output does not contain "${expected}"`,
      };
    },
  };
}
