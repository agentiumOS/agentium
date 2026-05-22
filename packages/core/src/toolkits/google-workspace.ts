import { MCPToolProvider } from "../mcp/mcp-client.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

export interface GoogleWorkspaceConfig {
  /**
   * Google Workspace services to expose as tools.
   * Each service maps to a set of API resources/methods discovered via MCP.
   *
   * Common services: `"drive"`, `"gmail"`, `"calendar"`, `"sheets"`, `"docs"`,
   * `"chat"`, `"admin"`, `"contacts"`, `"tasks"`, `"forms"`, `"slides"`.
   * Use `"all"` to expose every service.
   *
   * @default ["drive", "gmail", "calendar", "sheets"]
   */
  services?: string[];

  /**
   * Path to the `gws` binary. Defaults to `"gws"` (assumes it's on PATH).
   * Install via: `npm install -g @googleworkspace/cli`
   */
  gwsBinaryPath?: string;

  /** Include higher-level workflow tools (e.g., gmail send, drive upload). */
  includeWorkflows?: boolean;

  /** Include helper tools for common multi-step operations. */
  includeHelpers?: boolean;

  /** Environment variables forwarded to the gws process (e.g., auth overrides). */
  env?: Record<string, string>;
}

const DEFAULT_SERVICES = ["drive", "gmail", "calendar", "sheets"];

/**
 * Google Workspace toolkit powered by the
 * [gws CLI](https://github.com/googleworkspace/cli) MCP server.
 *
 * Dynamically exposes 30+ Google Workspace APIs (Drive, Gmail, Calendar,
 * Sheets, Docs, Chat, Admin, and more) as native Agentium tools via the
 * Model Context Protocol. New APIs added to gws are picked up automatically
 * at connect time — zero maintenance required.
 *
 * **Prerequisites:**
 * 1. Install gws: `npm install -g @googleworkspace/cli`
 * 2. Authenticate: `gws auth setup` (or `gws auth login`)
 * 3. Install MCP SDK: `npm install @modelcontextprotocol/sdk`
 *
 * @example
 * ```ts
 * const gw = new GoogleWorkspaceToolkit({
 *   services: ["drive", "gmail", "calendar", "sheets"],
 * });
 * await gw.connect();
 *
 * const agent = new Agent({
 *   name: "workspace-agent",
 *   model: openai("gpt-4o"),
 *   tools: gw.getTools(),
 * });
 * ```
 */
export class GoogleWorkspaceToolkit extends Toolkit {
  readonly name = "google_workspace";
  private mcp: MCPToolProvider;
  private cachedTools: ToolDef[] = [];
  private _connected = false;

  constructor(config: GoogleWorkspaceConfig = {}) {
    super();
    const services = config.services ?? DEFAULT_SERVICES;
    const args = ["mcp", "-s", services.join(",")];
    if (config.includeWorkflows) args.push("--workflows");
    if (config.includeHelpers) args.push("--helpers");

    this.mcp = new MCPToolProvider({
      name: "gws",
      transport: "stdio",
      command: config.gwsBinaryPath ?? "gws",
      args,
      env: config.env,
    });
  }

  /**
   * Connect to the gws MCP server and discover available tools.
   * Must be called before `getTools()`.
   */
  async connect(): Promise<void> {
    if (this._connected) return;
    await this.mcp.connect();
    this.cachedTools = await this.mcp.getTools();
    this._connected = true;
  }

  /**
   * Returns all discovered Google Workspace tools.
   * Call `connect()` first — returns an empty array if not yet connected.
   */
  getTools(): ToolDef[] {
    return this.cachedTools;
  }

  /** Re-discover tools from the gws MCP server (e.g., after gws update). */
  async refresh(): Promise<void> {
    await this.mcp.refresh();
    this.cachedTools = await this.mcp.getTools();
  }

  /** Whether the toolkit is connected to the gws MCP server. */
  get connected(): boolean {
    return this._connected;
  }

  /** Disconnect from the gws MCP server and clean up the spawned process. */
  async close(): Promise<void> {
    if (!this._connected) return;
    await this.mcp.close();
    this.cachedTools = [];
    this._connected = false;
  }
}
