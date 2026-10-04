import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef, ToolResult } from "../tools/types.js";
import { MCPToolError, mapMCPResult } from "./mcp-v2.js";

export interface MCPToolProviderConfig {
  name: string;
  /**
   * Transport type:
   * - `"stdio"` — spawn a local MCP server process
   * - `"http"` — Streamable HTTP transport
   * - `"sse"` — SSE transport with async responses (POST → 202, response via SSE stream).
   *   Use this when the server has separate `/sse` and `/messages` endpoints.
   */
  transport: "stdio" | "http" | "sse" | "custom";
  /** Host supplied transport; a fresh instance is required after close. */
  transportFactory?: () => Transport | Promise<Transport>;
  /** For stdio transport: command to spawn */
  command?: string;
  /** For stdio transport: args for the command */
  args?: string[];
  /** For stdio transport: environment variables */
  env?: Record<string, string>;
  /** For http/sse transport: server URL (for SSE, the SSE endpoint URL) */
  url?: string;
  /** For http/sse transport: custom headers */
  headers?: Record<string, string>;
}

/**
 * Connects to an MCP (Model Context Protocol) server and exposes its tools
 * as native Agentium ToolDef[] that any Agent can use.
 *
 * Supports stdio and HTTP (Streamable HTTP) transports.
 * Requires: npm install @modelcontextprotocol/sdk
 */
export class MCPToolProvider {
  readonly name: string;
  private config: MCPToolProviderConfig;
  private client: any = null;
  private pendingClient: any = null;
  private generation = 0;
  private tools: ToolDef[] = [];
  private connected = false;
  private connectPromise: Promise<void> | null = null;

  constructor(config: MCPToolProviderConfig) {
    this.name = config.name;
    this.config = { ...config, headers: { ...config.headers }, args: config.args?.slice(), env: { ...config.env } };
    if (config.transport === "http" || config.transport === "sse") {
      const url = new URL(config.url ?? "");
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw new Error("Invalid MCP endpoint URL");
    }
  }

  async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    if (this.connected) return;
    const generation = this.generation;
    const operation = this.open(generation).finally(() => {
      if (this.connectPromise === operation) this.connectPromise = null;
    });
    this.connectPromise = operation;
    return operation;
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.generation) throw new Error("MCP connection closed during initialization");
  }

  private async open(generation: number): Promise<void> {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    this.assertGeneration(generation);
    const client = new Client({ name: `agentium-${this.name}`, version: "1.0.0" }, { capabilities: {} });
    this.pendingClient = client;
    let transport: Transport | undefined;
    try {
      if (this.config.transport === "custom") {
        if (!this.config.transportFactory) throw new Error("MCP custom transport requires transportFactory");
        transport = await this.config.transportFactory();
      } else if (this.config.transport === "stdio") {
        if (!this.config.command) throw new Error("MCPToolProvider: 'command' is required for stdio transport");
        const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
        transport = new StdioClientTransport({
          command: this.config.command,
          args: this.config.args ?? [],
          env: { ...process.env, ...this.config.env } as Record<string, string>,
        });
      } else {
        const endpoint = new URL(this.config.url!);
        const guardedFetch: typeof fetch = (input, init) => {
          const target = new URL(input instanceof Request ? input.url : String(input));
          if (target.origin !== endpoint.origin) throw new Error("MCP cross-origin request denied");
          return fetch(input, { ...init, redirect: "error" });
        };
        if (this.config.transport === "sse") {
          const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
          transport = new SSEClientTransport(endpoint, {
            requestInit: { headers: this.config.headers, redirect: "error" },
            fetch: guardedFetch,
          });
        } else {
          const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
          transport = new StreamableHTTPClientTransport(endpoint, {
            requestInit: { headers: this.config.headers, redirect: "error" },
            fetch: guardedFetch,
          });
        }
      }
      this.assertGeneration(generation);
      await client.connect(transport);
      const tools = await this.discoverTools(client);
      this.assertGeneration(generation);
      this.client = client;
      this.tools = tools;
      this.connected = true;
    } catch (error) {
      await client.close().catch(() => {});
      await transport?.close().catch(() => {});
      throw error;
    } finally {
      if (this.pendingClient === client) this.pendingClient = null;
    }
  }

  private async discoverTools(client: any): Promise<ToolDef[]> {
    const { z } = await import("zod/v3");
    const mcpTools: any[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await client.listTools(cursor ? { cursor } : undefined);
      mcpTools.push(...(result.tools ?? []));
      cursor = result.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("MCP tools pagination repeated a cursor");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const names = new Set<string>();
    return mcpTools.map((mcpTool: any) => {
      const toolName = mcpTool.name;
      if (names.has(toolName)) throw new Error(`Duplicate MCP tool: ${toolName}`);
      names.add(toolName);
      const inputSchema = mcpTool.inputSchema ?? { type: "object", properties: {} };
      return {
        name: `${this.name}__${toolName}`,
        description: `[${this.name}] ${mcpTool.description ?? ""}`,
        parameters: this.jsonSchemaToZod(inputSchema, z),
        rawJsonSchema: inputSchema,
        execute: async (args: Record<string, unknown>, ctx: RunContext): Promise<string | ToolResult> => {
          ctx.signal?.throwIfAborted();
          if (this.client !== client || !this.connected) throw new Error("MCP tool connection is closed");
          const result = await client.callTool({ name: toolName, arguments: args }, undefined, { signal: ctx.signal });
          const mapped = mapMCPResult(result);
          if (result.isError) throw new MCPToolError(mapped);
          return mapped;
        },
      } satisfies ToolDef;
    });
  }

  private jsonSchemaToZod(schema: any, z: any): any {
    if (!schema?.properties) {
      return z.object({}).passthrough();
    }

    const shape: Record<string, any> = {};
    const required: string[] = schema.required ?? [];

    for (const [key, prop] of Object.entries(schema.properties) as [string, any][]) {
      let field: any;

      switch (prop.type) {
        case "string":
          field = z.string();
          if (prop.enum) field = z.enum(prop.enum);
          break;
        case "number":
        case "integer":
          field = z.number();
          break;
        case "boolean":
          field = z.boolean();
          break;
        case "array":
          field = z.array(z.any());
          break;
        case "object":
          field = z.record(z.any());
          break;
        default:
          field = z.any();
      }

      if (prop.description) {
        field = field.describe(prop.description);
      }

      if (!required.includes(key)) {
        field = field.optional();
      }

      shape[key] = field;
    }

    return z.object(shape).passthrough();
  }

  /**
   * Returns tools from this MCP server as Agentium ToolDef[].
   * Optionally filter by tool names to reduce token usage.
   *
   * @param filter - Tool names to include (without the server name prefix).
   *                 If omitted, returns all tools.
   *
   * @example
   * // All tools
   * await mcp.getTools()
   *
   * // Only specific tools (pass the original MCP tool names, not prefixed)
   * await mcp.getTools({ include: ["get_latest_release", "search_repositories"] })
   *
   * // Exclude specific tools
   * await mcp.getTools({ exclude: ["push_files", "create_repository"] })
   */
  async getTools(filter?: { include?: string[]; exclude?: string[] }): Promise<ToolDef[]> {
    if (!this.connected) {
      await this.connect();
    }

    if (!filter) {
      return [...this.tools];
    }

    const prefix = `${this.name}__`;

    return this.tools.filter((tool) => {
      const shortName = tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name;

      if (filter.include) {
        return filter.include.includes(shortName);
      }
      if (filter.exclude) {
        return !filter.exclude.includes(shortName);
      }
      return true;
    });
  }

  /** Refresh the tool list from the MCP server. */
  async refresh(): Promise<void> {
    if (!this.connected) {
      throw new Error("MCPToolProvider: not connected. Call connect() first.");
    }
    const client = this.client;
    const tools = await this.discoverTools(client);
    if (this.client !== client || !this.connected) throw new Error("MCP connection closed during refresh");
    this.tools = tools;
  }

  /** Disconnects immediately; transports acquired by an unfinished factory are closed on arrival. */
  async close(): Promise<void> {
    this.generation++;
    const clients = new Set([this.client, this.pendingClient]);
    this.client = null;
    this.pendingClient = null;
    this.connected = false;
    this.connectPromise = null;
    this.tools = [];
    await Promise.all([...clients].map((client) => client?.close().catch(() => {})));
  }
}
