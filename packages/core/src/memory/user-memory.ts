import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import type { ModelProvider } from "../models/provider.js";
import type { ChatMessage } from "../models/types.js";
import type { StorageDriver } from "../storage/driver.js";
import { InMemoryStorage } from "../storage/in-memory.js";
import type { ToolDef } from "../tools/types.js";

const USER_MEMORY_NS = "memory:user";

export interface UserMemoryConfig {
  storage?: StorageDriver;
  /** LLM used for auto-extraction of facts from conversations. */
  model?: ModelProvider;
  /** Maximum number of facts stored per user (default 100). */
  maxFacts?: number;
  /** Whether auto-extraction is enabled (default true). */
  enabled?: boolean;
}

export interface UserFact {
  id: string;
  fact: string;
  createdAt: Date;
  source: "auto" | "manual";
}

const EXTRACTION_PROMPT = `You are a memory extraction assistant. Analyze the conversation below and extract important facts about the user that would be useful for future personalization.

Rules:
- Extract concrete facts like preferences, location, profession, interests, goals, communication style
- Each fact should be a short, self-contained statement (e.g., "Lives in Mumbai", "Prefers concise answers")
- Do NOT extract transient information (e.g., "asked about weather today")
- Do NOT extract information about the assistant
- If there are no new meaningful facts, return an empty array
- Return ONLY a valid JSON array of strings, nothing else

Existing facts about this user (avoid duplicates):
{existingFacts}

Conversation:
{conversation}

Return a JSON array of new fact strings:`;

export class UserMemory {
  private storage: StorageDriver;
  private model?: ModelProvider;
  private maxFacts: number;
  private enabled: boolean;
  private initPromise: Promise<void> | null = null;

  constructor(config?: UserMemoryConfig) {
    this.storage = config?.storage ?? new InMemoryStorage();
    this.model = config?.model;
    this.maxFacts = config?.maxFacts ?? 100;
    this.enabled = config?.enabled ?? true;
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

  async getFacts(userId: string): Promise<UserFact[]> {
    await this.ensureInitialized();
    return (await this.storage.get<UserFact[]>(USER_MEMORY_NS, userId)) ?? [];
  }

  async addFacts(userId: string, facts: string[], source: "auto" | "manual" = "manual"): Promise<void> {
    await this.ensureInitialized();
    const existing = await this.getFacts(userId);
    const existingSet = new Set(existing.map((f) => f.fact.toLowerCase()));

    const newFacts: UserFact[] = [];
    for (const fact of facts) {
      const normalized = fact.trim();
      if (!normalized || existingSet.has(normalized.toLowerCase())) continue;
      newFacts.push({
        id: uuidv4(),
        fact: normalized,
        createdAt: new Date(),
        source,
      });
      existingSet.add(normalized.toLowerCase());
    }

    if (newFacts.length === 0) return;

    let updated = [...existing, ...newFacts];
    if (updated.length > this.maxFacts) {
      updated = updated.slice(updated.length - this.maxFacts);
    }

    await this.storage.set(USER_MEMORY_NS, userId, updated);
  }

  async removeFact(userId: string, factId: string): Promise<void> {
    await this.ensureInitialized();
    const existing = await this.getFacts(userId);
    const updated = existing.filter((f) => f.id !== factId);
    await this.storage.set(USER_MEMORY_NS, userId, updated);
  }

  async clear(userId: string): Promise<void> {
    await this.ensureInitialized();
    await this.storage.delete(USER_MEMORY_NS, userId);
  }

  async getContextString(userId: string): Promise<string> {
    if (!this.enabled) return "";
    const facts = await this.getFacts(userId);
    if (facts.length === 0) return "";
    const factList = facts.map((f) => `- ${f.fact}`).join("\n");
    return `What you know about this user:\n${factList}`;
  }

  asTool(config?: { name?: string; description?: string }): ToolDef {
    return {
      name: config?.name ?? "recall_user_facts",
      description:
        config?.description ??
        "Retrieve stored facts about the current user — preferences, background, interests, and other personal details from past conversations. Call this when the user asks what you know or remember about them.",
      parameters: z.object({}),
      execute: async (_args, ctx) => {
        const uid = ctx.userId;
        if (!uid) return "No user identified for this session.";
        const facts = await this.getFacts(uid);
        if (facts.length === 0) return "No stored facts about this user yet.";
        return facts.map((f) => `- ${f.fact}`).join("\n");
      },
    };
  }

  async extractAndStore(userId: string, messages: ChatMessage[], fallbackModel?: ModelProvider): Promise<void> {
    if (!this.enabled) return;

    const model = this.model ?? fallbackModel;
    if (!model) return;

    try {
      const existing = await this.getFacts(userId);
      const existingStr = existing.length > 0 ? existing.map((f) => `- ${f.fact}`).join("\n") : "(none)";

      const conversationStr = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => {
          const content = typeof m.content === "string" ? m.content : "(multimodal)";
          return `${m.role}: ${content}`;
        })
        .join("\n");

      const prompt = EXTRACTION_PROMPT.replace("{existingFacts}", existingStr).replace(
        "{conversation}",
        conversationStr,
      );

      const response = await model.generate([{ role: "user", content: prompt }], { temperature: 0, maxTokens: 500 });

      const text = typeof response.message.content === "string" ? response.message.content : "";

      if (!text) return;

      const jsonStr = this.extractJsonArray(text);
      const parsed = JSON.parse(jsonStr);

      if (Array.isArray(parsed) && parsed.length > 0) {
        const validFacts = parsed.filter((f: unknown) => typeof f === "string" && f.trim().length > 0);
        if (validFacts.length > 0) {
          await this.addFacts(userId, validFacts, "auto");
        }
      }
    } catch (err) {
      console.warn("[UserMemory] extractAndStore failed:", (err as Error).message ?? err);
    }
  }

  private extractJsonArray(text: string): string {
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) return fenceMatch[1].trim();

    const bracketStart = text.indexOf("[");
    const bracketEnd = text.lastIndexOf("]");
    if (bracketStart !== -1 && bracketEnd > bracketStart) {
      return text.slice(bracketStart, bracketEnd + 1);
    }

    return text.trim();
  }
}
