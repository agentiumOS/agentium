import type { ModelProvider, RunOutput } from "@agentium/core";
import type { Scorer, ScorerResult } from "../types.js";

export type JudgeCriteria = "faithfulness" | "relevance" | "helpfulness" | "safety" | "conciseness";

export function llmJudge(config: {
  model: ModelProvider;
  criteria?: JudgeCriteria[];
  customPrompt?: string;
  threshold?: number;
}): Scorer {
  const criteria = config.criteria ?? ["relevance", "helpfulness"];

  return {
    name: "llm-judge",
    async score(input: string, output: RunOutput, expected?: string): Promise<ScorerResult> {
      const criteriaList = criteria.map((c) => `- ${c}`).join("\n");

      const prompt =
        config.customPrompt ??
        `You are an expert evaluator. Rate the following AI response on a scale of 0.0 to 1.0.

Criteria:
${criteriaList}

User input: ${input}
${expected ? `Expected output: ${expected}\n` : ""}
AI response: ${output.text}

Respond with ONLY a JSON object: {"score": <0.0-1.0>, "reason": "<brief explanation>"}`;

      try {
        const response = await config.model.generate([{ role: "user", content: prompt }]);

        const text = typeof response.message.content === "string" ? response.message.content : "";

        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          return { score: 0, pass: false, reason: "Judge failed to return valid JSON" };
        }

        const parsed = JSON.parse(jsonMatch[0]);
        const score = Math.max(0, Math.min(1, Number(parsed.score) || 0));

        return {
          score,
          pass: score >= (config.threshold ?? 0.7),
          reason: parsed.reason ?? undefined,
        };
      } catch (err) {
        return {
          score: 0,
          pass: false,
          reason: `Judge error: ${(err as Error).message}`,
        };
      }
    },
  };
}
