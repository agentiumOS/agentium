import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import type { ModelProvider } from "../../models/provider.js";
import type { ChatMessage } from "../../models/types.js";
import type { StorageDriver } from "../../storage/driver.js";
import type { ToolDef } from "../../tools/types.js";
import type { VectorStore } from "../../vector/types.js";

const NS = "memory:learnings";

/**
 * Scope of a stored learning — controls who can read it back.
 *
 * - `"user"`    (default) only the user that saved it sees it.
 * - `"agent"`   every user of this agent / role sees it. Use for workflow knowledge
 *               like "invoice reconciliation patterns" or "common refund triggers".
 * - `"tenant"`  every user/agent in the tenant sees it. Org-wide policies.
 * - `"global"`  truly cross-tenant (rare — usually only for built-in defaults).
 *
 * When searching, the caller passes the scope identifiers they're authorized
 * for (their `userId`, current `agentName`, current `tenantId`) and the union
 * of accessible scopes is returned.
 */
export type LearningScope = "user" | "agent" | "tenant" | "global";

export interface Learning {
  id: string;
  title: string;
  content: string;
  context: string;
  tags: string[];
  namespace: string;
  importance?: number;
  /** Defaults to "user" when omitted (backward-compat for pre-v2.3 data). */
  scope?: LearningScope;
  userId?: string;
  agentName?: string;
  tenantId?: string;
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

    // Default to user scope for backward-compat and safety.
    const scope: LearningScope = learning.scope ?? "user";

    // Validate that the chosen scope has its identifier — fail loud, not silent.
    if (scope === "user" && !learning.userId) {
      throw new Error("LearnedKnowledge.saveLearning: scope='user' requires a userId");
    }
    if (scope === "agent" && !learning.agentName) {
      throw new Error("LearnedKnowledge.saveLearning: scope='agent' requires an agentName");
    }
    if (scope === "tenant" && !learning.tenantId) {
      throw new Error("LearnedKnowledge.saveLearning: scope='tenant' requires a tenantId");
    }

    const entry: Learning = {
      ...learning,
      scope,
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
        scope: entry.scope,
        userId: entry.userId,
        agentName: entry.agentName,
        tenantId: entry.tenantId,
      },
    });

    await this.storage.set(NS, entry.id, entry);
    return entry;
  }

  /**
   * Visibility predicate: is the caller authorized to read this learning?
   *
   * Returns true if any one of these matches:
   *   - scope=global
   *   - scope=tenant AND caller's tenantId matches
   *   - scope=agent  AND caller's agentName matches
   *   - scope=user   AND caller's userId matches
   *
   * Pre-v2.3 data without a `scope` field is treated as user-scoped
   * (the safe default).
   */
  private canSee(
    learning: Learning,
    caller: { userId?: string; agentName?: string; tenantId?: string },
  ): boolean {
    const scope: LearningScope = learning.scope ?? "user";
    if (scope === "global") return true;
    if (scope === "tenant") return !!caller.tenantId && caller.tenantId === learning.tenantId;
    if (scope === "agent") return !!caller.agentName && caller.agentName === learning.agentName;
    return !!caller.userId && caller.userId === learning.userId;
  }

  /**
   * Search learnings visible to the caller. Vector matches are post-filtered
   * by `canSee()` — vector backends don't all support metadata predicates, so
   * we over-fetch and filter in-process.
   */
  async searchLearnings(
    query: string,
    opts?: {
      topK?: number;
      userId?: string;
      agentName?: string;
      tenantId?: string;
    },
  ): Promise<Learning[]> {
    await this.ensureInit();

    const want = opts?.topK ?? this.topK;
    // Over-fetch generously when filtering — multiple scopes mean many candidates.
    const hasFilter = !!(opts?.userId || opts?.agentName || opts?.tenantId);
    const fetchK = hasFilter ? want * 5 : want;
    const results = await this.vectorStore.search(this.collection, query, { topK: fetchK });

    const caller = {
      userId: opts?.userId,
      agentName: opts?.agentName,
      tenantId: opts?.tenantId,
    };

    const learnings: Learning[] = [];
    for (const result of results) {
      const full = await this.storage.get<Learning>(NS, result.id);
      if (!full) continue;
      if (hasFilter && !this.canSee(full, caller)) continue;
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

  async getContextString(
    currentInput?: string,
    opts?: { userId?: string; agentName?: string; tenantId?: string },
  ): Promise<string> {
    if (!currentInput) return "";
    // Without ANY scope identifier we can't safely surface anything — refuse
    // rather than risk leaking another user's / tenant's learnings.
    if (!opts?.userId && !opts?.agentName && !opts?.tenantId) return "";

    try {
      const learnings = await this.searchLearnings(currentInput, opts);
      if (learnings.length === 0) return "";

      // Annotate each line with its scope so the model can reason about whether
      // a learning is personal or organizational.
      const lines = learnings.map((l) => {
        const scope = l.scope ?? "user";
        const tag = scope === "user" ? "" : ` [${scope}]`;
        return `- ${l.title}${tag}: ${l.content} (applies when: ${l.context})`;
      });

      return `Relevant learnings:\n${lines.join("\n")}`;
    } catch {
      return "";
    }
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "save_learning",
        description:
          "Save a reusable insight discovered during this conversation. Scope controls who can see it: " +
          '"user" (default — only the current user), "agent" (the whole workflow / team using this agent), ' +
          '"tenant" (whole organization). Use "agent" for workflow patterns like invoice-reconciliation rules; ' +
          'use "user" for personal preferences.',
        parameters: z.object({
          title: z.string().describe("Short title for the learning"),
          content: z.string().describe("The insight or knowledge to save"),
          context: z.string().describe("When this learning applies"),
          tags: z.array(z.string()).optional().describe("Tags for categorization"),
          scope: z
            .enum(["user", "agent", "tenant"])
            .optional()
            .describe('Default "user". Use "agent" for shared workflow knowledge.'),
        }),
        execute: async (args, ctx) => {
          const scope = (args.scope as LearningScope | undefined) ?? "user";
          const agentName = typeof ctx.metadata?.agentName === "string" ? ctx.metadata.agentName : undefined;
          const tenantId = typeof ctx.metadata?.tenantId === "string" ? ctx.metadata.tenantId : undefined;

          // Reject scopes the caller can't anchor — the framework can't fall
          // back to "agent" if no agentName is in context.
          if (scope === "agent" && !agentName) return "Cannot save with scope='agent': no agentName in context.";
          if (scope === "tenant" && !tenantId) return "Cannot save with scope='tenant': no tenantId in context.";
          if (scope === "user" && !ctx.userId) return "Cannot save with scope='user': no userId for this session.";

          const entry = await this.saveLearning({
            title: args.title as string,
            content: args.content as string,
            context: args.context as string,
            tags: (args.tags as string[]) ?? [],
            namespace: "global",
            scope,
            userId: scope === "user" ? ctx.userId : undefined,
            agentName: scope === "agent" ? agentName : undefined,
            tenantId: scope === "tenant" ? tenantId : undefined,
          });
          return `Learning saved with scope='${scope}': "${entry.title}" (${entry.id})`;
        },
      },
      {
        name: "search_learnings",
        description:
          "Search saved insights visible to the current user, agent, and tenant (union of all accessible scopes).",
        parameters: z.object({
          query: z.string().describe("What to search for"),
          limit: z.number().optional().describe("Max results (default 5)"),
        }),
        execute: async (args, ctx) => {
          const agentName = typeof ctx.metadata?.agentName === "string" ? ctx.metadata.agentName : undefined;
          const tenantId = typeof ctx.metadata?.tenantId === "string" ? ctx.metadata.tenantId : undefined;
          const results = await this.searchLearnings(args.query as string, {
            topK: (args.limit as number) ?? 5,
            userId: ctx.userId,
            agentName,
            tenantId,
          });
          if (results.length === 0) return "No matching learnings found.";
          return results
            .map((l) => `[${l.id}] [${l.scope ?? "user"}] ${l.title}: ${l.content}`)
            .join("\n\n");
        },
      },
    ];
  }

  async extractLearnings(messages: ChatMessage[], fallbackModel?: ModelProvider, userId?: string): Promise<void> {
    const model = this.model ?? fallbackModel;
    if (!model) return;
    // Auto-extraction has no informed consent to promote a learning to a wider
    // scope — always save as user-scoped. Users can explicitly promote via
    // the `save_learning` tool with `scope: "agent"`.
    if (!userId) return;

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
          scope: "user",
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
