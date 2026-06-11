import type { ModelProvider } from "../models/provider.js";
import type { StorageDriver } from "../storage/driver.js";
import type { CorrectionStore } from "./stores/correction-store.js";
import type { DecisionLog } from "./stores/decision-log.js";
import type { EntityMemory } from "./stores/entity-memory.js";
import type { LearnedKnowledge } from "./stores/learned-knowledge.js";
import type { UserFacts } from "./stores/user-facts.js";
import type { UserProfile } from "./stores/user-profile.js";

export interface CuratorStores {
  userFacts?: UserFacts | null;
  userProfile?: UserProfile | null;
  entityMemory?: EntityMemory | null;
  decisionLog?: DecisionLog | null;
  learnedKnowledge?: LearnedKnowledge | null;
  correctionStore?: CorrectionStore | null;
}

export interface PruneOptions {
  maxAgeDays: number;
  userId?: string;
  agentName?: string;
}

export interface ConsolidateOptions {
  userId: string;
  model: ModelProvider;
  similarityThreshold?: number;
}

const CONSOLIDATION_PROMPT = `You are a memory consolidation assistant. Given a list of user facts, identify groups of facts that are semantically similar, redundant, or can be merged into a single authoritative fact.

Rules:
- Group facts that say essentially the same thing in different ways
- Merge each group into one concise, authoritative fact
- Keep the most specific/recent information when merging
- If facts are genuinely distinct, do not merge them
- Return ONLY a JSON array of merge operations

Facts:
{facts}

Return ONLY a JSON array: [{"merged": "the consolidated fact", "originalIds": ["id1", "id2"]}]
If nothing to merge, return [].`;

export class Curator {
  private storage: StorageDriver;
  private stores: CuratorStores;

  constructor(storage: StorageDriver, stores: CuratorStores) {
    this.storage = storage;
    this.stores = stores;
  }

  /**
   * Repair dual-write drift across the vector-backed stores (learnings,
   * corrections). KV records missing from the vector index — e.g. after a
   * crash between the two writes — are re-embedded and re-indexed.
   *
   * Run periodically (e.g. on a schedule alongside prune/consolidate).
   * Returns the number of repaired records per store.
   */
  async reconcile(): Promise<{ learnings: number; corrections: number }> {
    const result = { learnings: 0, corrections: 0 };
    if (this.stores.learnedKnowledge) {
      result.learnings = await this.stores.learnedKnowledge.reconcile();
    }
    if (this.stores.correctionStore) {
      result.corrections = await this.stores.correctionStore.reconcile();
    }
    return result;
  }

  /**
   * Remove entries older than `maxAgeDays` from all enabled stores.
   * Returns the total number of entries pruned.
   */
  async prune(options: PruneOptions): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - options.maxAgeDays);
    let pruned = 0;

    if (this.stores.userFacts && options.userId) {
      const facts = await this.stores.userFacts.getFacts(options.userId);
      const old = facts.filter((f) => new Date(f.createdAt) < cutoff);
      for (const fact of old) {
        await this.stores.userFacts.removeFact(options.userId, fact.id);
        pruned++;
      }
    }

    if (this.stores.decisionLog && options.agentName) {
      const decisions = await this.stores.decisionLog.getDecisions(options.agentName);
      const old = decisions.filter((d) => new Date(d.createdAt) < cutoff);
      for (const decision of old) {
        await this.storage.delete("memory:decisions", `${options.agentName}:${decision.id}`);
        pruned++;
      }
    }

    return pruned;
  }

  /**
   * Remove duplicate facts for a user by comparing normalized text.
   * Returns the number of duplicates removed.
   */
  async deduplicate(options: { userId: string }): Promise<number> {
    if (!this.stores.userFacts) return 0;

    const facts = await this.stores.userFacts.getFacts(options.userId);
    const seen = new Set<string>();
    const dupes: string[] = [];

    for (const fact of facts) {
      const normalized = fact.fact.toLowerCase().trim();
      if (seen.has(normalized)) {
        dupes.push(fact.id);
      } else {
        seen.add(normalized);
      }
    }

    for (const id of dupes) {
      await this.stores.userFacts.removeFact(options.userId, id);
    }

    return dupes.length;
  }

  /**
   * Use an LLM to identify and merge semantically similar facts for a user.
   * Goes beyond exact-text dedup: "Likes dark mode" + "Prefers dark themes" → single fact.
   * Returns the number of facts merged.
   */
  async consolidate(options: ConsolidateOptions): Promise<number> {
    if (!this.stores.userFacts) return 0;

    const facts = await this.stores.userFacts.getActiveFacts(options.userId);
    if (facts.length < 2) return 0;

    try {
      const factsStr = facts.map((f) => `[${f.id}] ${f.fact}`).join("\n");
      const prompt = CONSOLIDATION_PROMPT.replace("{facts}", factsStr);

      const response = await options.model.generate([{ role: "user", content: prompt }], {
        temperature: 0,
        maxTokens: 800,
      });

      const text = typeof response.message.content === "string" ? response.message.content : "";
      if (!text) return 0;

      const jsonStr = extractJsonArray(text);
      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) return 0;

      let mergedCount = 0;
      for (const merge of parsed) {
        if (!merge?.merged || !Array.isArray(merge.originalIds) || merge.originalIds.length < 2) continue;

        for (const oldId of merge.originalIds) {
          await this.stores.userFacts.removeFact(options.userId, oldId);
        }

        await this.stores.userFacts.addFacts(options.userId, [{ fact: merge.merged, topics: [] }], "auto");
        mergedCount += merge.originalIds.length - 1;
      }

      return mergedCount;
    } catch (err) {
      console.warn("[Curator] consolidate failed:", (err as Error).message ?? err);
      return 0;
    }
  }

  /**
   * Clear all memory data for a specific user and/or agent.
   */
  async clearAll(options: { userId?: string; agentName?: string }): Promise<void> {
    if (options.userId) {
      if (this.stores.userFacts) await this.stores.userFacts.clear(options.userId);
      if (this.stores.userProfile) await this.stores.userProfile.clear(options.userId);
      // Only this user's entities — never wipe everyone's (#30 in audit).
      if (this.stores.entityMemory) await this.stores.entityMemory.clear(options.userId);
    }
    if (options.agentName && this.stores.decisionLog) {
      await this.stores.decisionLog.clear(options.agentName);
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
