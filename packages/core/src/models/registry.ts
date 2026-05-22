import type { GoogleVisionLiveConfig } from "../vision/providers/google-vision-live.js";
import { GoogleVisionLiveProvider } from "../vision/providers/google-vision-live.js";
import type { VisionProvider } from "../vision/types.js";
import type { GoogleLiveConfig } from "../voice/providers/google-live.js";
import { GoogleLiveProvider } from "../voice/providers/google-live.js";
import type { OpenAIRealtimeConfig } from "../voice/providers/openai-realtime.js";
import { OpenAIRealtimeProvider } from "../voice/providers/openai-realtime.js";
import type { RealtimeProvider } from "../voice/types.js";
import type { ModelProvider } from "./provider.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { type AwsBedrockConfig, AwsBedrockProvider } from "./providers/aws-bedrock.js";
import { type AwsClaudeConfig, AwsClaudeProvider } from "./providers/aws-claude.js";
import { type AzureFoundryConfig, AzureFoundryProvider } from "./providers/azure-foundry.js";
import { type AzureOpenAIConfig, AzureOpenAIProvider } from "./providers/azure-openai.js";
import { type CohereConfig, CohereProvider } from "./providers/cohere.js";
import { type DeepSeekConfig, DeepSeekProvider } from "./providers/deepseek.js";
import { GoogleProvider } from "./providers/google.js";
import { type MetaLlamaConfig, MetaLlamaProvider } from "./providers/meta-llama.js";
import { type MistralConfig, MistralProvider } from "./providers/mistral.js";
import { OllamaProvider } from "./providers/ollama.js";
import { OpenAIProvider } from "./providers/openai.js";
import { type PerplexityConfig, PerplexityProvider } from "./providers/perplexity.js";
import { type VercelConfig, VercelProvider } from "./providers/vercel.js";
import { VertexAIProvider } from "./providers/vertex.js";
import { type XAIConfig, XAIProvider } from "./providers/xai.js";

type ProviderFactory = (modelId: string, config?: any) => ModelProvider;

export class ModelRegistry {
  private factories = new Map<string, ProviderFactory>();

  register(providerId: string, factory: ProviderFactory): void {
    this.factories.set(providerId, factory);
  }

  resolve(providerId: string, modelId: string, config?: any): ModelProvider {
    const factory = this.factories.get(providerId);
    if (!factory) {
      throw new Error(`Unknown provider "${providerId}". Register it first with registry.register().`);
    }
    return factory(modelId, config);
  }

  has(providerId: string): boolean {
    return this.factories.has(providerId);
  }
}

export const modelRegistry = new ModelRegistry();

modelRegistry.register(
  "openai",
  (modelId, config) => new OpenAIProvider(modelId, config as { apiKey?: string; baseURL?: string }),
);

modelRegistry.register("anthropic", (modelId, config) => new AnthropicProvider(modelId, config as { apiKey?: string }));

modelRegistry.register("google", (modelId, config) => new GoogleProvider(modelId, config as { apiKey?: string }));

modelRegistry.register("ollama", (modelId, config) => new OllamaProvider(modelId, config as { host?: string }));

export function openai(modelId: string, config?: { apiKey?: string; baseURL?: string }): ModelProvider {
  return modelRegistry.resolve("openai", modelId, config);
}

export function anthropic(modelId: string, config?: { apiKey?: string }): ModelProvider {
  return modelRegistry.resolve("anthropic", modelId, config);
}

export function google(modelId: string, config?: { apiKey?: string }): ModelProvider {
  return modelRegistry.resolve("google", modelId, config);
}

export function ollama(modelId: string, config?: { host?: string }): ModelProvider {
  return modelRegistry.resolve("ollama", modelId, config);
}

modelRegistry.register(
  "vertex",
  (modelId, config) =>
    new VertexAIProvider(modelId, config as { project?: string; location?: string; credentials?: string }),
);

export function vertex(
  modelId: string,
  config?: { project?: string; location?: string; credentials?: string },
): ModelProvider {
  return modelRegistry.resolve("vertex", modelId, config);
}

// ── AWS providers ─────────────────────────────────────────────────────

modelRegistry.register("aws-bedrock", (modelId, config) => new AwsBedrockProvider(modelId, config as AwsBedrockConfig));

modelRegistry.register("aws-claude", (modelId, config) => new AwsClaudeProvider(modelId, config as AwsClaudeConfig));

export function awsBedrock(modelId: string, config?: AwsBedrockConfig): ModelProvider {
  return modelRegistry.resolve("aws-bedrock", modelId, config);
}

export function awsClaude(modelId: string, config?: AwsClaudeConfig): ModelProvider {
  return modelRegistry.resolve("aws-claude", modelId, config);
}

// ── Azure providers ───────────────────────────────────────────────────

modelRegistry.register(
  "azure-openai",
  (modelId, config) => new AzureOpenAIProvider(modelId, config as AzureOpenAIConfig),
);

modelRegistry.register(
  "azure-foundry",
  (modelId, config) => new AzureFoundryProvider(modelId, config as AzureFoundryConfig),
);

export function azureOpenai(modelId: string, config?: AzureOpenAIConfig): ModelProvider {
  return modelRegistry.resolve("azure-openai", modelId, config);
}

export function azureFoundry(modelId: string, config?: AzureFoundryConfig): ModelProvider {
  return modelRegistry.resolve("azure-foundry", modelId, config);
}

// ── Additional native providers ───────────────────────────────────────

modelRegistry.register("deepseek", (modelId, config) => new DeepSeekProvider(modelId, config as DeepSeekConfig));
modelRegistry.register("mistral", (modelId, config) => new MistralProvider(modelId, config as MistralConfig));
modelRegistry.register("xai", (modelId, config) => new XAIProvider(modelId, config as XAIConfig));
modelRegistry.register("perplexity", (modelId, config) => new PerplexityProvider(modelId, config as PerplexityConfig));
modelRegistry.register("cohere", (modelId, config) => new CohereProvider(modelId, config as CohereConfig));
modelRegistry.register("meta", (modelId, config) => new MetaLlamaProvider(modelId, config as MetaLlamaConfig));
modelRegistry.register("vercel", (modelId, config) => new VercelProvider(modelId, config as VercelConfig));

export function deepseek(modelId: string, config?: DeepSeekConfig): ModelProvider {
  return modelRegistry.resolve("deepseek", modelId, config);
}

export function mistral(modelId: string, config?: MistralConfig): ModelProvider {
  return modelRegistry.resolve("mistral", modelId, config);
}

export function xai(modelId: string, config?: XAIConfig): ModelProvider {
  return modelRegistry.resolve("xai", modelId, config);
}

export function perplexity(modelId: string, config?: PerplexityConfig): ModelProvider {
  return modelRegistry.resolve("perplexity", modelId, config);
}

export function cohere(modelId: string, config?: CohereConfig): ModelProvider {
  return modelRegistry.resolve("cohere", modelId, config);
}

export function meta(modelId: string, config?: MetaLlamaConfig): ModelProvider {
  return modelRegistry.resolve("meta", modelId, config);
}

export function vercel(modelId: string, config?: VercelConfig): ModelProvider {
  return modelRegistry.resolve("vercel", modelId, config);
}

// ── Realtime / Voice provider helpers ─────────────────────────────────

/**
 * Shorthand for `new OpenAIRealtimeProvider(modelId, config)`.
 *
 * @example
 * const agent = new VoiceAgent({
 *   provider: openaiRealtime("gpt-4o-realtime-preview"),
 * });
 */
export function openaiRealtime(modelId?: string, config?: OpenAIRealtimeConfig): RealtimeProvider {
  return new OpenAIRealtimeProvider(modelId, config);
}

/**
 * Shorthand for `new GoogleLiveProvider(modelId, config)`.
 *
 * @example
 * const agent = new VoiceAgent({
 *   provider: googleLive(),
 * });
 */
export function googleLive(modelId?: string, config?: GoogleLiveConfig): RealtimeProvider {
  return new GoogleLiveProvider(modelId, config);
}

/**
 * Shorthand for `new GoogleVisionLiveProvider(modelId, config)`.
 *
 * @example
 * const agent = new VisionAgent({
 *   provider: geminiVisionLive(),
 * });
 */
export function geminiVisionLive(modelId?: string, config?: GoogleVisionLiveConfig): VisionProvider {
  return new GoogleVisionLiveProvider(modelId, config);
}

// ── Model resilience helpers ──────────────────────────────────────────

export { CircuitBreaker, defaultClassifyError } from "./circuit-breaker.js";
export { FallbackProvider, withFallback } from "./fallback-provider.js";
export { classifyComplexity, ModelRouter } from "./model-router.js";
