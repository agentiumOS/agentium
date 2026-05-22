import type { Scorer } from "../types.js";

export function toolCallMatch(expectedTools: string[]): Scorer {
  return {
    name: "toolCallMatch",
    async score(_input, output, _expected) {
      const calledTools = output.toolCalls.map((tc) => tc.toolName);
      const matched = expectedTools.filter((t) => calledTools.includes(t));
      const score = expectedTools.length > 0 ? matched.length / expectedTools.length : 1;
      return {
        score,
        pass: score >= 0.7,
        reason: `Matched ${matched.length}/${expectedTools.length} tools: [${matched.join(", ")}]`,
      };
    },
  };
}
