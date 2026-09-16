import { z } from "zod";
import type { StorageDriver } from "../storage/driver.js";
import { InMemoryStorage } from "../storage/in-memory.js";
import { defineTool } from "../tools/define-tool.js";
import type { ToolDef } from "../tools/types.js";

export interface AgentFile {
  path: string;
  content: string;
  updatedAt: number;
  version: number;
}

export interface AgentFileSystemConfig {
  storage?: StorageDriver;
  /** Namespace prefix. `{userId}` / `{agentId}` / `{sessionId}` are substituted. Default: `fs/{agentId}/{userId}` */
  namespace?: string;
  maxFileBytes?: number;
  maxNamespaceBytes?: number;
}

const DEFAULT_MAX_FILE = 1_000_000;
const DEFAULT_MAX_NS = 20_000_000;

/**
 * Durable text store for notes the agent writes for its future self.
 * Not the host disk — that is FileSystemToolkit / workspace tools.
 */
export class AgentFileSystem {
  private storage: StorageDriver;
  private namespaceTemplate: string;
  private maxFileBytes: number;
  private maxNamespaceBytes: number;

  constructor(config: AgentFileSystemConfig = {}) {
    this.storage = config.storage ?? new InMemoryStorage();
    this.namespaceTemplate = config.namespace ?? "fs/{agentId}/{userId}";
    this.maxFileBytes = config.maxFileBytes ?? DEFAULT_MAX_FILE;
    this.maxNamespaceBytes = config.maxNamespaceBytes ?? DEFAULT_MAX_NS;
  }

  resolveNamespace(ctx: { userId?: string; agentId?: string; sessionId?: string }): string {
    const ns = this.namespaceTemplate
      .replaceAll("{userId}", ctx.userId || "anon")
      .replaceAll("{agentId}", ctx.agentId || "agent")
      .replaceAll("{sessionId}", ctx.sessionId || "session");
    if (ns.includes("..") || ns.startsWith("/")) {
      throw new Error("Invalid filesystem namespace");
    }
    return ns;
  }

  private ns(ctx: { userId?: string; agentId?: string; sessionId?: string }): string {
    return `agentfs:${this.resolveNamespace(ctx)}`;
  }

  private normalizePath(path: string): string {
    const p = path.replace(/^\/+/, "").replace(/\\/g, "/");
    if (!p || p.includes("..") || p.includes("\0")) throw new Error(`Invalid path: ${path}`);
    return p;
  }

  async writeFile(
    path: string,
    content: string,
    ctx: { userId?: string; agentId?: string; sessionId?: string },
    expectedVersion?: number,
  ): Promise<AgentFile> {
    const key = this.normalizePath(path);
    if (Buffer.byteLength(content, "utf8") > this.maxFileBytes) {
      throw new Error(`File exceeds maxFileBytes (${this.maxFileBytes})`);
    }
    const ns = this.ns(ctx);
    const existing = await this.storage.get<AgentFile>(ns, key);
    if (expectedVersion !== undefined && (existing?.version ?? 0) !== expectedVersion) {
      throw new Error(`Version mismatch for ${key}: expected ${expectedVersion}, found ${existing?.version ?? 0}`);
    }
    const usage = await this.namespaceBytes(ctx);
    const nextSize = Buffer.byteLength(content, "utf8");
    const prevSize = existing ? Buffer.byteLength(existing.content, "utf8") : 0;
    if (usage - prevSize + nextSize > this.maxNamespaceBytes) {
      throw new Error(`Namespace exceeds maxNamespaceBytes (${this.maxNamespaceBytes})`);
    }
    const file: AgentFile = {
      path: key,
      content,
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
    };
    await this.storage.set(ns, key, file);
    return file;
  }

  async readFile(
    path: string,
    ctx: { userId?: string; agentId?: string; sessionId?: string },
  ): Promise<AgentFile | null> {
    const key = this.normalizePath(path);
    return this.storage.get<AgentFile>(this.ns(ctx), key);
  }

  async listFiles(ctx: { userId?: string; agentId?: string; sessionId?: string }): Promise<string[]> {
    const entries = await this.storage.list<AgentFile>(this.ns(ctx));
    return entries.map((e) => e.value.path).sort();
  }

  async searchContent(
    query: string,
    ctx: { userId?: string; agentId?: string; sessionId?: string },
  ): Promise<Array<{ path: string; snippet: string }>> {
    const q = query.toLowerCase();
    const entries = await this.storage.list<AgentFile>(this.ns(ctx));
    const hits: Array<{ path: string; snippet: string }> = [];
    for (const { value } of entries) {
      const idx = value.content.toLowerCase().indexOf(q);
      if (idx === -1) continue;
      const start = Math.max(0, idx - 40);
      hits.push({ path: value.path, snippet: value.content.slice(start, start + 120) });
    }
    return hits;
  }

  async deleteFile(path: string, ctx: { userId?: string; agentId?: string; sessionId?: string }): Promise<boolean> {
    const key = this.normalizePath(path);
    const existing = await this.storage.get<AgentFile>(this.ns(ctx), key);
    if (!existing) return false;
    await this.storage.delete(this.ns(ctx), key);
    return true;
  }

  private async namespaceBytes(ctx: { userId?: string; agentId?: string; sessionId?: string }): Promise<number> {
    const entries = await this.storage.list<AgentFile>(this.ns(ctx));
    return entries.reduce((sum, e) => sum + Buffer.byteLength(e.value.content, "utf8"), 0);
  }

  getTools(): ToolDef[] {
    const ctxOf = (run: { userId?: string; metadata: Record<string, unknown>; sessionId: string }) => ({
      userId: run.userId,
      agentId: typeof run.metadata.agentName === "string" ? run.metadata.agentName : undefined,
      sessionId: run.sessionId,
    });

    return [
      defineTool({
        name: "agent_fs_write",
        description: "Write a durable note for your future self (not the host disk).",
        parameters: z.object({
          path: z.string(),
          content: z.string(),
        }),
        execute: async ({ path, content }, ctx) => {
          const file = await this.writeFile(path, content, ctxOf(ctx));
          return `Wrote ${file.path} (v${file.version})`;
        },
      }),
      defineTool({
        name: "agent_fs_read",
        description: "Read a durable note you previously wrote.",
        parameters: z.object({ path: z.string() }),
        execute: async ({ path }, ctx) => {
          const file = await this.readFile(path, ctxOf(ctx));
          return file ? file.content : `Not found: ${path}`;
        },
      }),
      defineTool({
        name: "agent_fs_list",
        description: "List durable notes in your filesystem.",
        parameters: z.object({}),
        execute: async (_args, ctx) => {
          const files = await this.listFiles(ctxOf(ctx));
          return files.length ? files.join("\n") : "(empty)";
        },
      }),
      defineTool({
        name: "agent_fs_search",
        description: "Search durable notes by substring.",
        parameters: z.object({ query: z.string() }),
        execute: async ({ query }, ctx) => {
          const hits = await this.searchContent(query, ctxOf(ctx));
          if (hits.length === 0) return "No matches.";
          return hits.map((h) => `${h.path}: ${h.snippet}`).join("\n");
        },
      }),
    ];
  }
}
