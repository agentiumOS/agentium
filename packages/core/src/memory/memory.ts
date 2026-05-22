import type { ModelProvider } from "../models/provider.js";
import { type ChatMessage, getTextContent } from "../models/types.js";
import type { StorageDriver } from "../storage/driver.js";
import { InMemoryStorage } from "../storage/in-memory.js";
import type { MemoryConfig, MemoryEntry } from "./types.js";

const LONG_TERM_NS = "memory:long";

const SUMMARIZE_PROMPT = `Summarize the following conversation chunk in 2-3 concise sentences. Focus on key topics discussed, decisions made, and important information shared. Do not include greetings or filler.

Conversation:
{conversation}

Summary:`;

/**
 * Long-term conversation memory.
 *
 * Memory stores LLM-generated summaries of past conversation segments.
 * It does NOT store raw messages — that's Session's job.
 *
 * Flow: Session overflows → Agent passes overflow to Memory.summarize() →
 * Memory generates an LLM summary and persists it.
 * On the next run, Memory.getContextString() provides past summaries as context.
 */
export class Memory {
  private storage: StorageDriver;
  private model?: ModelProvider;
  private maxSummaries: number;
  private initPromise: Promise<void> | null = null;

  constructor(config?: MemoryConfig) {
    this.storage = config?.storage ?? new InMemoryStorage();
    this.model = config?.model;
    this.maxSummaries = config?.maxSummaries ?? 20;
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        if (typeof (this.storage as any).initialize === "function") {
          await (this.storage as any).initialize();
        }
      })();
    }
    return this.initPromise;
  }

  /**
   * Summarize overflow messages and store the summary.
   * Uses the configured LLM model; falls back to basic concatenation if no model.
   */
  async summarize(sessionId: string, messages: ChatMessage[], fallbackModel?: ModelProvider): Promise<void> {
    await this.ensureInitialized();

    const textParts = messages.filter((m) => m.content).map((m) => `${m.role}: ${getTextContent(m.content)}`);

    if (textParts.length === 0) return;

    const model = this.model ?? fallbackModel;
    let summary: string;

    if (model) {
      try {
        const prompt = SUMMARIZE_PROMPT.replace("{conversation}", textParts.join("\n"));
        const response = await model.generate([{ role: "user", content: prompt }], { temperature: 0, maxTokens: 300 });
        summary =
          typeof response.message.content === "string"
            ? response.message.content.trim()
            : textParts.join(" | ").slice(0, 500);
      } catch {
        summary = textParts.join(" | ").slice(0, 500);
      }
    } else {
      summary = textParts.join(" | ").slice(0, 500);
    }

    const entry: MemoryEntry = {
      key: `${sessionId}:${Date.now()}`,
      summary,
      createdAt: new Date(),
    };

    await this.storage.set(LONG_TERM_NS, entry.key, entry);

    const all = await this.storage.list<MemoryEntry>(LONG_TERM_NS, sessionId);
    if (all.length > this.maxSummaries) {
      const sorted = all.sort((a, b) => new Date(a.value.createdAt).getTime() - new Date(b.value.createdAt).getTime());
      const toDelete = sorted.slice(0, all.length - this.maxSummaries);
      for (const item of toDelete) {
        await this.storage.delete(LONG_TERM_NS, item.key);
      }
    }
  }

  /** Get all stored summaries for a session. */
  async getSummaries(sessionId: string): Promise<string[]> {
    await this.ensureInitialized();
    const entries = await this.storage.list<MemoryEntry>(LONG_TERM_NS, sessionId);
    return entries
      .sort((a, b) => new Date(a.value.createdAt).getTime() - new Date(b.value.createdAt).getTime())
      .map((e) => e.value.summary);
  }

  /** Get summaries formatted as a context string for injection into the system prompt. */
  async getContextString(sessionId: string): Promise<string> {
    const summaries = await this.getSummaries(sessionId);
    if (summaries.length === 0) return "";
    return `Previous conversation context:\n${summaries.join("\n")}`;
  }

  /** Clear all summaries for a session. */
  async clear(sessionId: string): Promise<void> {
    await this.ensureInitialized();
    const entries = await this.storage.list<MemoryEntry>(LONG_TERM_NS, sessionId);
    for (const entry of entries) {
      await this.storage.delete(LONG_TERM_NS, entry.key);
    }
  }
}
