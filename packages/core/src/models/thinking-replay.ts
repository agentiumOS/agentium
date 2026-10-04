import type { ChatMessage, ProviderOptions, ReasoningConfig } from "./types.js";

export function anthropicReplayContent(msg: ChatMessage): unknown[] | undefined {
  if (
    msg.providerExtras?.responsesReplay ||
    msg.providerExtras?.responsesReasoning ||
    msg.providerExtras?.googleParts
  ) {
    throw new Error("Foreign provider continuation cannot be replayed through Anthropic; start a new session");
  }
  const replay = msg.providerExtras?.anthropicContent;
  return Array.isArray(replay) ? replay : undefined;
}

export function googleReplayParts(msg: ChatMessage): unknown[] | undefined {
  if (
    msg.providerExtras?.responsesReplay ||
    msg.providerExtras?.responsesReasoning ||
    msg.providerExtras?.anthropicContent
  ) {
    throw new Error("Foreign provider continuation cannot be replayed through Gemini; start a new session");
  }
  const replay = msg.providerExtras?.googleParts;
  return Array.isArray(replay) ? replay : undefined;
}

export function extrasFromAnthropicContent(content: unknown[] | undefined): Record<string, unknown> | undefined {
  if (
    !content?.some((b) => {
      const type = (b as { type?: string })?.type;
      return type === "thinking" || type === "redacted_thinking" || type === "tool_use" || type === "compaction";
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

/** Opus/Sonnet 4.6+ and Claude 5 / Fable / Mythos reject `thinking.type: enabled`. */
export function anthropicUsesAdaptiveThinking(modelId: string): boolean {
  const id = modelId.toLowerCase();
  if (/claude-(fable|mythos)/.test(id)) return true;
  if (/claude-(opus|sonnet|haiku|fable|mythos)-5/.test(id)) return true;
  const minor = id.match(/^claude-(opus|sonnet)-4[.-](\d{1,2})(?:\b|-|$)/);
  return minor !== null && Number(minor[2]) >= 6;
}

function anthropicEffort(effort?: string): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  if (effort === "minimal") return "low";
  if (effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh" || effort === "max") {
    return effort;
  }
  return undefined;
}

/**
 * Sets Claude thinking, effort, prompt cache, and server context edits.
 * Returns an `anthropic-beta` header when compaction or tool-result clearing is on.
 */
export function applyAnthropicThinking(
  params: Record<string, unknown>,
  modelId: string,
  options?: { reasoning?: ReasoningConfig; providerOptions?: ProviderOptions },
): Record<string, string> | undefined {
  const reasoning = options?.reasoning;
  if (reasoning?.enabled) {
    delete params.temperature;
    delete params.top_p;
    if (anthropicUsesAdaptiveThinking(modelId)) {
      params.thinking = { type: "adaptive", display: "summarized" };
    } else {
      const budget = reasoning.budgetTokens ?? 10000;
      const maxTokens = Number(params.max_tokens ?? 4096);
      if (maxTokens < budget + 1024) params.max_tokens = budget + 4096;
      params.thinking = { type: "enabled", budget_tokens: budget, display: "summarized" };
    }
    const effort = anthropicEffort(reasoning.effort);
    if (effort) params.output_config = { effort };
  }

  const provider = options?.providerOptions;
  if (provider?.promptCache && typeof params.system === "string") {
    params.system = [{ type: "text", text: params.system, cache_control: { type: "ephemeral" } }];
  }

  const edits: unknown[] = [];
  const betas: string[] = [];
  if (provider?.clearToolResults) {
    edits.push({ type: "clear_tool_uses_20250919" });
    betas.push("context-management-2025-06-27");
  }
  if (provider?.compactionTokens) {
    edits.push({
      type: "compact_20260112",
      trigger: { type: "input_tokens", value: Math.max(50_000, provider.compactionTokens) },
    });
    betas.push("compact-2026-01-12");
  }
  if (edits.length) params.context_management = { edits };
  return betas.length ? { "anthropic-beta": betas.join(",") } : undefined;
}

/** Gemini 3.8+ sampling fields, media resolution, cache, and Search grounding. */
export function applyGoogleRequestExtras(
  config: Record<string, unknown>,
  modelId: string,
  options?: { providerOptions?: ProviderOptions },
): void {
  if (/gemini-3\.(?:[8-9]|\d{2,})/i.test(modelId)) {
    delete config.temperature;
    delete config.topP;
  }
  const provider = options?.providerOptions;
  if (!provider) return;
  if (provider.mediaResolution) {
    config.mediaResolution = `MEDIA_RESOLUTION_${provider.mediaResolution.toUpperCase()}`;
  }
  if (provider.cachedContent) config.cachedContent = provider.cachedContent;
  if (provider.googleSearch) {
    const tools = Array.isArray(config.tools) ? [...config.tools] : [];
    tools.push({ googleSearch: {} });
    config.tools = tools;
  }
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
