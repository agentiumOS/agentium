import { CircuitBreaker, type CircuitBreakerConfig } from "./circuit-breaker.js";
import type { ModelProvider } from "./provider.js";
import type { ChatMessage, ModelConfig, ModelResponse, StreamChunk, ToolDefinition } from "./types.js";

export interface FallbackProviderConfig {
  providers: ModelProvider[];
  circuitBreaker?: Partial<CircuitBreakerConfig>;
  onFallback?: (from: string, to: string, error: unknown) => void;
}

export class FallbackProvider implements ModelProvider {
  readonly providerId = "fallback";
  readonly modelId: string;
  private providers: ModelProvider[];
  private breakers: Map<string, CircuitBreaker>;
  private onFallback?: (from: string, to: string, error: unknown) => void;

  constructor(config: FallbackProviderConfig) {
    if (config.providers.length === 0) {
      throw new Error("FallbackProvider requires at least one provider");
    }
    this.providers = config.providers;
    this.modelId = config.providers[0].modelId;
    this.onFallback = config.onFallback;

    this.breakers = new Map();
    for (const p of config.providers) {
      const key = `${p.providerId}:${p.modelId}`;
      this.breakers.set(key, new CircuitBreaker(config.circuitBreaker));
    }
  }

  private getBreakerKey(p: ModelProvider): string {
    return `${p.providerId}:${p.modelId}`;
  }

  async generate(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): Promise<ModelResponse> {
    let lastError: unknown;

    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i];
      const key = this.getBreakerKey(provider);
      const breaker = this.breakers.get(key)!;

      if (!breaker.canAttempt()) continue;

      try {
        const response = await provider.generate(messages, options);
        breaker.recordSuccess();
        return response;
      } catch (error) {
        lastError = error;
        const classification = breaker.recordFailure(error);

        if (classification === "fatal") throw error;

        const nextProvider = this.providers[i + 1];
        if (nextProvider && this.onFallback) {
          this.onFallback(
            `${provider.providerId}:${provider.modelId}`,
            `${nextProvider.providerId}:${nextProvider.modelId}`,
            error,
          );
        }
      }
    }

    throw lastError ?? new Error("All providers in fallback chain are unavailable");
  }

  async *stream(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): AsyncGenerator<StreamChunk> {
    let lastError: unknown;

    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i];
      const key = this.getBreakerKey(provider);
      const breaker = this.breakers.get(key)!;

      if (!breaker.canAttempt()) continue;

      try {
        const gen = provider.stream(messages, options);
        let firstChunkReceived = false;

        for await (const chunk of gen) {
          if (!firstChunkReceived) {
            firstChunkReceived = true;
            breaker.recordSuccess();
          }
          yield chunk;
        }
        return;
      } catch (error) {
        lastError = error;
        const classification = breaker.recordFailure(error);

        if (classification === "fatal") throw error;

        const nextProvider = this.providers[i + 1];
        if (nextProvider && this.onFallback) {
          this.onFallback(
            `${provider.providerId}:${provider.modelId}`,
            `${nextProvider.providerId}:${nextProvider.modelId}`,
            error,
          );
        }
      }
    }

    throw lastError ?? new Error("All providers in fallback chain are unavailable");
  }

  getBreaker(providerKey: string): CircuitBreaker | undefined {
    return this.breakers.get(providerKey);
  }

  get providerKeys(): string[] {
    return this.providers.map((p) => this.getBreakerKey(p));
  }

  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }
}

export function withFallback(
  providers: ModelProvider[],
  config?: Omit<FallbackProviderConfig, "providers">,
): FallbackProvider {
  return new FallbackProvider({ ...config, providers });
}
