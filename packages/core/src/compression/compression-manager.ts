import type { ModelProvider } from "../models/provider.js";
import { type ChatMessage, getTextContent } from "../models/types.js";
import { countMessagesTokens } from "../utils/token-counter.js";

export interface CompressionManagerConfig {
  /** Model used for compression summaries. Falls back to main model if not set. */
  model?: ModelProvider;
  /** Compress after N uncompressed tool results. Default: 3. */
  compressAfter?: number;
  /** Compress when total context exceeds this token count. Takes priority over compressAfter. */
  tokenLimit?: number;
  /** Custom compression prompt. */
  instructions?: string;
}

const DEFAULT_COMPRESS_AFTER = 3;

const DEFAULT_COMPRESS_PROMPT = `Summarize the following tool result concisely, preserving ALL key data points:
- Keep numbers, dates, IDs, URLs, and proper nouns exactly as-is
- Use structured formats (lists, key-value pairs) over prose
- Do NOT omit any numeric values or identifiers
- Keep the summary under 500 tokens

Tool result:
`;

export class CompressionManager {
  private readonly config: CompressionManagerConfig;
  private model: ModelProvider | null;
  private uncompressedToolCount = 0;

  constructor(config: CompressionManagerConfig) {
    this.config = config;
    this.model = config.model ?? null;
  }

  /**
   * Set the fallback model (used when config.model is not provided).
   * Called by the Agent with its primary model so compression can work without explicit model config.
   */
  setFallbackModel(model: ModelProvider): void {
    if (!this.config.model) {
      this.model = model;
    }
  }

  /** Reset per-run state. Call at the start of each agent run. */
  reset(): void {
    this.uncompressedToolCount = 0;
  }

  /**
   * Process messages before an LLM call. Compresses tool results when thresholds are exceeded.
   * Designed to be called from the LoopHooks.beforeLLMCall hook.
   */
  async process(messages: ChatMessage[], modelId?: string): Promise<ChatMessage[] | undefined> {
    const shouldCompress = this.shouldCompress(messages, modelId);
    if (!shouldCompress) return undefined;

    const compressed = await this.compressToolResults(messages);
    this.uncompressedToolCount = 0;
    return compressed;
  }

  /** Track tool result additions to count toward compressAfter threshold. */
  trackToolResult(): void {
    this.uncompressedToolCount++;
  }

  private shouldCompress(messages: ChatMessage[], modelId?: string): boolean {
    if (this.config.tokenLimit) {
      const tokens = countMessagesTokens(messages, modelId);
      return tokens > this.config.tokenLimit;
    }

    const threshold = this.config.compressAfter ?? DEFAULT_COMPRESS_AFTER;
    return this.uncompressedToolCount >= threshold;
  }

  private async compressToolResults(messages: ChatMessage[]): Promise<ChatMessage[]> {
    if (!this.model) return messages;

    const result: ChatMessage[] = [];
    const compressPromises: Array<{ index: number; promise: Promise<string> }> = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === "tool" && typeof msg.content === "string" && msg.content.length > 200) {
        compressPromises.push({
          index: i,
          promise: this.compressSingle(msg.content),
        });
        result.push(msg);
      } else {
        result.push(msg);
      }
    }

    if (compressPromises.length === 0) return messages;

    const settled = await Promise.allSettled(compressPromises.map((p) => p.promise));

    for (let j = 0; j < compressPromises.length; j++) {
      const outcome = settled[j];
      const idx = compressPromises[j].index;
      if (outcome.status === "fulfilled" && outcome.value) {
        result[idx] = { ...result[idx], content: outcome.value };
      }
    }

    return result;
  }

  private async compressSingle(content: string): Promise<string> {
    if (!this.model) return content;

    try {
      const prompt = this.config.instructions ?? DEFAULT_COMPRESS_PROMPT;
      const response = await this.model.generate(
        [
          { role: "system", content: prompt },
          { role: "user", content: content.slice(0, 200_000) },
        ],
        { maxTokens: 2048, temperature: 0 },
      );
      const summary = getTextContent(response.message.content);
      return summary || content;
    } catch {
      return content;
    }
  }
}
