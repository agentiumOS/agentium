import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import type { StorageDriver } from "../../storage/driver.js";
import type { ToolDef } from "../../tools/types.js";
import type { VectorStore } from "../../vector/types.js";
import type { LearningScope } from "./learned-knowledge.js";

const NS = "memory:corrections";

/**
 * A structured record of a human correcting an agent's output.
 *
 * Unlike a `Learning` (free-text insight), a Correction captures exactly
 * WHAT was wrong and WHAT it should have been — field-level, anchored to
 * the run that produced the mistake. Corrections are embedded and retrieved
 * at inference time so the same mistake is not repeated.
 */
export interface Correction {
  id: string;
  /** Agent whose output was corrected. */
  agentName: string;
  /** Run that produced the corrected output (RunOutput.runId). */
  runId?: string;
  sessionId?: string;
  /** The specific field/aspect corrected, e.g. "chargeCode", "allocation". */
  field?: string;
  /** What the agent produced. */
  originalValue: string;
  /** What it should have been. */
  correctedValue: string;
  /** Human explanation of why — this is what generalizes to future runs. */
  reason?: string;
  /**
   * Groups corrections by the real-world entity they apply to,
   * e.g. a vendor ID or customer code. Enables per-entity accuracy stats.
   */
  entityKey?: string;
  tags: string[];
  /**
   * Defaults to "agent" — a correction to an agent's output is workflow
   * knowledge that should benefit every user of that agent.
   */
  scope?: LearningScope;
  userId?: string;
  tenantId?: string;
  createdAt: Date;
}

export interface CorrectionStats {
  total: number;
  byEntityKey: Record<string, number>;
  byField: Record<string, number>;
}

export class CorrectionStore {
  private vectorStore: VectorStore;
  private storage: StorageDriver;
  private collection: string;
  private topK: number;
  private initPromise: Promise<void> | null = null;
  private onRecorded?: (correction: Correction) => void;

  constructor(
    vectorStore: VectorStore,
    storage: StorageDriver,
    config?: {
      collection?: string;
      topK?: number;
      /** Called after every successful record — used to emit events. */
      onRecorded?: (correction: Correction) => void;
    },
  ) {
    this.vectorStore = vectorStore;
    this.storage = storage;
    this.collection = config?.collection ?? "agentium_corrections";
    this.topK = config?.topK ?? 3;
    this.onRecorded = config?.onRecorded;
  }

  private async ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.vectorStore.initialize();
    }
    await this.initPromise;
  }

  /** Text that gets embedded — what semantic retrieval matches against. */
  private embeddingText(c: Omit<Correction, "id" | "createdAt">): string {
    const parts: string[] = [];
    if (c.field) parts.push(`${c.field}:`);
    parts.push(`"${c.originalValue}" should be "${c.correctedValue}"`);
    if (c.reason) parts.push(`because ${c.reason}`);
    if (c.entityKey) parts.push(`(applies to ${c.entityKey})`);
    return parts.join(" ");
  }

  async recordCorrection(
    correction: Omit<Correction, "id" | "createdAt" | "tags"> & { tags?: string[] },
  ): Promise<Correction> {
    await this.ensureInit();

    if (!correction.agentName) {
      throw new Error("CorrectionStore.recordCorrection: agentName is required");
    }
    if (!correction.originalValue || !correction.correctedValue) {
      throw new Error("CorrectionStore.recordCorrection: originalValue and correctedValue are required");
    }

    // Corrections default to agent scope: fixing an agent's output is
    // workflow knowledge, not a personal preference.
    const scope: LearningScope = correction.scope ?? "agent";

    if (scope === "user" && !correction.userId) {
      throw new Error("CorrectionStore.recordCorrection: scope='user' requires a userId");
    }
    if (scope === "tenant" && !correction.tenantId) {
      throw new Error("CorrectionStore.recordCorrection: scope='tenant' requires a tenantId");
    }

    const entry: Correction = {
      ...correction,
      tags: correction.tags ?? [],
      scope,
      id: uuidv4(),
      createdAt: new Date(),
    };

    await this.vectorStore.upsert(this.collection, {
      id: entry.id,
      content: this.embeddingText(entry),
      metadata: {
        agentName: entry.agentName,
        field: entry.field,
        entityKey: entry.entityKey,
        tags: entry.tags,
        scope: entry.scope,
        userId: entry.userId,
        tenantId: entry.tenantId,
      },
    });

    await this.storage.set(NS, entry.id, entry);
    this.onRecorded?.(entry);
    return entry;
  }

  /**
   * Visibility predicate, mirroring LearnedKnowledge.canSee():
   *   - scope=global  → visible to all
   *   - scope=tenant  → caller's tenantId matches
   *   - scope=agent   → caller's agentName matches
   *   - scope=user    → caller's userId matches
   */
  private canSee(correction: Correction, caller: { userId?: string; agentName?: string; tenantId?: string }): boolean {
    const scope: LearningScope = correction.scope ?? "agent";
    if (scope === "global") return true;
    if (scope === "tenant") return !!caller.tenantId && caller.tenantId === correction.tenantId;
    if (scope === "agent") return !!caller.agentName && caller.agentName === correction.agentName;
    return !!caller.userId && caller.userId === correction.userId;
  }

  async searchCorrections(
    query: string,
    opts?: {
      topK?: number;
      userId?: string;
      agentName?: string;
      tenantId?: string;
      entityKey?: string;
    },
  ): Promise<Correction[]> {
    await this.ensureInit();

    const want = opts?.topK ?? this.topK;
    const hasFilter = !!(opts?.userId || opts?.agentName || opts?.tenantId || opts?.entityKey);
    // Over-fetch when filtering — not all vector backends support metadata predicates.
    const fetchK = hasFilter ? want * 5 : want;
    const results = await this.vectorStore.search(this.collection, query, { topK: fetchK });

    const caller = {
      userId: opts?.userId,
      agentName: opts?.agentName,
      tenantId: opts?.tenantId,
    };

    const corrections: Correction[] = [];
    for (const result of results) {
      const full = await this.storage.get<Correction>(NS, result.id);
      if (!full) continue;
      if (opts?.entityKey && full.entityKey !== opts.entityKey) continue;
      if ((opts?.userId || opts?.agentName || opts?.tenantId) && !this.canSee(full, caller)) continue;
      corrections.push(full);
      if (corrections.length >= want) break;
    }

    return corrections;
  }

  async getCorrection(id: string): Promise<Correction | null> {
    return this.storage.get<Correction>(NS, id);
  }

  async deleteCorrection(id: string): Promise<void> {
    await this.ensureInit();
    await this.vectorStore.delete(this.collection, id);
    await this.storage.delete(NS, id);
  }

  /** List corrections from KV storage, optionally filtered. Used for stats/audit. */
  async listCorrections(opts?: { agentName?: string; entityKey?: string; since?: Date }): Promise<Correction[]> {
    const all = await this.storage.list<Correction>(NS);
    return all
      .map((e) => e.value)
      .filter((c) => {
        if (opts?.agentName && c.agentName !== opts.agentName) return false;
        if (opts?.entityKey && c.entityKey !== opts.entityKey) return false;
        if (opts?.since && new Date(c.createdAt) < opts.since) return false;
        return true;
      })
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }

  /** Aggregate correction counts — the raw material for accuracy dashboards. */
  async getStats(opts?: { agentName?: string; since?: Date }): Promise<CorrectionStats> {
    const corrections = await this.listCorrections(opts);
    const byEntityKey: Record<string, number> = {};
    const byField: Record<string, number> = {};
    for (const c of corrections) {
      if (c.entityKey) byEntityKey[c.entityKey] = (byEntityKey[c.entityKey] ?? 0) + 1;
      if (c.field) byField[c.field] = (byField[c.field] ?? 0) + 1;
    }
    return { total: corrections.length, byEntityKey, byField };
  }

  async getContextString(
    currentInput?: string,
    opts?: { userId?: string; agentName?: string; tenantId?: string },
  ): Promise<string> {
    if (!currentInput) return "";
    // Refuse to surface anything without a scope identifier — same safety
    // posture as LearnedKnowledge.
    if (!opts?.userId && !opts?.agentName && !opts?.tenantId) return "";

    try {
      const corrections = await this.searchCorrections(currentInput, opts);
      if (corrections.length === 0) return "";

      const lines = corrections.map((c) => {
        const field = c.field ? `${c.field}: ` : "";
        const entity = c.entityKey ? ` [${c.entityKey}]` : "";
        const reason = c.reason ? ` — ${c.reason}` : "";
        return `- ${field}"${c.originalValue}" was corrected to "${c.correctedValue}"${entity}${reason}`;
      });

      return `Past corrections (avoid repeating these mistakes):\n${lines.join("\n")}`;
    } catch {
      return "";
    }
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "record_correction",
        description:
          "Record a correction when the user points out your output was wrong. Captures what was " +
          "produced vs what it should have been, so the mistake is not repeated in future runs. " +
          "Use entityKey to tie the correction to a real-world entity (e.g. a vendor ID).",
        parameters: z.object({
          field: z.string().optional().describe("The specific field or aspect that was wrong"),
          originalValue: z.string().describe("What was originally produced (the wrong value)"),
          correctedValue: z.string().describe("The correct value per the user"),
          reason: z.string().optional().describe("Why the correction applies — helps generalize"),
          entityKey: z.string().optional().describe("Entity this applies to, e.g. vendor or customer ID"),
          tags: z.array(z.string()).optional().describe("Tags for categorization"),
        }),
        execute: async (args, ctx) => {
          const agentName = typeof ctx.metadata?.agentName === "string" ? ctx.metadata.agentName : undefined;
          const tenantId = typeof ctx.metadata?.tenantId === "string" ? ctx.metadata.tenantId : undefined;
          if (!agentName) return "Cannot record correction: no agentName in context.";

          const entry = await this.recordCorrection({
            agentName,
            sessionId: ctx.sessionId,
            field: args.field as string | undefined,
            originalValue: args.originalValue as string,
            correctedValue: args.correctedValue as string,
            reason: args.reason as string | undefined,
            entityKey: args.entityKey as string | undefined,
            tags: (args.tags as string[]) ?? [],
            userId: ctx.userId,
            tenantId,
          });
          return `Correction recorded (${entry.id}): "${entry.originalValue}" → "${entry.correctedValue}"`;
        },
      },
      {
        name: "search_corrections",
        description:
          "Search past corrections relevant to the current task. Use before producing output " +
          "in areas where you have been corrected previously.",
        parameters: z.object({
          query: z.string().describe("What to search for"),
          entityKey: z.string().optional().describe("Filter to a specific entity, e.g. a vendor ID"),
          limit: z.number().optional().describe("Max results (default 5)"),
        }),
        execute: async (args, ctx) => {
          const agentName = typeof ctx.metadata?.agentName === "string" ? ctx.metadata.agentName : undefined;
          const tenantId = typeof ctx.metadata?.tenantId === "string" ? ctx.metadata.tenantId : undefined;
          const results = await this.searchCorrections(args.query as string, {
            topK: (args.limit as number) ?? 5,
            userId: ctx.userId,
            agentName,
            tenantId,
            entityKey: args.entityKey as string | undefined,
          });
          if (results.length === 0) return "No matching corrections found.";
          return results
            .map((c) => {
              const field = c.field ? `${c.field}: ` : "";
              return `[${c.id}] ${field}"${c.originalValue}" → "${c.correctedValue}"${c.reason ? ` (${c.reason})` : ""}`;
            })
            .join("\n");
        },
      },
    ];
  }
}
