import type { ModelProvider } from "../../models/provider.js";
import { type ChatMessage, getTextContent } from "../../models/types.js";
import type { StorageDriver } from "../../storage/driver.js";
import { countTokens } from "../../utils/token-counter.js";

const NS = "memory:summaries";

export interface SummaryEntry {
  key: string;
  summary: string;
  createdAt: Date;
}

const SUMMARIZE_PROMPT = `Summarize the following conversation chunk in 2-3 concise sentences. Focus on key topics discussed, decisions made, and important information shared. Do not include greetings or filler.

Conversation:
{conversation}

Summary:`;

export class Summaries {
  private storage: StorageDriver;
  private model?: ModelProvider;
  private maxCount: number;
  private maxTokens: number;

  constructor(storage: StorageDriver, config?: { model?: ModelProvider; maxCount?: number; maxTokens?: number }) {
    this.storage = storage;
    this.model = config?.model;
    this.maxCount = config?.maxCount ?? 10;
    this.maxTokens = config?.maxTokens ?? 2000;
  }

  async summarize(sessionId: string, messages: ChatMessage[], fallbackModel?: ModelProvider): Promise<void> {
    const textParts = messages.filter((m) => m.content).map((m) => `${m.role}: ${getTextContent(m.content)}`);
    if (textParts.length === 0) return;

    const model = this.model ?? fallbackModel;
    let summary: string;

    if (model) {
      try {
        const prompt = SUMMARIZE_PROMPT.replace("{conversation}", textParts.join("\n"));
        const response = await model.generate([{ role: "user", content: prompt }], {
          temperature: 0,
          maxTokens: 300,
        });
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

    const entry: SummaryEntry = {
      key: `${sessionId}:${Date.now()}`,
      summary,
      createdAt: new Date(),
    };

    await this.storage.set(NS, entry.key, entry);

    // Terminate prefix with ':' so sessionId "abc" doesn't match "abc123:..."
    const all = await this.storage.list<SummaryEntry>(NS, `${sessionId}:`);
    if (all.length > this.maxCount) {
      const sorted = all.sort((a, b) => new Date(a.value.createdAt).getTime() - new Date(b.value.createdAt).getTime());
      const toDelete = sorted.slice(0, all.length - this.maxCount);
      for (const item of toDelete) {
        await this.storage.delete(NS, item.key);
      }
    }
  }

  async getSummaries(sessionId: string): Promise<string[]> {
    const entries = await this.storage.list<SummaryEntry>(NS, `${sessionId}:`);
    return entries
      .sort((a, b) => new Date(a.value.createdAt).getTime() - new Date(b.value.createdAt).getTime())
      .map((e) => e.value.summary);
  }

  /**
   * Returns the most recent summaries within the token budget. The newest
   * summaries carry the most context for the current turn — older ones drop off
   * first. Pass `currentInput` to opportunistically boost summaries that share
   * keywords with the user's message (cheap relevance heuristic).
   */
  async getContextString(sessionId: string, currentInput?: string): Promise<string> {
    const summaries = await this.getSummaries(sessionId);
    if (summaries.length === 0) return "";

    // Newest-first ranking, with a tiny boost for summaries whose text overlaps
    // with the current input. Avoids forever re-injecting stale session-start
    // material on long conversations.
    const tokens = currentInput
      ? new Set(
          currentInput
            .toLowerCase()
            .split(/\W+/)
            .filter((t) => t.length > 3),
        )
      : new Set<string>();
    const scored = summaries.map((s, i) => {
      const overlap = tokens.size > 0 ? Array.from(tokens).filter((t) => s.toLowerCase().includes(t)).length : 0;
      // Recency weight dominates; relevance is a tie-breaker.
      return { s, score: i + overlap * 0.1, recency: i };
    });
    scored.sort((a, b) => b.recency - a.recency); // newest first
    if (currentInput) {
      // Within the same recency bucket, prefer higher overlap. Stable sort means
      // we apply a secondary sort by score descending.
      scored.sort((a, b) => b.score - a.score);
    }

    let text = "";
    for (const { s } of scored) {
      const candidate = text ? `${s}\n${text}` : s;
      if (countTokens(candidate) > this.maxTokens) break;
      text = candidate;
    }

    if (!text) return "";
    return `Previous conversation context (most recent first):\n${text}`;
  }

  async clear(sessionId: string): Promise<void> {
    const entries = await this.storage.list<SummaryEntry>(NS, `${sessionId}:`);
    for (const entry of entries) {
      await this.storage.delete(NS, entry.key);
    }
  }
}
