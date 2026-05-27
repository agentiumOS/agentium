import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import type { ModelProvider } from "../../models/provider.js";
import type { ChatMessage } from "../../models/types.js";
import type { StorageDriver } from "../../storage/driver.js";
import type { ToolDef } from "../../tools/types.js";

const NS = "memory:procedures";

/**
 * Procedure scope — same hierarchy as LearnedKnowledge.
 * Auto-extracted procedures default to "user". The agent can use scope="agent"
 * for shared workflow templates (e.g. "invoice reconciliation").
 */
export type ProcedureScope = "user" | "agent" | "tenant" | "global";

/**
 * Namespace key for a given scope. Per-scope partitioning keeps storage
 * queries cheap — we never have to scan everything to find the right scope.
 */
const nsFor = (scope: ProcedureScope, owner?: string): string => {
  if (scope === "global") return `${NS}:global`;
  if (!owner) throw new Error(`ProcedureMemory: scope=${scope} requires an owner identifier`);
  return `${NS}:${scope}:${owner}`;
};

/** Legacy compat: pre-v2.3 callers passed a userId directly. */
const nsForUser = (userId?: string) => (userId ? nsFor("user", userId) : NS);

export interface ProcedureStep {
  toolName: string;
  argsSnapshot: Record<string, unknown>;
  resultSummary: string;
}

export interface Procedure {
  id: string;
  trigger: string;
  description: string;
  steps: ProcedureStep[];
  successCount: number;
  lastUsed: Date;
  createdAt: Date;
  /** Defaults to "user" when omitted (backward-compat for pre-v2.3 data). */
  scope?: ProcedureScope;
  /** Set when scope === "user". */
  userId?: string;
  /** Set when scope === "agent". */
  agentName?: string;
  /** Set when scope === "tenant". */
  tenantId?: string;
}

export interface ProcedureMemoryConfig {
  maxProcedures?: number;
  model?: ModelProvider;
}

const EXTRACTION_PROMPT = `You are a workflow extraction assistant. Analyze the conversation and identify any multi-step workflows (tool-call sequences) that were successfully completed.

For each workflow, extract:
- trigger: a short description of what task this workflow accomplishes
- description: a sentence explaining the steps
- steps: array of {toolName, argsSummary, resultSummary}

Only extract workflows with 2+ tool calls that completed successfully.
Return ONLY a JSON array: [{"trigger": "str", "description": "str", "steps": [{"toolName": "str", "argsSummary": "str", "resultSummary": "str"}]}]

If no workflows found, return [].

Conversation:
{conversation}`;

export class ProcedureMemory {
  private storage: StorageDriver;
  private model?: ModelProvider;
  private maxProcedures: number;

  constructor(storage: StorageDriver, config?: ProcedureMemoryConfig) {
    this.storage = storage;
    this.model = config?.model;
    this.maxProcedures = config?.maxProcedures ?? 50;
  }

  /**
   * Return every procedure visible to the caller — the union of their personal
   * scope, the procedures saved against their current agent, and the tenant's
   * shared procedures.
   */
  async getProcedures(caller?: {
    userId?: string;
    agentName?: string;
    tenantId?: string;
  }): Promise<Procedure[]> {
    if (!caller) {
      // Legacy path used only by the curator for global maintenance reads.
      const entries = await this.storage.list<Procedure>(NS);
      return entries.map((e) => e.value).sort((a, b) => b.successCount - a.successCount);
    }
    const results: Procedure[] = [];
    if (caller.userId) {
      const e = await this.storage.list<Procedure>(nsFor("user", caller.userId));
      results.push(...e.map((x) => x.value));
    }
    if (caller.agentName) {
      const e = await this.storage.list<Procedure>(nsFor("agent", caller.agentName));
      results.push(...e.map((x) => x.value));
    }
    if (caller.tenantId) {
      const e = await this.storage.list<Procedure>(nsFor("tenant", caller.tenantId));
      results.push(...e.map((x) => x.value));
    }
    const globalEntries = await this.storage.list<Procedure>(nsFor("global"));
    results.push(...globalEntries.map((x) => x.value));
    return results.sort((a, b) => b.successCount - a.successCount);
  }

  async getProcedure(scope: ProcedureScope, owner: string | undefined, id: string): Promise<Procedure | null> {
    return this.storage.get<Procedure>(nsFor(scope, owner), id);
  }

  /**
   * Save a procedure at the chosen scope. The caller is responsible for
   * supplying the right owner identifier for that scope.
   */
  async saveProcedure(
    proc: Omit<Procedure, "id" | "createdAt" | "successCount" | "lastUsed">,
  ): Promise<Procedure> {
    const scope: ProcedureScope = proc.scope ?? "user";
    const owner =
      scope === "user" ? proc.userId
      : scope === "agent" ? proc.agentName
      : scope === "tenant" ? proc.tenantId
      : undefined;
    if (scope !== "global" && !owner) {
      throw new Error(`ProcedureMemory.saveProcedure: scope=${scope} requires the matching owner field.`);
    }
    const ns = nsFor(scope, owner);

    // Dedup against everything VISIBLE to this owner at this scope.
    const existing = (await this.storage.list<Procedure>(ns)).map((e) => e.value);
    const similar = existing.find((p) => p.trigger.toLowerCase() === proc.trigger.toLowerCase());

    if (similar) {
      similar.successCount++;
      similar.lastUsed = new Date();
      similar.steps = proc.steps;
      similar.description = proc.description;
      await this.storage.set(ns, similar.id, similar);
      return similar;
    }

    const entry: Procedure = {
      ...proc,
      scope,
      id: uuidv4(),
      successCount: 1,
      lastUsed: new Date(),
      createdAt: new Date(),
    };

    await this.storage.set(ns, entry.id, entry);

    if (existing.length >= this.maxProcedures) {
      const sorted = existing.sort((a, b) => new Date(a.lastUsed).getTime() - new Date(b.lastUsed).getTime());
      const toRemove = sorted.slice(0, existing.length - this.maxProcedures + 1);
      for (const p of toRemove) {
        await this.storage.delete(ns, p.id);
      }
    }

    return entry;
  }

  async suggestProcedure(
    caller: { userId?: string; agentName?: string; tenantId?: string },
    input: string,
  ): Promise<Procedure | null> {
    const all = await this.getProcedures(caller);
    if (all.length === 0) return null;

    const inputLower = input.toLowerCase();
    let best: Procedure | null = null;
    let bestScore = 0;

    for (const proc of all) {
      let score = 0;
      const triggerLower = proc.trigger.toLowerCase();
      const descLower = proc.description.toLowerCase();

      if (inputLower.includes(triggerLower) || triggerLower.includes(inputLower)) score += 10;

      const words = inputLower.split(/\s+/);
      for (const word of words) {
        if (word.length < 3) continue;
        if (triggerLower.includes(word)) score += 3;
        if (descLower.includes(word)) score += 1;
      }

      score += Math.min(proc.successCount * 0.5, 5);

      if (score > bestScore) {
        bestScore = score;
        best = proc;
      }
    }

    return bestScore >= 3 ? best : null;
  }

  async getContextString(
    currentInput?: string,
    caller?: { userId?: string; agentName?: string; tenantId?: string },
  ): Promise<string> {
    if (!currentInput) return "";
    if (!caller?.userId && !caller?.agentName && !caller?.tenantId) return "";

    const suggestion = await this.suggestProcedure(caller, currentInput);
    if (!suggestion) return "";

    // Don't dump raw argsSnapshot (often PII) into the prompt — surface only the tool name.
    const stepsStr = suggestion.steps.map((s, i) => `  ${i + 1}. ${s.toolName}() → ${s.resultSummary}`).join("\n");

    const scopeTag = suggestion.scope && suggestion.scope !== "user" ? ` [${suggestion.scope}]` : "";
    return `Suggested procedure${scopeTag} (used ${suggestion.successCount}x): ${suggestion.trigger}\n${stepsStr}`;
  }

  async extractProcedures(
    userId: string | undefined,
    messages: ChatMessage[],
    fallbackModel?: ModelProvider,
  ): Promise<void> {
    // Auto-extraction has no informed consent to share — always save user-scoped.
    if (!userId) return;
    const model = this.model ?? fallbackModel;
    if (!model) return;

    try {
      const conversationStr = messages
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

      const jsonStr = extractJsonArray(text);
      const parsed = JSON.parse(jsonStr);

      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!item?.trigger || !item?.steps || !Array.isArray(item.steps) || item.steps.length < 2) continue;

          await this.saveProcedure({
            scope: "user",
            userId,
            trigger: item.trigger,
            description: item.description ?? item.trigger,
            steps: item.steps.map((s: any) => ({
              toolName: s.toolName ?? "unknown",
              argsSnapshot: typeof s.argsSummary === "string" ? { summary: s.argsSummary } : (s.argsSnapshot ?? {}),
              resultSummary: s.resultSummary ?? "",
            })),
          });
        }
      }
    } catch (err) {
      console.warn("[ProcedureMemory] extractProcedures failed:", (err as Error).message ?? err);
    }
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "recall_procedure",
        description:
          "Search for a known multi-step workflow that matches the current task. " +
          "Searches across personal procedures, agent-wide workflows (e.g. shared invoice " +
          "reconciliation steps), and tenant-level org procedures.",
        parameters: z.object({
          task: z.string().describe("Description of the task to find a procedure for"),
        }),
        execute: async (args, ctx) => {
          const agentName = typeof ctx.metadata?.agentName === "string" ? ctx.metadata.agentName : undefined;
          const tenantId = typeof ctx.metadata?.tenantId === "string" ? ctx.metadata.tenantId : undefined;
          const suggestion = await this.suggestProcedure(
            { userId: ctx.userId, agentName, tenantId },
            args.task as string,
          );
          if (!suggestion) return "No matching procedure found. You may need to figure out the steps yourself.";
          const stepsStr = suggestion.steps.map((s, i) => `${i + 1}. ${s.toolName} → ${s.resultSummary}`).join("\n");
          const scopeTag = suggestion.scope && suggestion.scope !== "user" ? ` [${suggestion.scope}]` : "";
          return `Procedure${scopeTag}: ${suggestion.trigger} (used ${suggestion.successCount}x)\n${stepsStr}`;
        },
      },
    ];
  }

  /**
   * Clear procedures. With no `caller` provided this wipes the legacy
   * unscoped namespace only — used by curator maintenance. To wipe a
   * specific scope, pass `{ scope, owner }`.
   */
  async clear(opts?: { scope?: ProcedureScope; owner?: string } | string): Promise<void> {
    // Back-compat: old callers passed a userId string directly.
    if (typeof opts === "string") {
      const ns = nsForUser(opts);
      const all = await this.storage.list<Procedure>(ns);
      for (const entry of all) await this.storage.delete(ns, entry.key);
      return;
    }
    if (opts?.scope) {
      const ns = nsFor(opts.scope, opts.owner);
      const all = await this.storage.list<Procedure>(ns);
      for (const entry of all) await this.storage.delete(ns, entry.key);
      return;
    }
    // No scope: legacy unscoped namespace.
    const all = await this.storage.list<Procedure>(NS);
    for (const entry of all) await this.storage.delete(NS, entry.key);
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
