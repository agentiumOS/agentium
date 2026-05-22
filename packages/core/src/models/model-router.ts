import type { ModelProvider } from "./provider.js";
import type { ChatMessage, ModelConfig, ModelResponse, StreamChunk, ToolDefinition } from "./types.js";
import { getTextContent } from "./types.js";

export interface ModelTier {
  model: ModelProvider;
  maxComplexity: number;
}

export interface RoutingRule {
  condition: (messages: ChatMessage[], options?: ModelConfig & { tools?: ToolDefinition[] }) => boolean;
  tier: number;
}

export interface ModelRouterConfig {
  tiers: ModelTier[];
  classifier?: "builtin" | ModelProvider;
  fallbackTier?: number;
  rules?: RoutingRule[];
  outcomeTracking?: boolean;
}

interface OutcomeRecord {
  queryHash: number;
  tierIndex: number;
  success: boolean;
  timestamp: number;
}

const REASONING_KEYWORDS =
  /\b(analyze|compare|contrast|evaluate|synthesize|step.by.step|chain.of.thought|reason|explain.why|pros.and.cons|trade.?offs|debug|refactor)\b/i;
const CODE_MARKERS = /```|function\s|class\s|import\s|const\s|let\s|var\s|def\s|async\s|await\s|\bif\s*\(|\bfor\s*\(/;
const COMPLEX_INSTRUCTIONS =
  /\b(write|implement|create|build|design|architect|generate|produce)\b.*\b(system|application|service|api|pipeline|workflow|module)\b/i;

function simpleHash(text: string): number {
  let hash = 0;
  for (let i = 0; i < Math.min(text.length, 500); i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return hash;
}

export function classifyComplexity(
  messages: ChatMessage[],
  options?: ModelConfig & { tools?: ToolDefinition[] },
): number {
  let score = 0;
  const lastUserMsg = messages.filter((m) => m.role === "user").pop();
  const text = lastUserMsg ? getTextContent(lastUserMsg.content) : "";

  const tokenEstimate = text.length / 4;
  if (tokenEstimate > 2000) score += 0.15;
  else if (tokenEstimate > 500) score += 0.05;

  if (CODE_MARKERS.test(text)) score += 0.15;
  if (REASONING_KEYWORDS.test(text)) score += 0.2;
  if (COMPLEX_INSTRUCTIONS.test(text)) score += 0.15;

  const toolCount = options?.tools?.length ?? 0;
  if (toolCount > 10) score += 0.15;
  else if (toolCount > 3) score += 0.08;

  if (options?.responseFormat && typeof options.responseFormat === "object") score += 0.1;
  if (options?.reasoning?.enabled) score += 0.2;

  const multiTurnDepth = messages.filter((m) => m.role === "assistant").length;
  if (multiTurnDepth > 10) score += 0.1;
  else if (multiTurnDepth > 5) score += 0.05;

  return Math.min(1, score);
}

const MAX_OUTCOME_RECORDS = 1000;

export class ModelRouter implements ModelProvider {
  readonly providerId = "router";
  readonly modelId: string;
  private tiers: ModelTier[];
  private rules: RoutingRule[];
  private fallbackTierIndex: number;
  private outcomes: OutcomeRecord[] = [];
  private outcomeTracking: boolean;

  constructor(config: ModelRouterConfig) {
    if (config.tiers.length === 0) throw new Error("ModelRouter requires at least one tier");

    this.tiers = [...config.tiers].sort((a, b) => a.maxComplexity - b.maxComplexity);
    this.modelId = this.tiers[this.tiers.length - 1].model.modelId;
    this.rules = config.rules ?? [];
    this.fallbackTierIndex = config.fallbackTier ?? this.tiers.length - 1;
    this.outcomeTracking = config.outcomeTracking ?? false;
  }

  selectTier(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): { tierIndex: number; complexity: number; model: ModelProvider } {
    for (const rule of this.rules) {
      if (rule.condition(messages, options)) {
        const idx = Math.min(rule.tier, this.tiers.length - 1);
        return { tierIndex: idx, complexity: -1, model: this.tiers[idx].model };
      }
    }

    const complexity = classifyComplexity(messages, options);

    for (let i = 0; i < this.tiers.length; i++) {
      if (complexity <= this.tiers[i].maxComplexity) {
        return { tierIndex: i, complexity, model: this.tiers[i].model };
      }
    }

    return {
      tierIndex: this.fallbackTierIndex,
      complexity,
      model: this.tiers[this.fallbackTierIndex].model,
    };
  }

  private trackOutcome(messages: ChatMessage[], tierIndex: number, success: boolean): void {
    if (!this.outcomeTracking) return;
    const lastMsg = messages.filter((m) => m.role === "user").pop();
    const text = lastMsg ? getTextContent(lastMsg.content) : "";
    this.outcomes.push({ queryHash: simpleHash(text), tierIndex, success, timestamp: Date.now() });
    if (this.outcomes.length > MAX_OUTCOME_RECORDS) {
      this.outcomes = this.outcomes.slice(-MAX_OUTCOME_RECORDS);
    }
  }

  async generate(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): Promise<ModelResponse> {
    const { tierIndex, model } = this.selectTier(messages, options);

    try {
      const response = await model.generate(messages, options);
      this.trackOutcome(messages, tierIndex, true);
      return response;
    } catch (error) {
      this.trackOutcome(messages, tierIndex, false);
      throw error;
    }
  }

  async *stream(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): AsyncGenerator<StreamChunk> {
    const { tierIndex, model } = this.selectTier(messages, options);

    try {
      yield* model.stream(messages, options);
      this.trackOutcome(messages, tierIndex, true);
    } catch (error) {
      this.trackOutcome(messages, tierIndex, false);
      throw error;
    }
  }

  getOutcomeStats(): { tierIndex: number; total: number; successes: number; rate: number }[] {
    const stats = new Map<number, { total: number; successes: number }>();
    for (const o of this.outcomes) {
      const s = stats.get(o.tierIndex) ?? { total: 0, successes: 0 };
      s.total++;
      if (o.success) s.successes++;
      stats.set(o.tierIndex, s);
    }
    return [...stats.entries()].map(([tierIndex, s]) => ({
      tierIndex,
      total: s.total,
      successes: s.successes,
      rate: s.total > 0 ? s.successes / s.total : 0,
    }));
  }
}
