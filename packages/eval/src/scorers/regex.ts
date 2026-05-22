import type { RunOutput } from "@agentium/core";
import type { Scorer, ScorerResult } from "../types.js";

export function regexMatch(pattern: string | RegExp): Scorer {
  const regex = typeof pattern === "string" ? new RegExp(pattern) : pattern;

  return {
    name: "regex",
    async score(_input: string, output: RunOutput): Promise<ScorerResult> {
      regex.lastIndex = 0;
      const pass = regex.test(output.text);

      return {
        score: pass ? 1.0 : 0.0,
        pass,
        reason: pass ? undefined : `Output does not match pattern ${regex}`,
      };
    },
  };
}
