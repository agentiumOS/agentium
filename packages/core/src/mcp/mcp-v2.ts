import { randomUUID } from "node:crypto";
import type { Client, ClientOptions, OAuthClientProvider, Transport } from "@modelcontextprotocol/client";
import { z } from "zod/v3";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef, ToolResult } from "../tools/types.js";
import { MCPTaskTransport } from "./task-transport.js";

const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
const objectResult = z.object({}).passthrough();
const taskResult = z
  .object({
    taskId: z.string().min(1),
    status: z.enum(["working", "input_required", "completed", "cancelled", "failed"]),
    createdAt: z.string().datetime({ offset: true }),
    lastUpdatedAt: z.string().datetime({ offset: true }),
    ttlMs: z.number().int().nonnegative().nullable(),
    pollIntervalMs: z.number().int().nonnegative().optional(),
    inputRequests: z.record(z.unknown()).optional(),
    result: objectResult.optional(),
    error: objectResult.optional(),
  })
  .passthrough();

type WireTask = z.infer<typeof taskResult>;
export interface MCPTaskSnapshot {
  handle: string;
  status: "running" | "input-required" | "completed" | "cancelled" | "failed";
  pollAfterMs?: number;
  inputRequests?: Record<string, unknown>;
  result?: ToolResult;
  error?: Record<string, unknown>;
  /** Cancellation acknowledgement is not proof that remote work stopped. */
  cancellationRequested?: boolean;
}

/** Persist in host-owned storage, never in model/tool output. Contains no credentials or task payload. */
export interface MCPPersistedTaskReference {
  version: 1;
  providerName: string;
  endpoint: string;
  taskId: string;
  identity: { tenantId: string; userId: string; sessionId: string };
}

export interface MCPV2ToolProviderConfig {
  name: string;
  transport: "stdio" | "http" | "custom";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** An explicit expected resource URL when sending credentials. */
  audience?: string;
  authProvider?: OAuthClientProvider;
  /** A fresh transport for each connection. The provider owns and closes it. */
  transportFactory?: () => Transport | Promise<Transport>;
  /** Defaults to pinned 2026-07-28. Use auto for an explicit fallback policy. */
  versionNegotiation?: ClientOptions["versionNegotiation"];
  requestTimeoutMs?: number;
  inputRequired?: ClientOptions["inputRequired"];
  /** Modern Tasks extension, negotiated before any task can be accepted. */
  tasks?: boolean;
  maxTaskHandles?: number;
  onToolsChanged?: (tools: readonly ToolDef[], error?: Error) => void;
  /** Host-installed SDK elicitation handlers; no automatic user approval is supplied. */
  configureClient?: (client: Client) => void;
}

/** Preserves the complete result, including resources, structured content and metadata. */
export function mapMCPResult(result: Record<string, unknown>): ToolResult {
  const blocks = Array.isArray(result.content) ? (result.content as Array<Record<string, unknown>>) : [];
  const content = blocks
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("\n");
  return {
    content: content || JSON.stringify(result.structuredContent ?? blocks),
    artifacts: [{ type: "mcp-result", data: result }],
  };
}

export class MCPToolError extends Error {
  constructor(readonly result: ToolResult) {
    super(result.content || "MCP tool returned an error");
    this.name = "MCPToolError";
  }
}

interface TaskEntry {
  remote: WireTask;
  owner: string;
  answered: Set<string>;
  cancellationRequested?: boolean;
}

/** Explicit SDK v2 adapter. Construction/root import performs no connection or SDK loading. */
export class MCPV2ToolProvider {
  readonly name: string;
  private client?: Client;
  private connecting?: Promise<void>;
  private pendingClient?: Client;
  private generation = 0;
  private readonly config: MCPV2ToolProviderConfig;
  private taskTransport?: MCPTaskTransport;
  private tools: ToolDef[] = [];
  private handles = new Map<string, TaskEntry>();
  private taskReservations = 0;

  constructor(config: MCPV2ToolProviderConfig) {
    this.config = {
      ...config,
      headers: { ...config.headers },
      args: config.args?.slice(),
      env: { ...config.env },
      versionNegotiation: config.versionNegotiation ? structuredClone(config.versionNegotiation) : undefined,
    };
    if (
      config.requestTimeoutMs !== undefined &&
      (!Number.isFinite(config.requestTimeoutMs) || config.requestTimeoutMs <= 0)
    )
      throw new Error("requestTimeoutMs must be positive");
    if (!config.name || !/^[a-zA-Z0-9_-]+$/.test(config.name))
      throw new Error("MCP provider name must use letters, digits, _ or -");
    if (
      config.maxTaskHandles !== undefined &&
      (!Number.isSafeInteger(config.maxTaskHandles) || config.maxTaskHandles < 1)
    ) {
      throw new Error("maxTaskHandles must be a positive integer");
    }
    this.name = config.name;
    if (config.transport === "http") {
      if (!config.url) throw new Error("MCP HTTP transport requires url");
      const url = new URL(config.url);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
        throw new Error("Invalid MCP endpoint URL");
      const credentials =
        !!config.authProvider || Object.keys(config.headers ?? {}).some((key) => /^(authorization|cookie)$/i.test(key));
      if (credentials && (!config.audience || new URL(config.audience).href !== url.href)) {
        throw new Error("Credentialed MCP connections require audience matching the exact endpoint URL");
      }
    }
  }

  async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.client) return;
    const operation = this.open(this.generation).finally(() => {
      if (this.connecting === operation) this.connecting = undefined;
    });
    this.connecting = operation;
    return operation;
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.generation) throw new Error("MCP connection closed during initialization");
  }

  private async open(generation: number): Promise<void> {
    const sdk = await import("@modelcontextprotocol/client");
    this.assertGeneration(generation);
    const client = new sdk.Client(
      { name: `agentium-${this.name}`, version: "3.2.0" },
      {
        capabilities: this.config.tasks ? { extensions: { [TASKS_EXTENSION]: {} } } : {},
        versionNegotiation: this.config.versionNegotiation ?? { mode: { pin: "2026-07-28" } },
        inputRequired: this.config.inputRequired ?? { autoFulfill: false },
        listChanged: {
          tools: {
            debounceMs: 0,
            onChanged: (error, tools) => {
              if (generation !== this.generation || this.client !== client) return;
              if (error) {
                this.config.onToolsChanged?.(this.tools, error);
                return;
              }
              if (tools) {
                this.tools = this.mapTools(tools);
                this.config.onToolsChanged?.(this.tools);
              }
            },
          },
        },
      },
    );
    this.pendingClient = client;
    let transport: Transport | undefined;
    try {
      this.config.configureClient?.(client);
      if (this.config.transport === "custom") {
        if (!this.config.transportFactory) throw new Error("Custom MCP transport requires transportFactory");
        transport = await this.config.transportFactory();
      } else if (this.config.transport === "stdio") {
        if (!this.config.command) throw new Error("MCP stdio transport requires command");
        const { StdioClientTransport } = await import("@modelcontextprotocol/client/stdio");
        transport = new StdioClientTransport({
          command: this.config.command,
          args: this.config.args,
          env: { ...process.env, ...this.config.env } as Record<string, string>,
        });
      } else {
        const endpoint = new URL(this.config.url!);
        transport = new sdk.StreamableHTTPClientTransport(endpoint, {
          requestInit: { headers: this.config.headers, redirect: "error" },
          authProvider: this.config.authProvider,
          // Never forward endpoint credentials to a redirect or a foreign URL.
          fetch: async (input, init) => {
            const target = new URL(input instanceof Request ? input.url : String(input));
            if (target.origin !== endpoint.origin) throw new Error("MCP cross-origin request denied");
            const headers = new Headers(init?.headers);
            if (typeof init?.body === "string") {
              const body = JSON.parse(init.body);
              if (
                ["tasks/get", "tasks/update", "tasks/cancel"].includes(body.method) &&
                typeof body.params?.taskId === "string"
              ) {
                headers.set("Mcp-Name", encodeURIComponent(body.params.taskId));
                headers.set("Mcp-Method", body.method);
              }
            }
            return fetch(input, { ...init, headers, redirect: "error" });
          },
        });
      }
      this.assertGeneration(generation);
      if (this.config.tasks) transport = this.taskTransport = new MCPTaskTransport(transport);
      await client.connect(transport);
      if (
        this.config.tasks &&
        (client.getProtocolEra() !== "modern" || !client.getServerCapabilities()?.extensions?.[TASKS_EXTENSION])
      ) {
        throw new Error("MCP server did not negotiate the modern Tasks extension");
      }
      const tools = this.mapTools((await client.listTools()).tools);
      this.assertGeneration(generation);
      this.client = client;
      this.tools = tools;
    } catch (error) {
      if (this.client === client) this.client = undefined;
      await client.close().catch(() => {});
      await transport?.close().catch(() => {});
      throw error;
    } finally {
      if (this.pendingClient === client) this.pendingClient = undefined;
    }
  }

  get protocolVersion(): string | undefined {
    return this.client?.getNegotiatedProtocolVersion();
  }

  private mapTools(
    tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>,
  ): ToolDef[] {
    const names = new Set<string>();
    return tools.map((tool) => {
      if (names.has(tool.name)) throw new Error(`Duplicate MCP tool: ${tool.name}`);
      names.add(tool.name);
      return {
        name: `${this.name}__${tool.name}`,
        description: `[${this.name}] ${tool.description ?? ""}`,
        // The authoritative schema is preserved. The remote server validates its full vocabulary.
        parameters: z.object({}).passthrough(),
        rawJsonSchema: tool.inputSchema,
        execute: async (args, ctx) => {
          ctx.signal?.throwIfAborted();
          await this.connect();
          ctx.signal?.throwIfAborted();
          const generation = this.generation;
          this.pruneTasks();
          if (this.config.tasks && this.handles.size + this.taskReservations >= (this.config.maxTaskHandles ?? 1000))
            throw new Error("MCP task handle capacity reached");
          if (this.config.tasks) this.taskReservations++;
          const result = await (async () => {
            try {
              return this.config.tasks
                ? await this.rawTaskRequest("tools/call", { name: tool.name, arguments: args }, ctx)
                : await this.client!.callTool(
                    { name: tool.name, arguments: args },
                    { signal: ctx.signal, timeout: this.config.requestTimeoutMs },
                  );
            } finally {
              if (this.config.tasks) this.taskReservations--;
            }
          })();
          this.assertGeneration(generation);
          if (result.resultType === "task") {
            if (!this.config.tasks) throw new Error("Unnegotiated MCP task result");
            const remote = this.parseTask(result);
            const handle = `mcp:${randomUUID()}`;
            this.handles.set(handle, { remote, owner: this.owner(ctx), answered: new Set() });
            return { content: JSON.stringify(this.snapshot(handle, this.handles.get(handle)!)) };
          }
          if (result.resultType === "input_required") {
            // Preserve the opaque continuation for the host; never invent consent or replay an effect.
            return {
              content: "MCP tool requires host input",
              artifacts: [{ type: "mcp-input-required", data: result }],
            };
          }
          if (result.resultType !== undefined && result.resultType !== "complete")
            throw new Error("Unsupported MCP result type");
          const mapped = mapMCPResult(result);
          if (result.isError) throw new MCPToolError(mapped);
          return mapped;
        },
      };
    });
  }

  async getTools(filter?: { include?: string[]; exclude?: string[] }): Promise<ToolDef[]> {
    await this.connect();
    return this.tools.filter((tool) => {
      const name = tool.name.slice(this.name.length + 2);
      return (!filter?.include || filter.include.includes(name)) && !filter?.exclude?.includes(name);
    });
  }

  async refresh(): Promise<void> {
    if (!this.client) throw new Error("MCP provider is not connected");
    const client = this.client;
    const tools = this.mapTools((await client.listTools()).tools);
    if (this.client !== client) throw new Error("MCP connection closed during refresh");
    this.tools = tools;
  }

  /** Host-side controls: caller must retain the owning run identity. Handles are local to this connection. */
  async getTask(handle: string, ctx: RunContext): Promise<MCPTaskSnapshot> {
    const entry = this.getOwned(handle, ctx);
    if (!["completed", "failed", "cancelled"].includes(entry.remote.status)) {
      const result = await this.taskRequest("tasks/get", entry, ctx);
      if (result.resultType !== "complete") throw new Error("Invalid MCP task snapshot");
      const next = this.parseTask(result);
      if (next.taskId !== entry.remote.taskId) throw new Error("MCP task identity changed");
      if (
        !["completed", "failed", "cancelled"].includes(entry.remote.status) &&
        Date.parse(next.lastUpdatedAt) >= Date.parse(entry.remote.lastUpdatedAt)
      )
        entry.remote = next;
    }
    return this.snapshot(handle, entry);
  }

  async cancelTask(handle: string, ctx: RunContext): Promise<MCPTaskSnapshot> {
    const entry = this.getOwned(handle, ctx);
    if (!["completed", "failed", "cancelled"].includes(entry.remote.status)) {
      const ack = await this.taskRequest("tasks/cancel", entry, ctx);
      if (ack.resultType !== "complete") throw new Error("Invalid MCP cancellation acknowledgement");
      entry.cancellationRequested = true;
    }
    return this.snapshot(handle, entry);
  }

  async respondToTask(handle: string, responses: Record<string, unknown>, ctx: RunContext): Promise<void> {
    const entry = this.getOwned(handle, ctx);
    if (entry.remote.status !== "input_required") throw new Error("MCP task is not waiting for input");
    const keys = Object.keys(responses);
    if (
      !keys.length ||
      keys.some((key) => !Object.hasOwn(entry.remote.inputRequests ?? {}, key) || entry.answered.has(key))
    ) {
      throw new Error("Unknown or already answered MCP input request");
    }
    for (const key of keys) entry.answered.add(key);
    try {
      const ack = await this.taskRequest("tasks/update", entry, ctx, { inputResponses: responses });
      if (ack.resultType !== "complete") throw new Error("Invalid MCP input acknowledgement");
    } catch (error) {
      for (const key of keys) entry.answered.delete(key);
      throw error;
    }
  }

  /** Forget local state only. Remote execution is unaffected; cancel explicitly first when required. */
  releaseTask(handle: string, ctx: RunContext): void {
    this.getOwned(handle, ctx);
    this.handles.delete(handle);
  }

  /** Export a remote reference for an explicitly authenticated HTTP task. Local handles stay ephemeral. */
  exportTaskReference(handle: string, ctx: RunContext): MCPPersistedTaskReference {
    const entry = this.getOwned(handle, ctx);
    if (this.config.transport !== "http" || !this.config.tasks || !ctx.tenantId || !ctx.userId)
      throw new Error("Persisted MCP task references require HTTP Tasks and tenant/user identity");
    return {
      version: 1,
      providerName: this.name,
      endpoint: new URL(this.config.url!).href,
      taskId: entry.remote.taskId,
      identity: { tenantId: ctx.tenantId, userId: ctx.userId, sessionId: ctx.sessionId },
    };
  }

  /** Reauthorize at the remote endpoint before creating a new handle for the current run.
   * The host must load the reference from owned storage; no task payload or grant is restored.
   */
  async resumeTask(reference: MCPPersistedTaskReference, ctx: RunContext): Promise<MCPTaskSnapshot> {
    if (
      this.config.transport !== "http" ||
      !this.config.tasks ||
      reference?.version !== 1 ||
      reference.providerName !== this.name ||
      reference.endpoint !== new URL(this.config.url!).href ||
      typeof reference.taskId !== "string" ||
      !reference.taskId.trim() ||
      reference.taskId.length > 512 ||
      !ctx.tenantId ||
      !ctx.userId ||
      reference.identity?.tenantId !== ctx.tenantId ||
      reference.identity.userId !== ctx.userId ||
      reference.identity.sessionId !== ctx.sessionId
    )
      throw new Error("Invalid or unauthorized persisted MCP task reference");
    // Copy before awaiting so callers cannot change the validated target during connection setup.
    const taskId = reference.taskId;
    ctx.signal?.throwIfAborted();
    await this.connect();
    this.pruneTasks();
    if (this.handles.size + this.taskReservations >= (this.config.maxTaskHandles ?? 256))
      throw new Error("MCP task handle capacity reached");
    const generation = this.generation;
    this.taskReservations++;
    try {
      const result = await this.rawTaskRequest("tasks/get", { taskId }, ctx);
      this.assertGeneration(generation);
      if (result.resultType !== "complete") throw new Error("Invalid MCP task snapshot");
      const remote = this.parseTask(result);
      if (remote.taskId !== taskId) throw new Error("MCP task identity changed");
      if (remote.ttlMs !== null && Date.now() >= Date.parse(remote.createdAt) + remote.ttlMs)
        throw new Error("MCP task has expired");
      const handle = `mcp:${randomUUID()}`;
      const entry: TaskEntry = { remote, owner: this.owner(ctx), answered: new Set() };
      this.handles.set(handle, entry);
      return this.snapshot(handle, entry);
    } finally {
      this.taskReservations--;
    }
  }

  private async taskRequest(
    method: string,
    entry: TaskEntry,
    ctx: RunContext,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (!this.client) throw new Error("MCP task connection is closed");
    return this.rawTaskRequest(method, { taskId: entry.remote.taskId, ...extra }, ctx, method === "tasks/cancel");
  }

  private rawTaskRequest(
    method: string,
    params: Record<string, unknown>,
    ctx: RunContext,
    ignoreRunAbort = false,
  ): Promise<Record<string, unknown>> {
    if (!this.taskTransport || !this.client) throw new Error("MCP Tasks is not connected");
    return this.taskTransport.request(
      method,
      {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": this.client.getNegotiatedProtocolVersion(),
          "io.modelcontextprotocol/clientInfo": { name: `agentium-${this.name}`, version: "3.2.0" },
          "io.modelcontextprotocol/clientCapabilities": { extensions: { [TASKS_EXTENSION]: {} } },
        },
      },
      ignoreRunAbort ? undefined : ctx.signal,
      this.config.requestTimeoutMs,
    );
  }

  private parseTask(result: unknown): WireTask {
    const task = taskResult.parse(result);
    if (task.status === "completed" && !task.result) throw new Error("Completed MCP task lacks result");
    if (task.status === "failed" && !task.error) throw new Error("Failed MCP task lacks error");
    if (task.status === "input_required" && !task.inputRequests) throw new Error("MCP task lacks input requests");
    return task;
  }

  private owner(ctx: RunContext): string {
    return JSON.stringify([ctx.runId, ctx.sessionId, ctx.userId, ctx.tenantId]);
  }
  private pruneTasks(): void {
    for (const [handle, entry] of this.handles) {
      if (entry.remote.ttlMs !== null && Date.now() >= Date.parse(entry.remote.createdAt) + entry.remote.ttlMs)
        this.handles.delete(handle);
    }
  }
  private getOwned(handle: string, ctx: RunContext): TaskEntry {
    this.pruneTasks();
    const entry = this.handles.get(handle);
    if (!entry || entry.owner !== this.owner(ctx)) throw new Error("Unknown or unauthorized MCP task handle");
    return entry;
  }
  private snapshot(handle: string, entry: TaskEntry): MCPTaskSnapshot {
    const task = entry.remote;
    return structuredClone({
      handle,
      status: task.status === "working" ? "running" : task.status === "input_required" ? "input-required" : task.status,
      pollAfterMs: task.pollIntervalMs,
      inputRequests:
        task.inputRequests &&
        Object.fromEntries(Object.entries(task.inputRequests).filter(([key]) => !entry.answered.has(key))),
      result: task.result ? mapMCPResult(task.result) : undefined,
      error: task.error,
      cancellationRequested: entry.cancellationRequested,
    });
  }

  async close(): Promise<void> {
    this.generation++;
    const clients = new Set([this.client, this.pendingClient]);
    this.client = undefined;
    this.pendingClient = undefined;
    this.connecting = undefined;
    this.taskTransport = undefined;
    this.tools = [];
    this.handles.clear();
    await Promise.all([...clients].map((client) => client?.close()));
  }
}
