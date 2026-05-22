import type { ModelProvider } from "../models/provider.js";
import type { ChatMessage, ToolCall } from "../models/types.js";
import type { RunOutput } from "./types.js";

export interface ReflectionConfig {
  enabled: boolean;
  maxReflections?: number;
  critic?: ModelProvider;
  preExecutionReview?: boolean;
  loopEscapeDetection?: boolean;
  postMortemLearning?: boolean;
  customCriteria?: string;
}

export interface CritiqueResult {
  pass: boolean;
  score: number;
  feedback: string;
  suggestedRevision?: string;
}

export interface PlanCritiqueResult {
  approved: boolean;
  concerns: string[];
  suggestion?: string;
}

export interface LoopEscapeResult {
  detected: boolean;
  repeatedTool: string;
  repeatCount: number;
  escapePrompt: string;
}

const CRITIQUE_PROMPT = `You are a quality-assurance critic. Evaluate the assistant's response to the user's query.

Score 0.0–1.0 on:
- Correctness: factual accuracy, no hallucinations
- Completeness: addresses all parts of the query
- Relevance: stays on topic, no unnecessary tangents
- Clarity: well-structured, easy to understand

Respond ONLY with valid JSON:
{"pass": boolean, "score": number, "feedback": "string", "suggestedRevision": "string or null"}`;

const PLAN_CRITIQUE_PROMPT = `You are a planning critic. Review the agent's proposed tool calls before execution.

Check for:
- Redundant or unnecessary tool calls
- Missing required information that will cause failures
- Dangerous operations that should have safeguards
- Logical ordering issues

Respond ONLY with valid JSON:
{"approved": boolean, "concerns": ["string"], "suggestion": "string or null"}`;

export class ReflectionManager {
  private config: ReflectionConfig;
  private critic: ModelProvider;
  private toolCallHistory: Array<{ name: string; argsHash: string }> = [];

  constructor(config: ReflectionConfig, defaultModel: ModelProvider) {
    this.config = config;
    this.critic = config.critic ?? defaultModel;
  }

  async critiqueOutput(output: RunOutput, input: string, _messages: ChatMessage[]): Promise<CritiqueResult> {
    const customCriteria = this.config.customCriteria ? `\nAdditional criteria: ${this.config.customCriteria}` : "";

    const critiqueMessages: ChatMessage[] = [
      { role: "system", content: CRITIQUE_PROMPT + customCriteria },
      {
        role: "user",
        content: `User query: ${input}\n\nAssistant response: ${output.text}\n\nEvaluate the response quality.`,
      },
    ];

    try {
      const response = await this.critic.generate(critiqueMessages);
      const text =
        typeof response.message.content === "string"
          ? response.message.content
          : (response.message.content
              ?.filter((p): p is { type: "text"; text: string } => (p as any).type === "text")
              .map((p) => p.text)
              .join("") ?? "");

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { pass: true, score: 0.7, feedback: "Could not parse critique response" };

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        pass: parsed.pass ?? true,
        score: typeof parsed.score === "number" ? parsed.score : 0.7,
        feedback: parsed.feedback ?? "",
        suggestedRevision: parsed.suggestedRevision ?? undefined,
      };
    } catch {
      return { pass: true, score: 0.7, feedback: "Critique unavailable, passing by default" };
    }
  }

  async critiquePlan(toolCalls: ToolCall[], context: string): Promise<PlanCritiqueResult> {
    const toolSummary = toolCalls.map((tc) => `- ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 200)})`).join("\n");

    const critiqueMessages: ChatMessage[] = [
      { role: "system", content: PLAN_CRITIQUE_PROMPT },
      {
        role: "user",
        content: `Context: ${context}\n\nProposed tool calls:\n${toolSummary}\n\nReview these tool calls.`,
      },
    ];

    try {
      const response = await this.critic.generate(critiqueMessages);
      const text =
        typeof response.message.content === "string"
          ? response.message.content
          : (response.message.content
              ?.filter((p): p is { type: "text"; text: string } => (p as any).type === "text")
              .map((p) => p.text)
              .join("") ?? "");

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { approved: true, concerns: [] };

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        approved: parsed.approved ?? true,
        concerns: Array.isArray(parsed.concerns) ? parsed.concerns : [],
        suggestion: parsed.suggestion ?? undefined,
      };
    } catch {
      return { approved: true, concerns: [] };
    }
  }

  detectLoopEscape(toolCalls: ToolCall[]): LoopEscapeResult | null {
    if (!this.config.loopEscapeDetection && this.config.loopEscapeDetection !== undefined) return null;

    for (const tc of toolCalls) {
      const argsHash = JSON.stringify(tc.arguments);
      this.toolCallHistory.push({ name: tc.name, argsHash });
    }

    if (this.toolCallHistory.length > 200) {
      this.toolCallHistory = this.toolCallHistory.slice(-200);
    }

    const recent = this.toolCallHistory.slice(-15);
    const counts = new Map<string, number>();

    for (const entry of recent) {
      const key = `${entry.name}:${entry.argsHash}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    for (const [key, count] of counts) {
      if (count >= 3) {
        const toolName = key.split(":")[0];
        return {
          detected: true,
          repeatedTool: toolName,
          repeatCount: count,
          escapePrompt: `You have called "${toolName}" with the same arguments ${count} times. This appears to be a loop. Try a different approach, use different parameters, or explain what is blocking you from making progress.`,
        };
      }
    }

    return null;
  }

  async generatePostMortem(
    runId: string,
    error: Error,
    toolHistory: ToolCall[],
  ): Promise<{ lesson: string; category: string }> {
    const toolSummary = toolHistory
      .slice(-10)
      .map((tc) => `${tc.name}(${JSON.stringify(tc.arguments).slice(0, 100)})`)
      .join(" → ");

    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          'Analyze this agent failure. Extract a concise lesson (1-2 sentences) that would help avoid this failure in the future. Respond with JSON: {"lesson": "string", "category": "tool_error|loop|context|planning|external"}',
      },
      {
        role: "user",
        content: `Run ${runId} failed.\nError: ${error.message}\nTool sequence: ${toolSummary || "none"}`,
      },
    ];

    try {
      const response = await this.critic.generate(messages);
      const text = typeof response.message.content === "string" ? response.message.content : "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { lesson: error.message, category: "external" };
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        lesson: parsed.lesson ?? error.message,
        category: parsed.category ?? "external",
      };
    } catch {
      return { lesson: `Failed with: ${error.message}`, category: "external" };
    }
  }

  resetHistory(): void {
    this.toolCallHistory = [];
  }
}
