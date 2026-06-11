import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import type { ModelProvider } from "../../models/provider.js";
import type { ChatMessage } from "../../models/types.js";
import type { StorageDriver } from "../../storage/driver.js";
import type { ToolDef } from "../../tools/types.js";

const NS_PREFIX = "memory:entities";

export interface EntityFact {
  id: string;
  fact: string;
  importance?: number;
  validFrom: Date;
  invalidatedAt?: Date;
  createdAt: Date;
}

export interface EntityEvent {
  id: string;
  event: string;
  date?: string;
  importance?: number;
  validFrom: Date;
  invalidatedAt?: Date;
  createdAt: Date;
}

export interface EntityRelationship {
  targetEntityId: string;
  type: string;
  description?: string;
}

export interface Entity {
  entityId: string;
  entityType: string;
  name: string;
  description?: string;
  properties: Record<string, unknown>;
  facts: EntityFact[];
  events: EntityEvent[];
  relationships: EntityRelationship[];
  createdAt: Date;
  updatedAt: Date;
}

const EXTRACTION_PROMPT = `You are an entity extraction assistant. Analyze the conversation and extract entities (companies, people, projects, products, etc.) mentioned.

Today's date is {today}.

Date handling:
- Resolve genuinely relative references ("today", "yesterday", "last quarter", "next month") to absolute YYYY-MM-DD using {today} as the anchor.
- If the user mentions a date without a year for a recurring event (anniversaries, birthdays, holidays), DO NOT invent a year. Store the date as "April 11" rather than "2026-04-11".
- Only include a year when the user explicitly stated one.
- Never store the literal words "today", "yesterday", "tomorrow", etc.

For each entity, extract:
- name: the entity name
- entityType: "company" | "person" | "project" | "product" | "other"
- facts: array of factual statements about the entity
- events: array of events related to the entity (with optional ISO date)

Return ONLY a JSON array:
[{"name": "string", "entityType": "string", "facts": ["string"], "events": [{"event": "string", "date": "optional YYYY-MM-DD"}]}]

If no entities are found, return [].

Known entities:
{knownEntities}

Conversation:
{conversation}`;

export class EntityMemory {
  private storage: StorageDriver;
  private model?: ModelProvider;
  private namespace: string;

  constructor(storage: StorageDriver, config?: { model?: ModelProvider; namespace?: string }) {
    this.storage = storage;
    this.model = config?.model;
    this.namespace = config?.namespace ?? "global";
  }

  /**
   * Per-user storage namespace. Entities and their facts are user-scoped so that
   * Alice's "Acme" facts never leak into Bob's prompt or tool results.
   * When userId is omitted, the legacy global scope is used (deprecated).
   */
  private ns(userId?: string): string {
    const base = `${NS_PREFIX}:${this.namespace}`;
    return userId ? `${base}:user:${userId}` : base;
  }

  async getEntity(userId: string, entityId: string): Promise<Entity | null> {
    return this.storage.get<Entity>(this.ns(userId), entityId);
  }

  async listEntities(userId: string): Promise<Entity[]> {
    const entries = await this.storage.list<Entity>(this.ns(userId));
    return entries.map((e) => e.value);
  }

  async upsertEntity(userId: string, entity: Partial<Entity> & { name: string; entityType: string }): Promise<Entity> {
    const entityId = entity.entityId ?? entity.name.toLowerCase().replace(/\s+/g, "_");
    const existing = await this.getEntity(userId, entityId);

    const dedup = (arr: any[], key: string, max: number) => {
      const seen = new Set<string>();
      const result = [];
      for (const item of arr) {
        const k = typeof item === "string" ? item : (item[key] ?? JSON.stringify(item));
        if (!seen.has(k)) {
          seen.add(k);
          result.push(item);
        }
      }
      return result.slice(-max);
    };

    const updated: Entity = {
      entityId,
      entityType: entity.entityType,
      name: entity.name,
      description: entity.description ?? existing?.description,
      properties: { ...existing?.properties, ...entity.properties },
      facts: dedup([...(existing?.facts ?? []), ...(entity.facts ?? [])], "fact", 50),
      events: dedup([...(existing?.events ?? []), ...(entity.events ?? [])], "event", 50),
      relationships: dedup([...(existing?.relationships ?? []), ...(entity.relationships ?? [])], "target", 50),
      createdAt: existing?.createdAt ?? new Date(),
      updatedAt: new Date(),
    };

    await this.storage.set(this.ns(userId), entityId, updated);
    return updated;
  }

  async addFact(userId: string, entityId: string, fact: string): Promise<void> {
    const entity = await this.getEntity(userId, entityId);
    if (!entity) return;

    const now = new Date();
    entity.facts.push({ id: uuidv4(), fact, validFrom: now, createdAt: now });
    entity.updatedAt = now;
    await this.storage.set(this.ns(userId), entityId, entity);
  }

  async addEvent(userId: string, entityId: string, event: string, date?: string): Promise<void> {
    const entity = await this.getEntity(userId, entityId);
    if (!entity) return;

    const now = new Date();
    entity.events.push({ id: uuidv4(), event, date, validFrom: now, createdAt: now });
    entity.updatedAt = new Date();
    await this.storage.set(this.ns(userId), entityId, entity);
  }

  async deleteEntity(userId: string, entityId: string): Promise<void> {
    await this.storage.delete(this.ns(userId), entityId);
  }

  async clear(userId: string): Promise<void> {
    const entities = await this.listEntities(userId);
    for (const entity of entities) {
      await this.storage.delete(this.ns(userId), entity.entityId);
    }
  }

  async getContextString(userId: string | undefined, currentInput?: string): Promise<string> {
    if (!userId) return "";
    const entities = await this.listEntities(userId);
    if (entities.length === 0) return "";

    let relevant = entities;
    if (currentInput) {
      const inputLower = currentInput.toLowerCase();
      const scored = entities.map((e) => ({
        entity: e,
        score:
          (inputLower.includes(e.name.toLowerCase()) ? 10 : 0) +
          (e.facts?.some((f) => inputLower.includes(f.fact?.toLowerCase() ?? "")) ? 5 : 0) +
          (e.description?.toLowerCase().includes(inputLower) ? 3 : 0),
      }));
      scored.sort((a, b) => b.score - a.score);
      relevant = scored.filter((s) => s.score > 0).map((s) => s.entity);
      if (relevant.length === 0) relevant = entities.slice(0, 5);
    } else {
      relevant = entities.slice(0, 10);
    }

    const lines = relevant.slice(0, 10).map((e) => {
      const parts = [`- ${e.name} (${e.entityType})`];
      if (e.description) parts[0] += `: ${e.description}`;
      const activeFacts = (e.facts ?? []).filter((f) => !f.invalidatedAt);
      for (const f of activeFacts.slice(-3)) {
        parts.push(`  - ${f.fact}`);
      }
      return parts.join("\n");
    });

    return `Known entities:\n${lines.join("\n")}`;
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "search_entities",
        description: "Search known entities (companies, people, projects) by name or type.",
        parameters: z.object({
          query: z.string().optional().describe("Search term"),
          entityType: z.string().optional().describe("Filter by type: company, person, project, product"),
        }),
        execute: async (args, ctx) => {
          if (!ctx.userId) return "No user identified for this session.";
          let entities = await this.listEntities(ctx.userId);
          if (args.entityType) {
            entities = entities.filter((e) => e.entityType === args.entityType);
          }
          if (args.query) {
            const q = (args.query as string).toLowerCase();
            entities = entities.filter(
              (e) =>
                e.name.toLowerCase().includes(q) ||
                e.description?.toLowerCase().includes(q) ||
                e.facts.some((f) => f.fact.toLowerCase().includes(q)),
            );
          }
          if (entities.length === 0) return "No matching entities found.";
          return entities
            .map((e) => `${e.name} (${e.entityType}): ${e.facts.map((f) => f.fact).join("; ")}`)
            .join("\n");
        },
      },
      {
        name: "create_entity",
        description: "Create or update an entity (company, person, project) with facts.",
        parameters: z.object({
          name: z.string().describe("Entity name"),
          entityType: z.string().describe("Type: company, person, project, product, other"),
          description: z.string().optional().describe("Brief description"),
          facts: z.array(z.string()).optional().describe("Facts about this entity"),
        }),
        execute: async (args, ctx) => {
          if (!ctx.userId) return "No user identified for this session.";
          const entity = await this.upsertEntity(ctx.userId, {
            name: args.name as string,
            entityType: args.entityType as string,
            description: args.description as string | undefined,
            facts: ((args.facts as string[]) ?? []).map((f) => ({
              id: uuidv4(),
              fact: f,
              validFrom: new Date(),
              createdAt: new Date(),
            })),
          });
          return `Entity "${entity.name}" saved with ${entity.facts.length} facts.`;
        },
      },
    ];
  }

  async extractEntities(
    userId: string | undefined,
    messages: ChatMessage[],
    fallbackModel?: ModelProvider,
  ): Promise<void> {
    if (!userId) return;
    const model = this.model ?? fallbackModel;
    if (!model) return;

    try {
      const existing = await this.listEntities(userId);
      const knownStr = existing.length > 0 ? existing.map((e) => `- ${e.name} (${e.entityType})`).join("\n") : "(none)";

      const conversationStr = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => {
          const content = typeof m.content === "string" ? m.content : "(multimodal)";
          return `${m.role}: ${content}`;
        })
        .join("\n");

      const today = new Date().toISOString().slice(0, 10);
      const prompt = EXTRACTION_PROMPT.replace("{today}", today)
        .replace("{knownEntities}", knownStr)
        .replace("{conversation}", conversationStr);

      const response = await model.generate([{ role: "user", content: prompt }], {
        temperature: 0,
        maxTokens: 800,
      });

      const text = typeof response.message.content === "string" ? response.message.content : "";
      if (!text) return;

      const jsonStr = extractJsonArray(text);
      const parsed = JSON.parse(jsonStr);

      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!item?.name || !item?.entityType) continue;

          await this.upsertEntity(userId, {
            name: item.name,
            entityType: item.entityType,
            facts: (item.facts ?? []).map((f: string) => ({
              id: uuidv4(),
              fact: f,
              createdAt: new Date(),
            })),
            events: (item.events ?? []).map((e: any) => ({
              id: uuidv4(),
              event: e.event ?? e,
              date: e.date,
              createdAt: new Date(),
            })),
          });
        }
      }
    } catch (err) {
      console.warn("[EntityMemory] extractEntities failed:", (err as Error).message ?? err);
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
