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

    const all = await this.storage.list<SummaryEntry>(NS, sessionId);
    if (all.length > this.maxCount) {
      const sorted = all.sort((a, b) => new Date(a.value.createdAt).getTime() - new Date(b.value.createdAt).getTime());
      const toDelete = sorted.slice(0, all.length - this.maxCount);
      for (const item of toDelete) {
        await this.storage.delete(NS, item.key);
      }
    }
  }

  async getSummaries(sessionId: string): Promise<string[]> {
    const entries = await this.storage.list<SummaryEntry>(NS, sessionId);
    return entries
      .sort((a, b) => new Date(a.value.createdAt).getTime() - new Date(b.value.createdAt).getTime())
      .map((e) => e.value.summary);
  }

  async getContextString(sessionId: string): Promise<string> {
    const summaries = await this.getSummaries(sessionId);
    if (summaries.length === 0) return "";

    let text = "";

    for (const s of summaries) {
      const candidate = text ? `${text}\n${s}` : s;
      if (countTokens(candidate) > this.maxTokens) break;
      text = candidate;
    }

    if (!text) return "";
    return `Previous conversation context:\n${text}`;
  }

  async clear(sessionId: string): Promise<void> {
    const entries = await this.storage.list<SummaryEntry>(NS, sessionId);
    for (const entry of entries) {
      await this.storage.delete(NS, entry.key);
    }
  }
}
