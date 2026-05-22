import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import { defineTool } from "./define-tool.js";
import type { ToolDef, ToolResult } from "./types.js";

/**
 * Async HandleId Pattern.
 *
 * Long-running tools (slow APIs, video processing, batch jobs) return a handle
 * synchronously while their real work runs in the background. The agent can
 * later poll for the result with the auto-injected `pollResult(handle)` tool
 * instead of blocking the entire run.
 *
 * @example
 * ```ts
 * const scrapePage = defineAsyncTool({
 *   name: "scrapePage",
 *   description: "Fetch + parse a webpage. Returns a handle; poll for result.",
 *   parameters: z.object({ url: z.string() }),
 *   execute: async ({ url }) => {
 *     const html = await fetch(url).then((r) => r.text());
 *     return JSON.stringify({ html: html.slice(0, 5000) });
 *   },
 * });
 * agent = new Agent({ tools: [scrapePage, ...createPollResultTool()] });
 * ```
 */

interface HandleEntry {
  status: "pending" | "resolved" | "rejected";
  value?: unknown;
  error?: string;
  startedAt: number;
  ttlMs: number;
}

const HANDLES_KEY = "__asyncHandles";

function getHandles(ctx: RunContext): Map<string, HandleEntry> {
  let m = ctx.getState<Map<string, HandleEntry>>(HANDLES_KEY);
  if (!m) {
    m = new Map();
    ctx.setState(HANDLES_KEY, m);
  }
  return m;
}

export interface DefineAsyncToolConfig<T extends z.ZodObject<any>> {
  name: string;
  description: string;
  parameters: T;
  /** The long-running implementation. Runs in the background. */
  execute: (args: z.infer<T>, ctx: RunContext) => Promise<string | ToolResult>;
  /** TTL for the cached result in seconds. Default 600 (10 minutes). */
  ttlSeconds?: number;
}

/**
 * Wrap a long-running execute function in the async-handle pattern.
 * The returned tool fires the work in the background and returns
 * `{ handle: "ah:..." }` immediately.
 */
export function defineAsyncTool<T extends z.ZodObject<any>>(config: DefineAsyncToolConfig<T>): ToolDef {
  const ttlMs = (config.ttlSeconds ?? 600) * 1000;

  return defineTool({
    name: config.name,
    description:
      `${config.description}\n\n[Async] Returns a handle ("ah:..."). ` +
      "Call pollResult(handle) to retrieve the actual result when it's ready.",
    parameters: config.parameters,
    execute: async (args, ctx) => {
      const id = `ah:${uuidv4()}`;
      const entry: HandleEntry = { status: "pending", startedAt: Date.now(), ttlMs };
      getHandles(ctx).set(id, entry);

      // Fire-and-forget; result is captured into the handle entry.
      (async () => {
        try {
          const value = await config.execute(args as z.infer<T>, ctx);
          entry.status = "resolved";
          entry.value = value;
        } catch (err: any) {
          entry.status = "rejected";
          entry.error = err?.message ?? String(err);
        }
      })();

      return JSON.stringify({
        handle: id,
        status: "pending",
        note: "Call pollResult with this handle (and optionally waitMs to wait until ready) to retrieve the result.",
      });
    },
  });
}

/**
 * Returns the `pollResult` companion tool that retrieves results from
 * `defineAsyncTool` handles. Add this once to your agent's tool list.
 */
export function createPollResultTool(): ToolDef {
  return defineTool({
    name: "pollResult",
    description:
      "Retrieve the result of an async tool by its handle. Returns status=pending if not ready yet. " +
      "Pass waitMs > 0 to wait up to that many milliseconds for completion (max 30000).",
    parameters: z.object({
      handle: z.string().describe("The handle previously returned by an async tool"),
      waitMs: z.number().optional().describe("How long to wait for completion (default 0)"),
    }),
    execute: async ({ handle, waitMs }, ctx) => {
      const handles = getHandles(ctx);
      const entry = handles.get(handle);
      if (!entry) return JSON.stringify({ status: "not-found", handle });

      const wait = Math.min(Math.max(0, waitMs ?? 0), 30_000);
      const deadline = Date.now() + wait;
      while (entry.status === "pending" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }

      // Expire after TTL even if it eventually resolved.
      if (Date.now() - entry.startedAt > entry.ttlMs) {
        handles.delete(handle);
        return JSON.stringify({ status: "expired", handle });
      }

      if (entry.status === "pending") return JSON.stringify({ status: "pending", handle });
      if (entry.status === "rejected") return JSON.stringify({ status: "error", handle, error: entry.error });
      // resolved
      const v = entry.value;
      const content = typeof v === "string" ? v : (v as ToolResult).content;
      return JSON.stringify({ status: "done", handle, result: content });
    },
  });
}
