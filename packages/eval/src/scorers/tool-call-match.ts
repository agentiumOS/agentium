import type { Scorer } from "../types.js";

export function toolCallMatch(expectedTools: string[], options: { mode?: "attempted" | "successful" } = {}): Scorer {
  if (options.mode !== undefined && !["attempted", "successful"].includes(options.mode))
    throw new Error("Invalid tool matching mode");
  return {
    name: "toolCallMatch",
    async score(_input, output, _expected) {
      const calledTools = output.toolCalls
        .filter((tc) => options.mode !== "successful" || (!tc.error && !tc.denial))
        .map((tc) => tc.toolName);
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
