import { z } from "zod";
import type { StorageDriver } from "../storage/driver.js";
import { InMemoryStorage } from "../storage/in-memory.js";
import { defineTool } from "../tools/define-tool.js";
import type { ToolDef } from "../tools/types.js";

export type FileMemoryTarget = "memory" | "user";

export interface FileMemoryConfig {
  storage?: StorageDriver;
  memoryCharLimit?: number;
  userCharLimit?: number;
}

const DEFAULT_MEMORY_LIMIT = 2200;
const DEFAULT_USER_LIMIT = 1375;
const NS = "file-memory";

interface Store {
  entries: string[];
}

/**
 * Tiny always-on memory files (MEMORY.md / USER.md).
 * Hard character caps — overflow returns an error so the agent must consolidate.
 */
export class FileMemory {
  private storage: StorageDriver;
  private memoryLimit: number;
  private userLimit: number;

  constructor(config: FileMemoryConfig = {}) {
    this.storage = config.storage ?? new InMemoryStorage();
    this.memoryLimit = config.memoryCharLimit ?? DEFAULT_MEMORY_LIMIT;
    this.userLimit = config.userCharLimit ?? DEFAULT_USER_LIMIT;
  }

  private key(target: FileMemoryTarget, owner: string): string {
    return `${target}:${owner}`;
  }

  private limit(target: FileMemoryTarget): number {
    return target === "user" ? this.userLimit : this.memoryLimit;
  }

  async getEntries(target: FileMemoryTarget, owner: string): Promise<string[]> {
    const store = await this.storage.get<Store>(NS, this.key(target, owner));
    return store?.entries ?? [];
  }

  async add(
    target: FileMemoryTarget,
    owner: string,
    content: string,
  ): Promise<{ ok: true } | { ok: false; error: string; usage: string; current_entries: string[] }> {
    const entries = await this.getEntries(target, owner);
    if (entries.some((e) => e === content)) {
      return { ok: true };
    }
    const used = entries.join("").length;
    const limit = this.limit(target);
    if (used + content.length > limit) {
      return {
        ok: false,
        error: `Memory at ${used}/${limit} chars. Adding this entry (${content.length} chars) would exceed the limit. Consolidate with replace/remove, then retry.`,
        usage: `${used}/${limit}`,
        current_entries: entries,
      };
    }
    entries.push(content);
    await this.storage.set(NS, this.key(target, owner), { entries });
    return { ok: true };
  }

  async replace(
    target: FileMemoryTarget,
    owner: string,
    oldText: string,
    content: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const entries = await this.getEntries(target, owner);
    const matches = entries.filter((e) => e.includes(oldText));
    if (matches.length === 0) return { ok: false, error: "No entry matched old_text." };
    if (matches.length > 1) return { ok: false, error: "old_text matched multiple entries. Be more specific." };
    const next = entries.map((e) => (e.includes(oldText) ? content : e));
    const used = next.join("").length;
    const limit = this.limit(target);
    if (used > limit) {
      return {
        ok: false,
        error: `Replace would exceed the ${limit} char limit (${used} chars). Shorten the new entry.`,
      };
    }
    await this.storage.set(NS, this.key(target, owner), { entries: next });
    return { ok: true };
  }

  async remove(
    target: FileMemoryTarget,
    owner: string,
    oldText: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const entries = await this.getEntries(target, owner);
    const matches = entries.filter((e) => e.includes(oldText));
    if (matches.length === 0) return { ok: false, error: "No entry matched old_text." };
    if (matches.length > 1) return { ok: false, error: "old_text matched multiple entries. Be more specific." };
    const next = entries.filter((e) => !e.includes(oldText));
    await this.storage.set(NS, this.key(target, owner), { entries: next });
    return { ok: true };
  }

  async getContextString(owner: { userId?: string; agentName: string }): Promise<string> {
    const memoryOwner = owner.agentName;
    const userOwner = owner.userId ?? owner.agentName;
    const memory = await this.getEntries("memory", memoryOwner);
    const user = await this.getEntries("user", userOwner);
    const parts: string[] = [];
    if (memory.length) {
      const used = memory.join("").length;
      parts.push(
        `MEMORY (your notes) [${Math.round((used / this.memoryLimit) * 100)}% — ${used}/${this.memoryLimit} chars]\n${memory.join("\n§ ")}`,
      );
    }
    if (user.length) {
      const used = user.join("").length;
      parts.push(
        `USER PROFILE [${Math.round((used / this.userLimit) * 100)}% — ${used}/${this.userLimit} chars]\n${user.join("\n§ ")}`,
      );
    }
    return parts.join("\n\n");
  }

  getTools(): ToolDef[] {
    return [
      defineTool({
        name: "memory",
        description:
          "Save a short standing fact. target=memory is environment/project notes; target=user is the person's preferences. Entries have a hard character cap — consolidate when full.",
        parameters: z.object({
          action: z.enum(["add", "replace", "remove"]),
          target: z.enum(["memory", "user"]).default("memory"),
          content: z.string().optional().describe("New text for add/replace"),
          old_text: z.string().optional().describe("Unique substring identifying the entry to replace/remove"),
        }),
        execute: async ({ action, target, content, old_text }, ctx) => {
          const owner = target === "user" ? (ctx.userId ?? "anon") : String(ctx.metadata.agentName ?? "agent");
          if (action === "add") {
            if (!content) return "content is required for add";
            const result = await this.add(target, owner, content);
            return result.ok ? "Saved." : JSON.stringify(result);
          }
          if (action === "replace") {
            if (!old_text || !content) return "old_text and content are required for replace";
            const result = await this.replace(target, owner, old_text, content);
            return result.ok ? "Replaced." : result.error;
          }
          if (!old_text) return "old_text is required for remove";
          const result = await this.remove(target, owner, old_text);
          return result.ok ? "Removed." : result.error;
        },
      }),
    ];
  }
}
