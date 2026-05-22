import type { RunContext } from "../agent/run-context.js";
import type { GuardrailResult, InputGuardrail } from "../agent/types.js";
import type { ChatMessage, MessageContent } from "../models/types.js";
import { getTextContent } from "../models/types.js";

export type PiiType = "email" | "phone" | "ssn" | "creditCard" | "ipAddress" | "name";

export interface PiiPattern {
  name: string;
  regex: RegExp;
}

export interface PiiGuardConfig {
  patterns?: PiiPattern[];
  builtIn?: PiiType[];
  action: "redact" | "hash" | "placeholder";
  rehydrate?: boolean;
  customDetector?: (text: string) => Array<{ start: number; end: number; type: string }>;
}

const BUILT_IN_PATTERNS: Record<PiiType, RegExp> = {
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  phone: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  creditCard: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
  ipAddress: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  name: /\b[A-Z][a-z]+ [A-Z][a-z]+\b/g,
};

export class PiiGuard {
  private config: PiiGuardConfig;
  private piiMap = new Map<string, string>();
  private counter = 0;

  constructor(config: PiiGuardConfig) {
    this.config = config;
  }

  private getPatterns(): Array<{ name: string; regex: RegExp }> {
    const patterns: Array<{ name: string; regex: RegExp }> = [];
    if (this.config.builtIn) {
      for (const type of this.config.builtIn) {
        if (BUILT_IN_PATTERNS[type]) {
          patterns.push({ name: type, regex: new RegExp(BUILT_IN_PATTERNS[type].source, "g") });
        }
      }
    }
    if (this.config.patterns) {
      patterns.push(...this.config.patterns);
    }
    return patterns;
  }

  scrub(text: string): string {
    let result = text;
    const patterns = this.getPatterns();

    for (const { name, regex } of patterns) {
      result = result.replace(regex, (match) => {
        return this.getPlaceholder(match, name);
      });
    }

    return result;
  }

  private getPlaceholder(original: string, type: string): string {
    // Check if we've already seen this value
    for (const [placeholder, value] of this.piiMap) {
      if (value === original) return placeholder;
    }

    const { action } = this.config;

    if (action === "redact") {
      return `[REDACTED]`;
    }

    if (action === "hash") {
      let hash = 0;
      for (let i = 0; i < original.length; i++) {
        const char = original.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash |= 0;
      }
      const placeholder = `[HASH_${Math.abs(hash).toString(16).slice(0, 8)}]`;
      this.piiMap.set(placeholder, original);
      return placeholder;
    }

    // placeholder mode
    this.counter++;
    const placeholder = `[${type.toUpperCase()}_${this.counter}]`;
    this.piiMap.set(placeholder, original);
    return placeholder;
  }

  rehydrate(text: string): string {
    if (!this.config.rehydrate) return text;
    let result = text;
    for (const [placeholder, original] of this.piiMap) {
      result = result.split(placeholder).join(original);
    }
    return result;
  }

  scrubMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((msg) => {
      if (typeof msg.content === "string") {
        return { ...msg, content: this.scrub(msg.content) };
      }
      const text = getTextContent(msg.content);
      if (text) {
        return { ...msg, content: this.scrub(text) };
      }
      return msg;
    });
  }

  getMapping(): ReadonlyMap<string, string> {
    return this.piiMap;
  }

  reset(): void {
    this.piiMap.clear();
    this.counter = 0;
  }

  /**
   * Create an InputGuardrail that scrubs PII from user input.
   * When action is "redact", the guardrail blocks and returns the scrubbed version in the reason.
   * When action is "placeholder" or "hash", the guardrail passes but modifies the input.
   */
  toInputGuardrail(): InputGuardrail {
    return {
      name: "pii-guard",
      validate: async (input: MessageContent, _ctx: RunContext): Promise<GuardrailResult> => {
        const text = typeof input === "string" ? input : (getTextContent(input) ?? "");
        const scrubbed = this.scrub(text);
        if (scrubbed !== text) {
          // Store the scrubbed version in ctx metadata for downstream use
          _ctx.metadata.piiScrubbed = true;
          _ctx.metadata.piiOriginal = text;
          _ctx.metadata.piiScrubbing = scrubbed;
        }
        return { pass: true };
      },
    };
  }

  /**
   * Create a beforeLLMCall hook that scrubs PII from all messages on every roundtrip.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: matches LoopHooks interface
  toBeforeLLMCallHook(): (messages: ChatMessage[], roundtrip: number) => Promise<ChatMessage[] | void> {
    // biome-ignore lint/suspicious/noConfusingVoidType: matches LoopHooks interface
    return async (messages: ChatMessage[], _roundtrip: number): Promise<ChatMessage[] | void> => {
      return this.scrubMessages(messages);
    };
  }

  /**
   * Create an afterToolExec hook that scrubs PII from tool results.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: matches LoopHooks interface
  toAfterToolExecHook(): (toolName: string, result: string) => Promise<string | void> {
    // biome-ignore lint/suspicious/noConfusingVoidType: matches LoopHooks interface
    return async (_toolName: string, result: string): Promise<string | void> => {
      return this.scrub(result);
    };
  }
}
