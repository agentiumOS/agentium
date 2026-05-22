import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import type { ModelProvider } from "../../models/provider.js";
import type { ChatMessage } from "../../models/types.js";
import type { StorageDriver } from "../../storage/driver.js";
import type { ToolDef } from "../../tools/types.js";

const NS = "memory:user-facts";

export interface UserFact {
  id: string;
  fact: string;
  /** Topic categories derived during extraction (e.g. "preference", "location"). */
  topics: string[];
  /** The user message that triggered this fact. */
  input?: string;
  /** Importance score from 0 to 1 assigned during extraction. */
  importance?: number;
  /** When this fact became valid. */
  validFrom: Date;
  /** Set when a newer fact supersedes this one. */
  invalidatedAt?: Date;
  createdAt: Date;
  source: "auto" | "manual";
}

const EXTRACTION_PROMPT = `You are a memory extraction assistant. Analyze the conversation and extract important facts about the user.

Rules:
- Extract concrete facts: preferences, location, profession, interests, goals, communication style
- Each fact should be a short, self-contained statement
- Do NOT extract transient information (e.g. "asked about weather today")
- Do NOT extract information about the assistant
- If there are no new meaningful facts, return an empty array
- Assign an "importance" score from 0.0 to 1.0 (1.0 = critical identity fact, 0.1 = minor preference)
- If a new fact CONTRADICTS an existing fact, include it with "supersedes" set to the contradicted fact text

Existing facts (avoid duplicates, check for contradictions):
{existingFacts}

Conversation:
{conversation}

Return ONLY a JSON array of objects with shape: [{"fact": "string", "topics": ["string"], "importance": 0.0-1.0, "supersedes": "optional old fact text"}]`;

export class UserFacts {
  private storage: StorageDriver;
  private model?: ModelProvider;
  private maxFacts: number;
  private locks = new Map<string, Promise<void>>();

  constructor(storage: StorageDriver, config?: { model?: ModelProvider; maxFacts?: number }) {
    this.storage = storage;
    this.model = config?.model;
    this.maxFacts = config?.maxFacts ?? 100;
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let resolve!: () => void;
    const next = new Promise<void>((r) => {
      resolve = r;
    });
    this.locks.set(key, next);
    try {
      await prev;
      return await fn();
    } finally {
      resolve();
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }

  async getFacts(userId: string): Promise<UserFact[]> {
    return (await this.storage.get<UserFact[]>(NS, userId)) ?? [];
  }

  async addFacts(
    userId: string,
    facts: Array<{ fact: string; topics?: string[]; importance?: number; supersedes?: string }>,
    source: "auto" | "manual" = "manual",
    input?: string,
  ): Promise<void> {
    return this.withLock(userId, async () => {
      const existing = await this.getFacts(userId);
      const existingSet = new Set(existing.map((f) => f.fact.toLowerCase()));

      const newFacts: UserFact[] = [];
      for (const f of facts) {
        const normalized = f.fact.trim();
        if (!normalized || existingSet.has(normalized.toLowerCase())) continue;

        if (f.supersedes) {
          const supersededLower = f.supersedes.toLowerCase().trim();
          for (const ex of existing) {
            if (ex.fact.toLowerCase().trim() === supersededLower && !ex.invalidatedAt) {
              ex.invalidatedAt = new Date();
            }
          }
        }

        newFacts.push({
          id: uuidv4(),
          fact: normalized,
          topics: f.topics ?? [],
          importance: f.importance,
          input,
          validFrom: new Date(),
          createdAt: new Date(),
          source,
        });
        existingSet.add(normalized.toLowerCase());
      }

      if (newFacts.length === 0) return;

      let updated = [...existing, ...newFacts];
      if (updated.length > this.maxFacts) {
        const active = updated.filter((f) => !f.invalidatedAt);
        const invalidated = updated.filter((f) => f.invalidatedAt);
        updated = [...invalidated.slice(-Math.floor(this.maxFacts * 0.1)), ...active.slice(-this.maxFacts)];
      }

      await this.storage.set(NS, userId, updated);
    });
  }

  async removeFact(userId: string, factId: string): Promise<void> {
    const existing = await this.getFacts(userId);
    const updated = existing.filter((f) => f.id !== factId);
    await this.storage.set(NS, userId, updated);
  }

  async clear(userId: string): Promise<void> {
    await this.storage.delete(NS, userId);
  }

  async getContextString(userId: string): Promise<string> {
    const facts = await this.getActiveFacts(userId);
    if (facts.length === 0) return "";
    const factList = facts.map((f) => `- ${f.fact}`).join("\n");
    return `What you know about this user:\n${factList}`;
  }

  async getActiveFacts(userId: string): Promise<UserFact[]> {
    const all = await this.getFacts(userId);
    return all.filter((f) => !f.invalidatedAt);
  }

  asTool(config?: { name?: string; description?: string }): ToolDef {
    return {
      name: config?.name ?? "recall_user_facts",
      description:
        config?.description ??
        "Retrieve stored facts about the current user — preferences, background, interests, and other personal details from past conversations.",
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

      const lastUserMsg = messages.filter((m) => m.role === "user").pop();
      const inputStr = lastUserMsg && typeof lastUserMsg.content === "string" ? lastUserMsg.content : undefined;

      const prompt = EXTRACTION_PROMPT.replace("{existingFacts}", existingStr).replace(
        "{conversation}",
        conversationStr,
      );

      const response = await model.generate([{ role: "user", content: prompt }], {
        temperature: 0,
        maxTokens: 500,
      });

      const text = typeof response.message.content === "string" ? response.message.content : "";
      if (!text) return;

      const jsonStr = extractJsonArray(text);
      const parsed = JSON.parse(jsonStr);

      if (Array.isArray(parsed) && parsed.length > 0) {
        const validFacts: Array<{ fact: string; topics?: string[]; importance?: number; supersedes?: string }> = [];
        for (const item of parsed) {
          if (typeof item === "string" && item.trim()) {
            validFacts.push({ fact: item });
          } else if (item && typeof item.fact === "string" && item.fact.trim()) {
            validFacts.push({
              fact: item.fact,
              topics: Array.isArray(item.topics) ? item.topics : [],
              importance: typeof item.importance === "number" ? item.importance : undefined,
              supersedes: typeof item.supersedes === "string" ? item.supersedes : undefined,
            });
          }
        }
        if (validFacts.length > 0) {
          await this.addFacts(userId, validFacts, "auto", inputStr);
        }
      }
    } catch (err) {
      console.warn("[UserFacts] extractAndStore failed:", (err as Error).message ?? err);
    }
  }
}

function extractJsonArray(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();

  const bracketStart = text.indexOf("[");
  const bracketEnd = text.lastIndexOf("]");
  if (bracketStart !== -1 && bracketEnd > bracketStart) {
    return text.slice(bracketStart, bracketEnd + 1);
  }

  return text.trim();
}
