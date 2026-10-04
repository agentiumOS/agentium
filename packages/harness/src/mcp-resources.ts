import { RunCancelledError, RunContext } from "@agentium/core";
import { defineAbility } from "./definition.js";
import type { HarnessContextEntry } from "./runtime/types.js";

/** Structural port: both MCP SDK generations can supply a connected Client. */
export interface MCPResourceClient {
  readResource(
    params: { uri: string },
    options?: { signal?: AbortSignal; timeout?: number; cacheMode?: "bypass" },
  ): Promise<{ contents: readonly { uri: string; mimeType?: string; text?: string; blob?: string }[] }>;
}

export interface MCPResourceGrant {
  /** Exact server URI, never a local path or a URL fetched by the harness. */
  uri: string;
  /** Explicit text formats. A missing MIME is accepted only when listed as "". */
  mimeTypes: readonly string[];
}

export interface MCPResourcesOptions {
  id: string;
  /** Creates a principal-scoped connection for this binding. Authentication belongs to the host. */
  connect: (ctx: RunContext) => Promise<{ client: MCPResourceClient; dispose?: () => Promise<void> }>;
  /** Bounds setup even when the host connection factory ignores cancellation. Default 5000. */
  connectTimeoutMs?: number;
  resources: readonly MCPResourceGrant[];
  /** Rechecked before reading and before returning content, including on every subsequent fetch. */
  authorize: (grant: MCPResourceGrant, ctx: RunContext) => boolean | Promise<boolean>;
  /** Optional host selector, constrained to the declared grants. No server-wide discovery. */
  select?: (query: string, ctx: RunContext) => readonly string[] | Promise<readonly string[]>;
}

function valid(options: MCPResourcesOptions): MCPResourcesOptions {
  if (!options.id || typeof options.connect !== "function" || typeof options.authorize !== "function")
    throw new Error("MCP resources require an ID, connection factory and authorization callback");
  const seen = new Set<string>();
  if (
    options.connectTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.connectTimeoutMs) ||
      options.connectTimeoutMs <= 0 ||
      options.connectTimeoutMs > 120_000)
  )
    throw new Error("MCP resource connection timeout must be between 1 and 120000 ms");
  for (const grant of options.resources) {
    if (!/^[a-z][a-z\d+.-]*:/i.test(grant.uri) || seen.has(grant.uri) || !grant.mimeTypes.length)
      throw new Error("MCP resource grants require unique absolute URIs and explicit MIME types");
    if (grant.mimeTypes.some((mime) => typeof mime !== "string" || mime.includes("*")))
      throw new Error("MCP resource MIME types must be exact");
    seen.add(grant.uri);
  }
  return options;
}

/** Approved text resources become untrusted, provenance-labelled context, never tools or prompts. */
export const mcpResources = defineAbility<MCPResourcesOptions>({
  type: "agentium/mcp-resources",
  validate: valid,
  describe: () => ({ toolNames: [], requirements: [], runtimeDependent: true }),
  bind: async (options, owner) => {
    if (owner.signal?.aborted) throw new RunCancelledError();
    const lifetime = new AbortController();
    const setupSignal = AbortSignal.any([lifetime.signal, ...(owner.signal ? [owner.signal] : [])]);
    let setupTimer: ReturnType<typeof setTimeout> | undefined;
    let setupAbort: (() => void) | undefined;
    const pending = Promise.resolve().then(async () => {
      setupSignal.throwIfAborted();
      const connection = await options.connect(new RunContext({ ...owner, signal: setupSignal }));
      if (setupSignal.aborted) {
        void Promise.resolve()
          .then(() => connection.dispose?.())
          .catch(() => {});
        throw new RunCancelledError();
      }
      return connection;
    });
    let connection: Awaited<ReturnType<MCPResourcesOptions["connect"]>>;
    try {
      connection = await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          setupAbort = () => reject(new RunCancelledError());
          setupSignal.addEventListener("abort", setupAbort, { once: true });
          if (setupSignal.aborted) setupAbort();
          setupTimer = setTimeout(() => lifetime.abort(), options.connectTimeoutMs ?? 5000);
        }),
      ]);
    } finally {
      if (setupTimer) clearTimeout(setupTimer);
      if (setupAbort) setupSignal.removeEventListener("abort", setupAbort);
    }
    let disposed = false;
    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      await connection.dispose?.();
    };
    if (owner.signal?.aborted) {
      await dispose();
      throw new RunCancelledError();
    }
    const grants = new Map(options.resources.map((grant) => [grant.uri, grant]));
    return {
      tools: [],
      dispose,
      contextSources: [
        {
          id: options.id,
          fetch: async (query, ctx, budget) => {
            if (disposed) throw new Error("MCP resource binding is disposed");
            if (ctx.tenantId !== owner.tenantId || ctx.userId !== owner.userId || ctx.sessionId !== owner.sessionId)
              throw new Error("MCP resource binding belongs to another principal or session");
            for (const value of [budget.maxEntries, budget.maxBytes, budget.deadlineMs])
              if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid MCP resource budget");
            if (!budget.maxEntries || !budget.maxBytes || !budget.deadlineMs) return [];
            const abort = new AbortController();
            const signal = AbortSignal.any([
              abort.signal,
              lifetime.signal,
              ...(owner.signal ? [owner.signal] : []),
              ...(ctx.signal ? [ctx.signal] : []),
            ]);
            let timer: ReturnType<typeof setTimeout> | undefined;
            let stop: (() => void) | undefined;
            try {
              return await Promise.race([
                (async () => {
                  const check = () => {
                    if (signal.aborted) throw new RunCancelledError();
                  };
                  check();
                  const selected = options.select ? await options.select(query, ctx) : [...grants.keys()];
                  check();
                  if (new Set(selected).size !== selected.length || selected.some((uri) => !grants.has(uri)))
                    throw new Error("MCP resource selection exceeded the approved grants");
                  const entries: HarnessContextEntry[] = [];
                  let bytes = 0;
                  for (const uri of selected.slice(0, budget.maxEntries)) {
                    check();
                    if (entries.length >= budget.maxEntries) break;
                    const grant = grants.get(uri)!;
                    if (!(await options.authorize(grant, ctx))) throw new Error("MCP resource authorization denied");
                    check();
                    const result = await connection.client.readResource(
                      { uri },
                      {
                        signal,
                        timeout: budget.deadlineMs,
                        cacheMode: "bypass",
                      },
                    );
                    check();
                    if (!Array.isArray(result.contents)) throw new Error("Invalid MCP resource response");
                    for (const content of result.contents) {
                      if (content.uri !== uri || !grant.mimeTypes.includes(content.mimeType ?? ""))
                        throw new Error("MCP resource response exceeded its URI or MIME grant");
                      if (typeof content.text !== "string" || content.blob !== undefined)
                        throw new Error(
                          "MCP context resources must contain text; use an explicit host decoder for binary documents",
                        );
                      const length = Buffer.byteLength(content.text, "utf8");
                      bytes += length;
                      if (bytes > budget.maxBytes || entries.length >= budget.maxEntries)
                        throw new Error("MCP resource response exceeded its context budget");
                      entries.push({
                        id: `${options.id}:${entries.length}`,
                        text: content.text,
                        trust: "source",
                        source: { uri },
                        byteLength: length,
                      });
                    }
                  }
                  // No cache: grants may be revoked while any remote request is in flight.
                  for (const uri of new Set(entries.map((entry) => entry.source!.uri))) {
                    if (!(await options.authorize(grants.get(uri)!, ctx)))
                      throw new Error("MCP resource authorization revoked");
                    check();
                  }
                  return entries;
                })(),
                new Promise<never>((_resolve, reject) => {
                  stop = () => reject(new RunCancelledError());
                  signal.addEventListener("abort", stop, { once: true });
                  if (signal.aborted) stop();
                  timer = setTimeout(() => abort.abort(), budget.deadlineMs);
                }),
              ]);
            } finally {
              if (timer) clearTimeout(timer);
              if (stop) signal.removeEventListener("abort", stop);
              abort.abort();
            }
          },
        },
      ],
    };
  },
});
