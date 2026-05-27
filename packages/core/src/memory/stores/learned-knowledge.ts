import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import type { ModelProvider } from "../../models/provider.js";
import type { ChatMessage } from "../../models/types.js";
import type { StorageDriver } from "../../storage/driver.js";
import type { ToolDef } from "../../tools/types.js";
import type { VectorStore } from "../../vector/types.js";

const NS = "memory:learnings";

export interface Learning {
  id: string;
  title: string;
  content: string;
  context: string;
  tags: string[];
  namespace: string;
  importance?: number;
  userId?: string;
  createdAt: Date;
}

const EXTRACTION_PROMPT = `You are a knowledge extraction assistant. Analyze the conversation and extract reusable insights or learnings that would help in future conversations.

Focus on:
- Patterns and best practices discovered
- Domain-specific knowledge shared
- Solutions to problems that could be reused
- User preferences that inform approach

Do NOT extract:
- Trivial or obvious information
- Personal user facts (those belong in user memory)

Return ONLY a JSON array:
[{"title": "short title", "content": "the insight", "context": "when this applies", "tags": ["tag1"]}]

If nothing useful, return [].

Conversation:
{conversation}`;

export class LearnedKnowledge {
  private vectorStore: VectorStore;
  private storage: StorageDriver;
  private model?: ModelProvider;
  private collection: string;
  private topK: number;
  private initPromise: Promise<void> | null = null;

  constructor(
    vectorStore: VectorStore,
    storage: StorageDriver,
    config?: { model?: ModelProvider; collection?: string; topK?: number },
  ) {
    this.vectorStore = vectorStore;
    this.storage = storage;
    this.model = config?.model;
    this.collection = config?.collection ?? "agentium_learnings";
    this.topK = config?.topK ?? 3;
  }

  private async ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.vectorStore.initialize();
    }
    await this.initPromise;
  }

  async saveLearning(learning: Omit<Learning, "id" | "createdAt">): Promise<Learning> {
    await this.ensureInit();

    const entry: Learning = {
      ...learning,
      id: uuidv4(),
      createdAt: new Date(),
    };

    await this.vectorStore.upsert(this.collection, {
      id: entry.id,
      content: `${entry.title}: ${entry.content}`,
      metadata: {
        title: entry.title,
        context: entry.context,
        tags: entry.tags,
        namespace: entry.namespace,
        userId: entry.userId,
      },
    });

    await this.storage.set(NS, entry.id, entry);
    return entry;
  }

  async searchLearnings(query: string, topK?: number, userId?: string): Promise<Learning[]> {
    await this.ensureInit();

    // Over-fetch when filtering by userId — vector stores don't all support
    // metadata predicates, so we re-filter after the fetch.
    const want = topK ?? this.topK;
    const fetchK = userId ? want * 4 : want;
    const results = await this.vectorStore.search(this.collection, query, { topK: fetchK });

    const learnings: Learning[] = [];
    for (const result of results) {
      const full = await this.storage.get<Learning>(NS, result.id);
      if (!full) continue;
      if (userId && full.userId !== userId) continue; // strict user isolation
      learnings.push(full);
      if (learnings.length >= want) break;
    }

    return learnings;
  }

  async getLearning(id: string): Promise<Learning | null> {
    return this.storage.get<Learning>(NS, id);
  }

  async deleteLearning(id: string): Promise<void> {
    await this.ensureInit();
    await this.vectorStore.delete(this.collection, id);
    await this.storage.delete(NS, id);
  }

  async getContextString(currentInput?: string, userId?: string): Promise<string> {
    if (!currentInput) return "";
    // Without a userId we can't safely scope — refuse to surface anything
    // rather than risk leaking another user's learnings.
    if (!userId) return "";

    try {
      const learnings = await this.searchLearnings(currentInput, undefined, userId);
      if (learnings.length === 0) return "";

      const lines = learnings.map((l) => `- ${l.title}: ${l.content} (applies when: ${l.context})`);

      return `Relevant learnings:\n${lines.join("\n")}`;
    } catch {
      return "";
    }
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "save_learning",
        description: "Save a reusable insight or learning discovered during this conversation for future reference.",
        parameters: z.object({
          title: z.string().describe("Short title for the learning"),
          content: z.string().describe("The insight or knowledge to save"),
          context: z.string().describe("When this learning applies"),
          tags: z.array(z.string()).optional().describe("Tags for categorization"),
        }),
        execute: async (args, ctx) => {
          const entry = await this.saveLearning({
            title: args.title as string,
            content: args.content as string,
            context: args.context as string,
            tags: (args.tags as string[]) ?? [],
            namespace: "global",
            userId: ctx.userId,
          });
          return `Learning saved: "${entry.title}" (${entry.id})`;
        },
      },
      {
        name: "search_learnings",
        description: "Search previously saved insights and learnings by query.",
        parameters: z.object({
          query: z.string().describe("What to search for"),
          limit: z.number().optional().describe("Max results (default 5)"),
        }),
        execute: async (args, ctx) => {
          const results = await this.searchLearnings(
            args.query as string,
            (args.limit as number) ?? 5,
            ctx.userId, // scope retrieval to the calling user
          );
          if (results.length === 0) return "No matching learnings found.";
          return results.map((l) => `[${l.id}] ${l.title}: ${l.content}`).join("\n\n");
        },
      },
    ];
  }

  async extractLearnings(messages: ChatMessage[], fallbackModel?: ModelProvider, userId?: string): Promise<void> {
    const model = this.model ?? fallbackModel;
    if (!model) return;

    try {
      const conversationStr = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => {
          const content = typeof m.content === "string" ? m.content : "(multimodal)";
          return `${m.role}: ${content}`;
        })
        .join("\n");

      const prompt = EXTRACTION_PROMPT.replace("{conversation}", conversationStr);

      const response = await model.generate([{ role: "user", content: prompt }], {
        temperature: 0,
        maxTokens: 800,
      });

      const text = typeof response.message.content === "string" ? response.message.content : "";
      if (!text) return;

      const parsed = safeParseJsonArray(text);

      for (const raw of parsed) {
        const item = raw as Record<string, unknown>;
        if (!item?.title || !item?.content) continue;
        await this.saveLearning({
          title: item.title as string,
          content: item.content as string,
          context: (item.context as string) ?? "",
          tags: (item.tags as string[]) ?? [],
          namespace: "global",
          userId,
        });
      }
    } catch (err) {
      console.warn("[LearnedKnowledge] extractLearnings failed:", (err as Error).message ?? err);
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

function repairJson(raw: string): string {
  let s = raw;
  // Remove trailing commas before ] or }
  s = s.replace(/,\s*([}\]])/g, "$1");
  // Replace unescaped control characters inside strings
  s = s.replace(/"(?:[^"\\]|\\.)*"/g, (match) =>
    match
      .replace(/(?<!\\)\t/g, "\\t")
      .replace(/(?<!\\)\n/g, "\\n")
      .replace(/(?<!\\)\r/g, "\\r"),
  );
  return s;
}

function safeParseJsonArray(text: string): unknown[] {
  const jsonStr = extractJsonArray(text);

  try {
    const result = JSON.parse(jsonStr);
    if (Array.isArray(result)) return result;
    return [];
  } catch {
    // attempt repair and retry
  }

  try {
    const repaired = repairJson(jsonStr);
    const result = JSON.parse(repaired);
    if (Array.isArray(result)) return result;
    return [];
  } catch {
    // last resort: extract objects individually via regex
  }

  const objects: unknown[] = [];
  const objRegex = /\{[^{}]*"title"\s*:\s*"[^"]*"[^{}]*\}/g;
  let match: RegExpExecArray | null;
  while ((match = objRegex.exec(jsonStr)) !== null) {
    try {
      objects.push(JSON.parse(match[0]));
    } catch {
      try {
        objects.push(JSON.parse(repairJson(match[0])));
      } catch {
        // skip unparseable object
      }
    }
  }
  return objects;
}
