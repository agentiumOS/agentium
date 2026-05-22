import type { ModelPricing } from "./types.js";

// Pricing per 1K tokens. Sources: openai.com/api/pricing, docs.anthropic.com/en/docs/about-claude/pricing, ai.google.dev/gemini-api/docs/pricing
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // ── OpenAI: GPT ────────────────────────────────────────────────────────
  "gpt-4.1": { promptPer1k: 0.002, completionPer1k: 0.008, cachedPromptPer1k: 0.0005 },
  "gpt-4.1-mini": { promptPer1k: 0.0004, completionPer1k: 0.0016, cachedPromptPer1k: 0.0001 },
  "gpt-4.1-nano": { promptPer1k: 0.0001, completionPer1k: 0.0004, cachedPromptPer1k: 0.000025 },
  "gpt-4o": { promptPer1k: 0.0025, completionPer1k: 0.01, cachedPromptPer1k: 0.00125 },
  "gpt-4o-mini": { promptPer1k: 0.00015, completionPer1k: 0.0006, cachedPromptPer1k: 0.000075 },
  "gpt-4-turbo": { promptPer1k: 0.01, completionPer1k: 0.03 },
  "gpt-4": { promptPer1k: 0.03, completionPer1k: 0.06 },
  "gpt-3.5-turbo": { promptPer1k: 0.0005, completionPer1k: 0.0015 },

  // ── OpenAI: Reasoning (o-series) ──────────────────────────────────────
  "o4-mini": { promptPer1k: 0.0011, completionPer1k: 0.0044, reasoningPer1k: 0.0044, cachedPromptPer1k: 0.000275 },
  o3: { promptPer1k: 0.002, completionPer1k: 0.008, reasoningPer1k: 0.008, cachedPromptPer1k: 0.0005 },
  "o3-mini": { promptPer1k: 0.0011, completionPer1k: 0.0044, reasoningPer1k: 0.0044, cachedPromptPer1k: 0.000275 },
  o1: { promptPer1k: 0.015, completionPer1k: 0.06, reasoningPer1k: 0.06, cachedPromptPer1k: 0.0075 },
  "o1-mini": { promptPer1k: 0.0011, completionPer1k: 0.0044, reasoningPer1k: 0.0044, cachedPromptPer1k: 0.00055 },

  // ── OpenAI: Audio (Realtime) ──────────────────────────────────────────
  "gpt-4o-realtime-preview": {
    promptPer1k: 0.005,
    completionPer1k: 0.02,
    audioInputPer1k: 0.04,
    audioOutputPer1k: 0.08,
    cachedPromptPer1k: 0.0025,
  },
  "gpt-4o-mini-realtime-preview": {
    promptPer1k: 0.0006,
    completionPer1k: 0.0024,
    audioInputPer1k: 0.01,
    audioOutputPer1k: 0.02,
    cachedPromptPer1k: 0.0003,
  },

  // ── Anthropic: Claude ─────────────────────────────────────────────────
  "claude-opus-4-6": { promptPer1k: 0.005, completionPer1k: 0.025, cachedPromptPer1k: 0.0005 },
  "claude-sonnet-4-6": { promptPer1k: 0.003, completionPer1k: 0.015, cachedPromptPer1k: 0.0003 },
  "claude-haiku-4-5": { promptPer1k: 0.001, completionPer1k: 0.005, cachedPromptPer1k: 0.0001 },
  "claude-sonnet-4-20250514": { promptPer1k: 0.003, completionPer1k: 0.015, cachedPromptPer1k: 0.0003 },
  "claude-haiku-4-5-20251001": { promptPer1k: 0.001, completionPer1k: 0.005, cachedPromptPer1k: 0.0001 },
  "claude-3.5-sonnet": { promptPer1k: 0.003, completionPer1k: 0.015, cachedPromptPer1k: 0.0003 },
  "claude-3.5-haiku": { promptPer1k: 0.0008, completionPer1k: 0.004, cachedPromptPer1k: 0.00008 },
  "claude-3-opus": { promptPer1k: 0.015, completionPer1k: 0.075, cachedPromptPer1k: 0.0015 },
  "claude-3-haiku": { promptPer1k: 0.00025, completionPer1k: 0.00125, cachedPromptPer1k: 0.000025 },

  // ── Google: Gemini ────────────────────────────────────────────────────
  "gemini-2.5-pro": { promptPer1k: 0.00125, completionPer1k: 0.01 },
  "gemini-2.5-flash": { promptPer1k: 0.00015, completionPer1k: 0.0006 },
  "gemini-2.0-flash": { promptPer1k: 0.0001, completionPer1k: 0.0004 },
  "gemini-2.0-flash-lite": { promptPer1k: 0.000075, completionPer1k: 0.0003 },
  "gemini-1.5-pro": { promptPer1k: 0.00125, completionPer1k: 0.005 },
  "gemini-1.5-flash": { promptPer1k: 0.000075, completionPer1k: 0.0003 },

  // ── DeepSeek ──────────────────────────────────────────────────────────
  "deepseek-chat": { promptPer1k: 0.00027, completionPer1k: 0.0011, cachedPromptPer1k: 0.000027 },
  "deepseek-reasoner": {
    promptPer1k: 0.00055,
    completionPer1k: 0.0022,
    reasoningPer1k: 0.0022,
    cachedPromptPer1k: 0.000055,
  },

  // ── Mistral ───────────────────────────────────────────────────────────
  "mistral-large-latest": { promptPer1k: 0.002, completionPer1k: 0.006 },
  "mistral-small-latest": { promptPer1k: 0.0001, completionPer1k: 0.0003 },
  "codestral-latest": { promptPer1k: 0.0003, completionPer1k: 0.0009 },

  // ── xAI: Grok ─────────────────────────────────────────────────────────
  "grok-3": { promptPer1k: 0.003, completionPer1k: 0.015 },
  "grok-3-mini": { promptPer1k: 0.0003, completionPer1k: 0.0005 },

  // ── Cohere ────────────────────────────────────────────────────────────
  "command-r-plus": { promptPer1k: 0.0025, completionPer1k: 0.01 },
  "command-r": { promptPer1k: 0.00015, completionPer1k: 0.0006 },

  // ── Perplexity ────────────────────────────────────────────────────────
  "sonar-pro": { promptPer1k: 0.003, completionPer1k: 0.015 },
  sonar: { promptPer1k: 0.001, completionPer1k: 0.001 },
};

export function lookupPricing(modelId: string, customPricing?: Record<string, ModelPricing>): ModelPricing | undefined {
  if (customPricing?.[modelId]) return customPricing[modelId];
  if (DEFAULT_PRICING[modelId]) return DEFAULT_PRICING[modelId];

  for (const key of Object.keys({ ...DEFAULT_PRICING, ...customPricing })) {
    if (modelId.startsWith(key) || modelId.includes(key)) {
      return customPricing?.[key] ?? DEFAULT_PRICING[key];
    }
  }

  return undefined;
}
