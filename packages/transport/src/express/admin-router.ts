import { createRequire } from "node:module";
import type { MCPToolProviderConfig } from "@agentium/core";
import { toolkitCatalog } from "@agentium/core";
import { MCPManager } from "./mcp-manager.js";

const _require = createRequire(import.meta.url);

export interface AdminRouterOptions {
  /** Shared MCPManager instance. If omitted, a new one is created. */
  mcpManager?: MCPManager;
  /**
   * Express middleware for authentication/authorization.
   * **IMPORTANT**: These endpoints can add MCP servers and execute tools.
   * Always add auth middleware in production.
   */
  middleware?: any[];
}

/**
 * Creates an Express sub-router with admin endpoints for managing
 * MCP servers and the toolkit catalog at runtime.
 *
 * Mount under a prefix: `app.use("/admin", createAdminRouter())`
 *
 * Routes:
 *   GET    /mcp              — list MCP servers
 *   POST   /mcp              — add + connect an MCP server
 *   GET    /mcp/:id          — single server details
 *   POST   /mcp/:id/connect  — connect a server
 *   POST   /mcp/:id/disconnect — disconnect
 *   DELETE /mcp/:id          — remove a server
 *   GET    /mcp/:id/tools    — tools from a specific server
 *   GET    /mcp/tools        — all tools across connected servers
 *
 *   GET    /toolkits         — list toolkit catalog
 *   GET    /toolkits/:id     — single toolkit meta
 *   POST   /toolkits/:id     — instantiate a toolkit with config
 */
export function createAdminRouter(opts?: AdminRouterOptions) {
  let express: any;
  try {
    express = _require("express");
  } catch {
    throw new Error("express is required for createAdminRouter. Install it: npm install express");
  }

  const router = express.Router();
  const mcpManager = opts?.mcpManager ?? new MCPManager();

  if (opts?.middleware) {
    for (const mw of opts.middleware) router.use(mw);
  }

  if (!opts?.middleware?.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "[admin-router] Admin routes cannot be mounted without authentication middleware in production. " +
          "Pass middleware in AdminRouterOptions to secure them.",
      );
    }
    console.warn(
      "[admin-router] WARNING: Admin routes mounted without authentication middleware. " +
        "These endpoints can add MCP servers, execute tools, and modify configurations. " +
        "This is allowed in development only. Pass middleware in AdminRouterOptions to secure them.",
    );
  }

  // ── MCP Server Management ──────────────────────────────────────────────

  router.get("/mcp", (_req: any, res: any) => {
    res.json(mcpManager.list());
  });

  router.get("/mcp/tools", async (_req: any, res: any) => {
    try {
      const tools = await mcpManager.getAllTools();
      res.json(
        tools.map((t: any) => ({
          name: t.name,
          description: t.description,
          parameters: Object.keys(t.parameters?.shape ?? {}),
        })),
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/mcp", async (req: any, res: any) => {
    try {
      const { name, transport, url, command, args, env, headers, id, autoConnect } = req.body;
      if (!name || !transport) {
        return res.status(400).json({ error: "name and transport are required" });
      }

      const config: MCPToolProviderConfig = { name, transport };
      if (url) config.url = url;
      if (command) config.command = command;
      if (args) config.args = args;
      if (env) config.env = env;
      if (headers) config.headers = headers;

      const summary = mcpManager.add(config, id);

      if (autoConnect !== false) {
        const connected = await mcpManager.connect(summary.id);
        return res.status(201).json(connected);
      }

      res.status(201).json(summary);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get("/mcp/:id", (req: any, res: any) => {
    try {
      res.json(mcpManager.get(req.params.id));
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  router.post("/mcp/:id/connect", async (req: any, res: any) => {
    try {
      const summary = await mcpManager.connect(req.params.id);
      res.json(summary);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post("/mcp/:id/disconnect", async (req: any, res: any) => {
    try {
      const summary = await mcpManager.disconnect(req.params.id);
      res.json(summary);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete("/mcp/:id", async (req: any, res: any) => {
    try {
      await mcpManager.remove(req.params.id);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  router.get("/mcp/:id/tools", async (req: any, res: any) => {
    try {
      const tools = await mcpManager.getTools(req.params.id);
      res.json(
        tools.map((t: any) => ({
          name: t.name,
          description: t.description,
          parameters: Object.keys(t.parameters?.shape ?? {}),
        })),
      );
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Toolkit Catalog ────────────────────────────────────────────────────

  router.get("/toolkits", (_req: any, res: any) => {
    res.json(toolkitCatalog.list());
  });

  router.get("/toolkits/:id", (req: any, res: any) => {
    const meta = toolkitCatalog.get(req.params.id);
    if (!meta) return res.status(404).json({ error: `Toolkit "${req.params.id}" not found` });
    res.json(meta);
  });

  router.post("/toolkits/:id", (req: any, res: any) => {
    try {
      const toolkit = toolkitCatalog.create(req.params.id, req.body ?? {});
      const tools = toolkit.getTools().map((t: any) => ({
        name: t.name,
        description: t.description,
      }));
      res.status(201).json({
        id: req.params.id,
        name: toolkit.name,
        tools,
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  return { router, mcpManager };
}
