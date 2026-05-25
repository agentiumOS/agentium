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
  /**
   * Canonical short identifier for the aspect this fact describes, e.g.
   * "birthday", "location", "role", "company", "interest:scifi".
   * Used to automatically supersede prior facts about the same aspect when
   * the extractor LLM forgets to set `supersedes` explicitly.
   */
  subject?: string;
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

const EXTRACTION_PROMPT = `You are a memory extraction assistant. Decide which facts to ADD, FORGET, or REPLACE based on this turn.

Today's date is {today}.

Date handling rules — read carefully:
- Resolve TRUE relative references ("today", "yesterday", "tomorrow", "last Monday", "next week", "in 3 days") to absolute YYYY-MM-DD dates using {today} as the anchor.
- For RECURRING annual events (birthday, anniversary, founding date of a company already in operation), DO NOT invent a year. If the user says "my birthday is April 11" or "11th April", store the fact as "User's birthday is April 11" (no year). Only include a year if the user EXPLICITLY mentioned one (e.g. "my birthday is April 11, 1995").
- For one-off events that need a year for clarity ("I joined Acme last Tuesday"), resolve to the absolute YYYY-MM-DD.
- Never store the literal words "today", "yesterday", "tomorrow", "next week", etc.

Return ONLY a JSON object with this exact shape:
{
  "add":    [{"fact": "string", "subject": "short canonical key", "topics": ["string"], "importance": 0.0-1.0, "supersedes": "optional verbatim existing fact to invalidate"}],
  "forget": ["verbatim existing fact text to invalidate", ...]
}

The "subject" field is REQUIRED for every added fact. It should be a short stable identifier for the aspect the fact describes:
- "birthday"           — date-of-birth facts
- "name"               — user's name
- "location"           — where they live
- "role"               — job title
- "company"            — employer
- "interest:scifi"     — specific interests use "interest:<topic>"
- "preference:tone"    — communication preferences use "preference:<aspect>"
When a new fact updates an existing one, USE THE SAME subject value as the old fact.

Rules:
- Extract STABLE long-term facts about the user — things that would still be true the next time they talk to the assistant (next day, next week, next session): preferences, location, profession, interests, goals, communication style, allergies, dietary restrictions, ongoing health conditions, language, hobbies, persistent relationships.
- Each fact is short and self-contained.
- Do NOT extract transactional / one-off context. Those belong in session memory and tool calls, not in long-term user facts. Examples to SKIP:
    • Specific order IDs, ticket IDs being discussed right now ("Order #ORD-7823")
    • Deal values or quotes for ongoing negotiations ("Acme quoted $50k")
    • The specific stack on a particular project for this chat ("currently using Next.js 14")
    • Symptoms, prices, dates, addresses, or other data better fetched via tool calls
- Do NOT extract questions or requests ("user asked about today's weather", "wants to know X").
- Do NOT extract information about the assistant.

ALWAYS extract these natural-language patterns from a USER message as facts:
- "I love X" / "I like X" / "I enjoy X" / "I'm into X"
    → fact: "User loves X." (subject: "interest:<x>")
- "I hate X" / "I don't like X" / "I dislike X"
    → fact: "User dislikes X." (subject: "dislike:<x>")
- "My favorite X is Y" / "I prefer Y for X"
    → fact: "User's favorite X is Y." (subject: "favorite:<x>")
- "I work as X" / "I'm a X" / "I'm an X"
    → fact: "User works as X." (subject: "role")
- "I live in X" / "I'm based in X" / "I'm from X"
    → fact: "User lives in X." (subject: "location")
- "I'm allergic to X"
    → fact: "User is allergic to X." (subject: "allergy:<x>")
- "I take X for Y" (ongoing medication)
    → fact: "User takes X for Y." (subject: "medication:<x>")
- "I have a X" / "I own a X" (notable persistent possession like a pet/car)
    → fact: "User owns a X." (subject: "owns:<x>")
Each casual statement above counts as a meaningful fact — do not skip them as "transient".

User-initiated deletions (put into "forget"):
- "Forget that I love sci-fi."           → forget the matching existing fact verbatim
- "I no longer work at Acme."            → forget the matching existing fact
- "Don't remember my birthday."          → forget the matching existing fact

Contradictions / updates (put into "add" with "supersedes"):
- Existing: "Akash's birthday is 2026-05-24."
  User says: "Actually my birthday is today." (and today is 2026-05-23)
  → "add": [{"fact": "Akash's birthday is 2026-05-23.", "supersedes": "Akash's birthday is 2026-05-24.", ...}]
- Existing: "Akash lives in Mumbai."
  User says: "I just moved to Bangalore."
  → "add": [{"fact": "Akash lives in Bangalore.", "supersedes": "Akash lives in Mumbai.", ...}]

Importance scoring: 1.0 = critical identity (name, birthday); 0.5 = preferences; 0.1 = minor.

If nothing should change, return {"add": [], "forget": []}.

Existing facts (use EXACT text from this list when populating "supersedes" or "forget"):
{existingFacts}

Conversation:
{conversation}`;

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
    facts: Array<{
      fact: string;
      subject?: string;
      topics?: string[];
      importance?: number;
      supersedes?: string;
    }>,
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

        // Explicit "supersedes" reference from the LLM.
        if (f.supersedes) {
          const supersededLower = f.supersedes.toLowerCase().trim();
          for (const ex of existing) {
            if (ex.fact.toLowerCase().trim() === supersededLower && !ex.invalidatedAt) {
              ex.invalidatedAt = new Date();
            }
          }
        }

        // Safety net: even when the LLM forgets to set "supersedes",
        // auto-invalidate any prior active fact with the same canonical
        // subject. This makes corrections like "actually my birthday is
        // tomorrow" work reliably even with weaker extractor models.
        if (f.subject) {
          const subjectLower = f.subject.toLowerCase().trim();
          for (const ex of existing) {
            if (ex.invalidatedAt) continue;
            if ((ex.subject ?? "").toLowerCase().trim() === subjectLower) {
              ex.invalidatedAt = new Date();
            }
          }
        }

        newFacts.push({
          id: uuidv4(),
          fact: normalized,
          subject: f.subject,
          topics: f.topics ?? [],
          importance: f.importance,
          input,
          validFrom: new Date(),
          createdAt: new Date(),
          source,
        });
        existingSet.add(normalized.toLowerCase());
      }

      if (newFacts.length === 0) {
        // Still persist if we mutated invalidatedAt above.
        await this.storage.set(NS, userId, existing);
        return;
      }

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

  /**
   * Invalidate (soft-delete) every active fact whose text matches any of
   * the provided strings. Matching is case-insensitive on the trimmed text.
   * Used for user-initiated "forget X" instructions.
   */
  async forgetByText(userId: string, factTexts: string[]): Promise<number> {
    if (factTexts.length === 0) return 0;
    return this.withLock(userId, async () => {
      const existing = await this.getFacts(userId);
      const targets = new Set(factTexts.map((t) => t.toLowerCase().trim()));
      let count = 0;
      for (const ex of existing) {
        if (ex.invalidatedAt) continue;
        if (targets.has(ex.fact.toLowerCase().trim())) {
          ex.invalidatedAt = new Date();
          count += 1;
        }
      }
      if (count > 0) await this.storage.set(NS, userId, existing);
      return count;
    });
  }

  async clear(userId: string): Promise<void> {
    await this.storage.delete(NS, userId);
  }

  async getContextString(userId: string): Promise<string> {
    const all = await this.getFacts(userId);
    const active = all.filter((f) => !f.invalidatedAt);
    const invalidated = all.filter((f) => f.invalidatedAt);

    const blocks: string[] = [];

    if (active.length > 0) {
      const factList = active.map((f) => `- ${f.fact}`).join("\n");
      blocks.push(`What you know about this user:\n${factList}`);
    }

    if (invalidated.length > 0) {
      const forgottenList = invalidated.map((f) => `- ${f.fact}`).join("\n");
      blocks.push(
        `IMPORTANT — the user has explicitly asked you to forget the following facts. ` +
          `Do NOT recall, mention, or restate them even if earlier messages in the chat history reference them. ` +
          `If asked about them, say you do not have that information.\n${forgottenList}`,
      );
    }

    return blocks.join("\n\n");
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
      const active = existing.filter((f) => !f.invalidatedAt);
      const existingStr =
        active.length > 0 ? active.map((f) => `- [subject=${f.subject ?? "?"}] ${f.fact}`).join("\n") : "(none)";

      const conversationStr = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => {
          const content = typeof m.content === "string" ? m.content : "(multimodal)";
          return `${m.role}: ${content}`;
        })
        .join("\n");

      const lastUserMsg = messages.filter((m) => m.role === "user").pop();
      const inputStr = lastUserMsg && typeof lastUserMsg.content === "string" ? lastUserMsg.content : undefined;

      const today = new Date().toISOString().slice(0, 10);
      const prompt = EXTRACTION_PROMPT.replace("{today}", today)
        .replace("{today}", today) // appears twice in the template
        .replace("{existingFacts}", existingStr)
        .replace("{conversation}", conversationStr);

      const response = await model.generate([{ role: "user", content: prompt }], {
        temperature: 0,
        maxTokens: 500,
      });

      const text = typeof response.message.content === "string" ? response.message.content : "";
      if (!text) return;

      const { add, forget } = parseExtractionResponse(text);

      if (forget.length > 0) {
        await this.forgetByText(userId, forget);
      }
      if (add.length > 0) {
        await this.addFacts(userId, add, "auto", inputStr);
      }
    } catch (err) {
      console.warn("[UserFacts] extractAndStore failed:", (err as Error).message ?? err);
    }
  }
}

/**
 * Parse the model's response. Supports both the new {add, forget} object
 * shape and the legacy bare-array shape (treated as add-only).
 */
function parseExtractionResponse(text: string): {
  add: Array<{ fact: string; subject?: string; topics?: string[]; importance?: number; supersedes?: string }>;
  forget: string[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(text));
  } catch {
    try {
      parsed = JSON.parse(extractJsonArray(text));
    } catch {
      return { add: [], forget: [] };
    }
  }

  const addRaw: unknown[] = Array.isArray(parsed)
    ? (parsed as unknown[])
    : Array.isArray((parsed as any)?.add)
      ? (parsed as any).add
      : [];
  const forgetRaw: unknown[] = Array.isArray((parsed as any)?.forget) ? (parsed as any).forget : [];

  const add: Array<{ fact: string; subject?: string; topics?: string[]; importance?: number; supersedes?: string }> =
    [];
  for (const item of addRaw) {
    if (typeof item === "string" && item.trim()) {
      add.push({ fact: item.trim() });
      continue;
    }
    if (item && typeof (item as any).fact === "string" && (item as any).fact.trim()) {
      add.push({
        fact: (item as any).fact.trim(),
        subject: typeof (item as any).subject === "string" ? (item as any).subject.trim() : undefined,
        topics: Array.isArray((item as any).topics) ? (item as any).topics : [],
        importance: typeof (item as any).importance === "number" ? (item as any).importance : undefined,
        supersedes: typeof (item as any).supersedes === "string" ? (item as any).supersedes : undefined,
      });
    }
  }

  const forget = forgetRaw
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim());

  return { add, forget };
}

function extractJsonObject(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  return text.trim();
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
