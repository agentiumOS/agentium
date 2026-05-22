import type { MCPToolProviderConfig, ToolDef } from "@agentium/core";
import { MCPToolProvider } from "@agentium/core";

export interface MCPServerEntry {
  id: string;
  config: MCPToolProviderConfig;
  provider: MCPToolProvider;
  status: "disconnected" | "connecting" | "connected" | "error";
  error?: string;
  toolCount: number;
  connectedAt?: Date;
}

export interface MCPServerSummary {
  id: string;
  name: string;
  transport: string;
  url?: string;
  command?: string;
  status: string;
  toolCount: number;
  error?: string;
  connectedAt?: string;
}

/**
 * Manages multiple MCP server connections at runtime.
 * Servers can be added/removed/connected/disconnected dynamically,
 * and their tools can be collected for injection into agents.
 */
export class MCPManager {
  private servers = new Map<string, MCPServerEntry>();

  /** Add a server config. Auto-generates an id from the name if not provided. */
  add(config: MCPToolProviderConfig, id?: string): MCPServerSummary {
    const serverId = id ?? config.name;
    if (this.servers.has(serverId)) {
      throw new Error(`MCP server "${serverId}" already exists`);
    }

    const provider = new MCPToolProvider(config);
    const entry: MCPServerEntry = {
      id: serverId,
      config,
      provider,
      status: "disconnected",
      toolCount: 0,
    };
    this.servers.set(serverId, entry);
    return this.summarize(entry);
  }

  /** Connect a server by id. Discovers tools on success. */
  async connect(id: string): Promise<MCPServerSummary> {
    const entry = this.getEntry(id);
    entry.status = "connecting";
    entry.error = undefined;

    try {
      await entry.provider.connect();
      const tools = await entry.provider.getTools();
      entry.status = "connected";
      entry.toolCount = tools.length;
      entry.connectedAt = new Date();
    } catch (err: any) {
      entry.status = "error";
      entry.error = err.message;
    }

    return this.summarize(entry);
  }

  /** Disconnect a server by id. */
  async disconnect(id: string): Promise<MCPServerSummary> {
    const entry = this.getEntry(id);
    try {
      await entry.provider.close();
    } catch {
      // best-effort
    }
    entry.status = "disconnected";
    entry.toolCount = 0;
    entry.connectedAt = undefined;
    return this.summarize(entry);
  }

  /** Remove a server entirely. Disconnects first if connected. */
  async remove(id: string): Promise<void> {
    const entry = this.getEntry(id);
    if (entry.status === "connected" || entry.status === "connecting") {
      try {
        await entry.provider.close();
      } catch {
        // best-effort
      }
    }
    this.servers.delete(id);
  }

  /** Get all tools from all connected servers, merged into one array. */
  async getAllTools(): Promise<ToolDef[]> {
    const all: ToolDef[] = [];
    for (const entry of this.servers.values()) {
      if (entry.status === "connected") {
        try {
          const tools = await entry.provider.getTools();
          all.push(...tools);
        } catch {
          // skip servers that fail to return tools
        }
      }
    }
    return all;
  }

  /** Get tools from a specific server. */
  async getTools(id: string): Promise<ToolDef[]> {
    const entry = this.getEntry(id);
    if (entry.status !== "connected") {
      throw new Error(`MCP server "${id}" is not connected`);
    }
    return entry.provider.getTools();
  }

  /** List all registered servers. */
  list(): MCPServerSummary[] {
    return Array.from(this.servers.values()).map((e) => this.summarize(e));
  }

  /** Get a single server summary. */
  get(id: string): MCPServerSummary {
    return this.summarize(this.getEntry(id));
  }

  has(id: string): boolean {
    return this.servers.has(id);
  }

  /** Disconnect all servers. */
  async closeAll(): Promise<void> {
    const promises = Array.from(this.servers.values()).map(async (entry) => {
      if (entry.status === "connected") {
        try {
          await entry.provider.close();
        } catch {
          // best-effort
        }
        entry.status = "disconnected";
        entry.toolCount = 0;
      }
    });
    await Promise.all(promises);
  }

  private getEntry(id: string): MCPServerEntry {
    const entry = this.servers.get(id);
    if (!entry) throw new Error(`MCP server "${id}" not found`);
    return entry;
  }

  private summarize(entry: MCPServerEntry): MCPServerSummary {
    return {
      id: entry.id,
      name: entry.config.name,
      transport: entry.config.transport,
      url: entry.config.url,
      command: entry.config.command,
      status: entry.status,
      toolCount: entry.toolCount,
      error: entry.error,
      connectedAt: entry.connectedAt?.toISOString(),
    };
  }
}
