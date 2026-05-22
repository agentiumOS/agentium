import type { RunContext } from "../agent/run-context.js";
import type { ToolDef, ToolResult } from "../tools/types.js";

export interface MCPToolProviderConfig {
  name: string;
  /**
   * Transport type:
   * - `"stdio"` — spawn a local MCP server process
   * - `"http"` — Streamable HTTP transport (tries StreamableHTTP, falls back to SSE)
   * - `"sse"` — SSE transport with async responses (POST → 202, response via SSE stream).
   *   Use this when the server has separate `/sse` and `/messages` endpoints.
   */
  transport: "stdio" | "http" | "sse";
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
  private transportInstance: any = null;
  private tools: ToolDef[] = [];
  private connected = false;
  private connectPromise: Promise<void> | null = null;

  constructor(config: MCPToolProviderConfig) {
    this.name = config.name;
    this.config = config;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this._connect();
    try {
      await this.connectPromise;
    } catch (e) {
      this.connectPromise = null;
      throw e;
    }
  }

  private async _connect(): Promise<void> {
    let ClientClass: any;
    try {
      const mod = await import("@modelcontextprotocol/sdk/client/index.js");
      ClientClass = mod.Client;
    } catch (e: any) {
      if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error(
          "@modelcontextprotocol/sdk is required for MCPToolProvider. Install it: npm install @modelcontextprotocol/sdk",
        );
      }
      throw e;
    }

    this.client = new ClientClass({ name: `agentium-${this.name}`, version: "1.0.0" }, { capabilities: {} });

    if (this.config.transport === "stdio") {
      if (!this.config.command) {
        throw new Error("MCPToolProvider: 'command' is required for stdio transport");
      }
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

      this.transportInstance = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args ?? [],
        env: { ...process.env, ...(this.config.env ?? {}) } as Record<string, string>,
      });
    } else if (this.config.transport === "http") {
      if (!this.config.url) {
        throw new Error("MCPToolProvider: 'url' is required for http transport");
      }

      let TransportClass: any;
      try {
        const mod = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
        TransportClass = mod.StreamableHTTPClientTransport;
      } catch {
        const mod = await import("@modelcontextprotocol/sdk/client/sse.js");
        TransportClass = mod.SSEClientTransport;
      }

      this.transportInstance = new TransportClass(new URL(this.config.url), {
        requestInit: { headers: this.config.headers ?? {} },
      });
    } else if (this.config.transport === "sse") {
      if (!this.config.url) {
        throw new Error("MCPToolProvider: 'url' is required for sse transport");
      }
      this.transportInstance = new RawSSETransport(this.config.url, this.config.headers ?? {});
    } else {
      throw new Error(`MCPToolProvider: unsupported transport '${this.config.transport}'`);
    }

    await this.client.connect(this.transportInstance);
    this.connected = true;
    await this.discoverTools();
  }

  private async discoverTools(): Promise<void> {
    const { z } = await import("zod");
    const result = await this.client.listTools();
    const mcpTools: any[] = result.tools ?? [];

    this.tools = mcpTools.map((mcpTool: any) => {
      const toolName = mcpTool.name;
      const description = mcpTool.description ?? "";
      const inputSchema = mcpTool.inputSchema ?? { type: "object", properties: {} };

      const parameters = this.jsonSchemaToZod(inputSchema, z);

      const execute = async (args: Record<string, unknown>, _ctx: RunContext): Promise<string | ToolResult> => {
        const callResult = await this.client.callTool({
          name: toolName,
          arguments: args,
        });

        const contents: any[] = callResult.content ?? [];
        const textParts = contents.filter((c: any) => c.type === "text").map((c: any) => c.text);

        const text = textParts.join("\n") || JSON.stringify(callResult);

        const artifacts = contents
          .filter((c: any) => c.type !== "text")
          .map((c: any) => ({
            type: c.type,
            data: c.data ?? c.blob ?? c.text,
            mimeType: c.mimeType,
          }));

        if (artifacts.length > 0) {
          return { content: text, artifacts };
        }
        return text;
      };

      return {
        name: `${this.name}__${toolName}`,
        description: `[${this.name}] ${description}`,
        parameters,
        execute,
        rawJsonSchema: inputSchema,
      } satisfies ToolDef;
    });
  }

  private jsonSchemaToZod(schema: any, z: any): any {
    if (!schema || !schema.properties) {
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
    await this.discoverTools();
  }

  /** Disconnect from the MCP server. */
  async close(): Promise<void> {
    if (this.client && this.connected) {
      try {
        await this.client.close();
      } catch {
        // ignore close errors
      }
      this.connected = false;
      this.tools = [];
    }
  }
}

/**
 * Raw SSE transport for MCP servers that use the async pattern:
 * GET /sse → SSE stream with endpoint event, POST /messages → 202, response via SSE.
 *
 * Implements the Transport interface expected by @modelcontextprotocol/sdk Client.
 */
class RawSSETransport {
  private sseUrl: string;
  private headers: Record<string, string>;
  private messagesUrl = "";
  private abortController: AbortController | null = null;
  onmessage?: (message: any) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;

  constructor(sseUrl: string, headers: Record<string, string>) {
    this.sseUrl = sseUrl;
    this.headers = headers;
  }

  async start(): Promise<void> {
    this.abortController = new AbortController();

    const resp = await fetch(this.sseUrl, {
      headers: { ...this.headers, Accept: "text/event-stream" },
      signal: this.abortController.signal,
    });

    if (!resp.ok || !resp.body) {
      throw new Error(`SSE connection failed: HTTP ${resp.status}`);
    }

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";

    // Read until we get the endpoint event
    while (!this.messagesUrl) {
      const { done, value } = await reader.read();
      if (done) throw new Error("SSE closed before endpoint event");
      buf += dec.decode(value, { stream: true });
      const m = buf.match(/data:\s*(\/\S+)/);
      if (m) {
        const base = new URL(this.sseUrl);
        this.messagesUrl = `${base.origin}${m[1]}`;
      }
    }
    buf = "";

    // Background reader: dispatch incoming messages
    (async () => {
      let eventType = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("event: ")) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith("data: ") && eventType === "message") {
              try {
                const msg = JSON.parse(line.slice(6));
                this.onmessage?.(msg);
              } catch {
                /* malformed JSON */
              }
              eventType = "";
            }
          }
        }
      } catch (err: any) {
        if (err.name !== "AbortError") this.onerror?.(err);
      }
      this.onclose?.();
    })();
  }

  async send(message: any): Promise<void> {
    const resp = await fetch(this.messagesUrl, {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    if (!resp.ok) {
      const text = await resp.text();
      if (resp.status !== 202) {
        throw new Error(`POST failed: HTTP ${resp.status}: ${text}`);
      }
    }
    // If the response body has JSON, dispatch it directly
    const ct = resp.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      try {
        const data = (await resp.json()) as Record<string, unknown>;
        if (data.jsonrpc) this.onmessage?.(data);
      } catch {
        /* no inline response */
      }
    }
  }

  async close(): Promise<void> {
    this.abortController?.abort();
  }
}
