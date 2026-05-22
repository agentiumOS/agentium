import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunContext } from "../agent/run-context.js";
import { assertHostAllowed, safeJoin } from "../utils/path-safety.js";

/**
 * `ContextProvider` is a pre-fetched data source attached to an Agent.
 *
 * Unlike Tools (which the LLM explicitly invokes), context providers run
 * automatically before every turn and inject their output into the system
 * prompt. Good for "the agent should always know X" data: my calendar, recent
 * Slack messages, current SQL row counts, file contents the agent referenced.
 *
 * Typical usage:
 *
 * ```ts
 * const calendar = new FilesystemContextProvider({ basePath: "./notes", glob: "*.md" });
 * const agent = new Agent({ context: [calendar], ... });
 * ```
 */
export interface ContextProvider {
  readonly name: string;
  /**
   * Fetch the current context. Called once per agent run before the LLM is invoked.
   * Returning an empty string causes the provider to contribute nothing.
   */
  fetchContext(query: string, ctx: RunContext): Promise<string>;
}

// ── Filesystem provider ────────────────────────────────────────────────────

export interface FilesystemContextProviderConfig {
  /** Base directory all paths are read from. */
  basePath: string;
  /** Files to include (relative paths, optionally with `**` wildcards expanded by `glob`). */
  files?: string[];
  /** Optional glob pattern (uses `node:fs.glob` when available). */
  glob?: string;
  /** Per-file character cap. Default 4000. */
  maxCharsPerFile?: number;
  /** Overall character cap. Default 16000. */
  maxTotalChars?: number;
}

async function listFiles(basePath: string, glob?: string, files?: string[]): Promise<string[]> {
  if (files && files.length > 0) return files;
  if (!glob) return [];
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(basePath, { withFileTypes: true });
    const wildcard = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    const re = new RegExp(`^${wildcard}$`);
    return entries.filter((e) => e.isFile() && re.test(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
}

export class FilesystemContextProvider implements ContextProvider {
  readonly name = "filesystem";
  constructor(private readonly cfg: FilesystemContextProviderConfig) {}

  async fetchContext(_query: string, _ctx: RunContext): Promise<string> {
    const files = await listFiles(this.cfg.basePath, this.cfg.glob, this.cfg.files);
    const maxPer = this.cfg.maxCharsPerFile ?? 4000;
    const maxTotal = this.cfg.maxTotalChars ?? 16_000;
    let total = 0;
    const chunks: string[] = [];
    for (const rel of files) {
      try {
        const full = safeJoin(this.cfg.basePath, rel);
        const body = await readFile(full, "utf8");
        const slice = body.length > maxPer ? `${body.slice(0, maxPer)}...(truncated)` : body;
        if (total + slice.length > maxTotal) break;
        total += slice.length;
        chunks.push(`### ${rel}\n${slice}`);
      } catch {
        // skip unreadable files
      }
    }
    return chunks.join("\n\n");
  }
}

// ── HTTP fetch provider ────────────────────────────────────────────────────

export interface HttpContextProviderConfig {
  url: string;
  /** Headers forwarded with the fetch. */
  headers?: Record<string, string>;
  /** Optional SSRF allowlist. */
  allowedHosts?: string[];
  /** Optional response transformer. */
  transform?: (rawBody: string) => string;
  /** Char cap. */
  maxChars?: number;
}

export class HttpContextProvider implements ContextProvider {
  readonly name = "http";
  constructor(private readonly cfg: HttpContextProviderConfig) {}

  async fetchContext(_query: string, _ctx: RunContext): Promise<string> {
    assertHostAllowed(this.cfg.url, this.cfg.allowedHosts);
    const res = await fetch(this.cfg.url, { headers: this.cfg.headers });
    if (!res.ok) return `[HTTP fetch failed: ${res.status}]`;
    const body = await res.text();
    const transformed = this.cfg.transform ? this.cfg.transform(body) : body;
    const max = this.cfg.maxChars ?? 8000;
    return transformed.length > max ? `${transformed.slice(0, max)}...(truncated)` : transformed;
  }
}

// ── SQL / database provider ────────────────────────────────────────────────

export interface DatabaseContextProviderConfig {
  /**
   * Function called on every run to produce the context string. The agent's
   * `RunContext` is passed in so you can scope queries to the current user/tenant.
   */
  fetch: (ctx: RunContext) => Promise<string>;
  /** Provider name for logs (e.g. `"postgres-users"`). */
  label?: string;
}

export class DatabaseContextProvider implements ContextProvider {
  readonly name: string;
  constructor(private readonly cfg: DatabaseContextProviderConfig) {
    this.name = cfg.label ?? "database";
  }
  fetchContext(_query: string, ctx: RunContext): Promise<string> {
    return this.cfg.fetch(ctx);
  }
}

// ── Helper: composite ──────────────────────────────────────────────────────

/**
 * Resolve all configured providers in parallel, label each block, and join
 * them into a single context string suitable for the system prompt.
 */
export async function resolveContextProviders(
  providers: ContextProvider[],
  query: string,
  ctx: RunContext,
): Promise<string> {
  const rendered = await Promise.all(
    providers.map(async (p) => {
      try {
        const out = await p.fetchContext(query, ctx);
        if (!out) return "";
        return `## Context: ${p.name}\n${out}`;
      } catch (err: any) {
        return `## Context: ${p.name} (error)\n${err?.message ?? err}`;
      }
    }),
  );
  return rendered.filter(Boolean).join("\n\n");
}

// Re-export safeJoin so docs examples can show one import.
export { safeJoin };

// Resolve unused import warning for join (intentional — kept for future paths support)
void join;
