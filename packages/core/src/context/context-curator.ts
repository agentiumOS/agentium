import type { ChatMessage } from "../models/types.js";
import { getTextContent } from "../models/types.js";

export interface ContextCuratorConfig {
  enabled: boolean;
  failedResultHandling?: "remove" | "deprioritize" | "summarize";
  relevanceDecay?: {
    enabled: boolean;
    halfLifeTurns: number;
    minWeight: number;
  };
  maxFailedResults?: number;
  cleanRoomMode?: boolean;
}

export interface CurateOptions {
  maxRecentMessages?: number;
}

const ERROR_PATTERNS = [
  /\[ERROR\]/i,
  /\bError:\s/,
  /\bHTTP\s+[45]\d{2}\b/,
  /\bfailed\b.*\b(to|with)\b/i,
  /\btimeout\b/i,
  /\bECONNREFUSED\b/,
  /\bENOTFOUND\b/,
  /\bPermission denied\b/i,
  /\bstack trace\b/i,
  /\bTraceback\b/,
];

function isFailedResult(content: string): boolean {
  return ERROR_PATTERNS.some((p) => p.test(content));
}

function extractEntities(text: string): Set<string> {
  const entities = new Set<string>();
  const words = text.match(/\b[A-Z][a-zA-Z]{2,}\b/g);
  if (words) for (const w of words) entities.add(w.toLowerCase());
  const quoted = text.match(/"([^"]+)"/g);
  if (quoted) for (const q of quoted) entities.add(q.replace(/"/g, "").toLowerCase());
  return entities;
}

export class ContextCurator {
  private config: ContextCuratorConfig;

  constructor(config: ContextCuratorConfig) {
    this.config = {
      failedResultHandling: "deprioritize",
      maxFailedResults: 1,
      cleanRoomMode: false,
      ...config,
    };
  }

  curate(messages: ChatMessage[], currentQuery: string, opts?: CurateOptions): ChatMessage[] {
    if (!this.config.enabled) return messages;

    let result = [...messages];

    result = this.handleFailedResults(result);

    if (this.config.relevanceDecay?.enabled) {
      result = this.applyRelevanceDecay(result, currentQuery);
    }

    if (this.config.cleanRoomMode) {
      result = this.buildCleanRoom(result, currentQuery, opts?.maxRecentMessages ?? 10);
    }

    return result;
  }

  private handleFailedResults(messages: ChatMessage[]): ChatMessage[] {
    const handling = this.config.failedResultHandling ?? "deprioritize";
    const maxFailed = this.config.maxFailedResults ?? 1;

    const failedIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === "tool" && msg.content) {
        const text = getTextContent(msg.content);
        if (isFailedResult(text)) failedIndices.push(i);
      }
    }

    if (failedIndices.length === 0) return messages;

    if (handling === "remove") {
      const toKeep = maxFailed > 0 ? new Set(failedIndices.slice(-maxFailed)) : new Set<number>();
      return messages.filter((_, i) => !failedIndices.includes(i) || toKeep.has(i));
    }

    if (handling === "summarize") {
      return messages.map((msg, i) => {
        if (!failedIndices.includes(i)) return msg;
        const text = getTextContent(msg.content);
        const firstLine = text.split("\n")[0].slice(0, 150);
        return { ...msg, content: `[PREVIOUS ERROR - summarized] ${firstLine}` };
      });
    }

    const excessFailed = failedIndices.slice(0, -maxFailed);
    return messages.map((msg, i) => {
      if (!excessFailed.includes(i)) return msg;
      const text = getTextContent(msg.content);
      const firstLine = text.split("\n")[0].slice(0, 150);
      return { ...msg, content: `[PREVIOUS ERROR - may not be relevant] ${firstLine}` };
    });
  }

  private applyRelevanceDecay(messages: ChatMessage[], currentQuery: string): ChatMessage[] {
    const decay = this.config.relevanceDecay!;
    const totalMessages = messages.length;
    const queryEntities = extractEntities(currentQuery);

    return messages.filter((msg, i) => {
      if (msg.role === "system") return true;
      if (i >= totalMessages - 4) return true;

      const turnDistance = totalMessages - i;
      const weight = Math.max(decay.minWeight, 0.5 ** (turnDistance / decay.halfLifeTurns));

      if (weight >= 0.3) return true;

      const text = getTextContent(msg.content);
      const msgEntities = extractEntities(text);
      for (const entity of queryEntities) {
        if (msgEntities.has(entity)) return true;
      }

      return weight >= decay.minWeight * 2;
    });
  }

  private buildCleanRoom(messages: ChatMessage[], currentQuery: string, maxRecent: number): ChatMessage[] {
    const systemMessages = messages.filter((m) => m.role === "system");
    const nonSystemMessages = messages.filter((m) => m.role !== "system");
    const queryEntities = extractEntities(currentQuery);

    const recentMessages = nonSystemMessages.slice(-maxRecent);

    const olderMessages = nonSystemMessages.slice(0, -maxRecent);
    const relevantOlder = olderMessages.filter((msg) => {
      const text = getTextContent(msg.content);
      const msgEntities = extractEntities(text);
      for (const entity of queryEntities) {
        if (msgEntities.has(entity)) return true;
      }
      return false;
    });

    return [...systemMessages, ...relevantOlder, ...recentMessages];
  }
}
