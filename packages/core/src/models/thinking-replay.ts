import type { ChatMessage } from "./types.js";

export function anthropicReplayContent(msg: ChatMessage): unknown[] | undefined {
  const replay = msg.providerExtras?.anthropicContent;
  return Array.isArray(replay) ? replay : undefined;
}

export function googleReplayParts(msg: ChatMessage): unknown[] | undefined {
  const replay = msg.providerExtras?.googleParts;
  return Array.isArray(replay) ? replay : undefined;
}

export function extrasFromAnthropicContent(content: unknown[] | undefined): Record<string, unknown> | undefined {
  if (
    !content?.some((b) => {
      const type = (b as { type?: string })?.type;
      return type === "thinking" || type === "redacted_thinking" || type === "tool_use";
    })
  ) {
    return undefined;
  }
  return { anthropicContent: content };
}

export function extrasFromGoogleParts(parts: unknown[] | undefined): Record<string, unknown> | undefined {
  if (
    !parts?.some((p) => {
      const part = p as {
        thoughtSignature?: unknown;
        thought_signature?: unknown;
        functionCall?: unknown;
        thought?: unknown;
      };
      return part.thoughtSignature || part.thought_signature || part.functionCall || part.thought;
    })
  ) {
    return undefined;
  }
  return { googleParts: parts };
}

export function applyGoogleThinkingConfig(
  config: Record<string, unknown>,
  modelId: string,
  options?: { reasoning?: { enabled: boolean; effort?: string; budgetTokens?: number } },
): void {
  if (!options?.reasoning?.enabled) return;
  const thinkingConfig: Record<string, unknown> = { includeThoughts: true };
  if (/gemini-3/i.test(modelId)) {
    thinkingConfig.thinkingLevel = geminiThinkingLevel(options.reasoning.effort);
  } else {
    thinkingConfig.thinkingBudget = options.reasoning.budgetTokens ?? 10000;
  }
  config.thinkingConfig = thinkingConfig;
}

function geminiThinkingLevel(effort?: string): string {
  switch (effort) {
    case "none":
    case "minimal":
      return "MINIMAL";
    case "low":
      return "LOW";
    case "high":
    case "xhigh":
    case "max":
      return "HIGH";
    default:
      return "MEDIUM";
  }
}
