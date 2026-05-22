import type { ContextCompactorConfig } from "../agent/types.js";
import type { ChatMessage } from "../models/types.js";
import { getTextContent } from "../models/types.js";
import { countMessageTokens } from "../utils/token-counter.js";

const SUMMARIZE_SYSTEM = `You are a conversation summarizer. Condense the following messages into a single concise summary, preserving all key facts, decisions, and context. Return only the summary text.`;

export class ContextCompactor {
  private config: ContextCompactorConfig;

  constructor(config: ContextCompactorConfig) {
    this.config = config;
  }

  async compact(messages: ChatMessage[]): Promise<ChatMessage[]> {
    const reserve = this.config.reserveTokens ?? 4096;
    const budget = this.config.maxContextTokens - reserve;

    const totalTokens = messages.reduce((sum, m) => sum + countMessageTokens(m), 0);
    if (totalTokens <= budget) return messages;

    const { strategy } = this.config;
    if (strategy === "trim") {
      return this.trimStrategy(messages, budget);
    }
    if (strategy === "summarize") {
      return this.summarizeStrategy(messages, budget);
    }
    // hybrid: trim first, if still over budget, summarize the middle
    const trimmed = this.trimStrategy(messages, budget);
    const trimmedTokens = trimmed.reduce((sum, m) => sum + countMessageTokens(m), 0);
    if (trimmedTokens <= budget) return trimmed;
    return this.summarizeStrategy(trimmed, budget);
  }

  private trimStrategy(messages: ChatMessage[], budget: number): ChatMessage[] {
    const systemMsgs = messages.filter((m) => m.role === "system");
    const nonSystem = messages.filter((m) => m.role !== "system");

    const systemTokens = systemMsgs.reduce((sum, m) => sum + countMessageTokens(m), 0);
    let remaining = budget - systemTokens;
    if (remaining <= 0) return systemMsgs;

    const kept: ChatMessage[] = [];
    for (let i = nonSystem.length - 1; i >= 0; i--) {
      const tokens = countMessageTokens(nonSystem[i]);
      if (remaining - tokens < 0 && kept.length > 0) break;
      remaining -= tokens;
      kept.unshift(nonSystem[i]);
    }

    return [...systemMsgs, ...kept];
  }

  private async summarizeStrategy(messages: ChatMessage[], budget: number): Promise<ChatMessage[]> {
    const model = this.config.summarizeModel;
    if (!model) return this.trimStrategy(messages, budget);

    const systemMsgs = messages.filter((m) => m.role === "system");
    const nonSystem = messages.filter((m) => m.role !== "system");

    if (nonSystem.length <= 2) return messages;

    const systemTokens = systemMsgs.reduce((sum, m) => sum + countMessageTokens(m), 0);
    const remaining = budget - systemTokens;

    // Keep the last few exchanges intact, summarize the rest
    const keepCount = Math.min(4, nonSystem.length);
    const toSummarize = nonSystem.slice(0, nonSystem.length - keepCount);
    const toKeep = nonSystem.slice(nonSystem.length - keepCount);

    if (toSummarize.length === 0) return this.trimStrategy(messages, budget);

    const summaryInput = toSummarize
      .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : (getTextContent(m.content) ?? "")}`)
      .join("\n");

    try {
      const response = await model.generate(
        [
          { role: "system", content: SUMMARIZE_SYSTEM },
          { role: "user", content: summaryInput.slice(0, 100_000) },
        ],
        { maxTokens: Math.min(2048, Math.floor(remaining / 3)), temperature: 0 },
      );

      const summaryText = getTextContent(response.message.content) ?? "[summary unavailable]";

      const summaryMsg: ChatMessage = {
        role: "assistant",
        content: `[Conversation Summary]\n${summaryText}`,
      };

      const result = [...systemMsgs, summaryMsg, ...toKeep];

      const resultTokens = result.reduce((sum, m) => sum + countMessageTokens(m), 0);
      if (resultTokens > budget) {
        return this.trimStrategy(result, budget);
      }

      return result;
    } catch {
      return this.trimStrategy(messages, budget);
    }
  }
}
