import type { ToolDef } from "@agentium/core";
import { collectToolkitTools, describeToolLibrary, registry } from "@agentium/core";
import { Router } from "express";
import { ConfigStore } from "./config-store.js";
import { EntityFactory } from "./entity-factory.js";
import type { ToolkitConfig } from "./toolkit-manager.js";
import { ToolkitManager } from "./toolkit-manager.js";
import type { AdminOptions, AgentBlueprint, TeamBlueprint, WorkflowBlueprint } from "./types.js";

export interface AdminRouterResult {
  /** Express router — mount at your chosen path (e.g., `app.use("/admin", router)`) */
  router: Router;
  /** The merged tool library (toolkit tools + explicit toolLibrary + dynamic toolkit configs). */
  toolLibrary: Record<string, ToolDef>;
  /** Toolkit manager for programmatic access. */
  toolkitManager: ToolkitManager;
  /**
   * Re-create all persisted entities and toolkit configs into the live registry.
   * Call once at startup before accepting requests.
   */
  hydrate: () => Promise<{
    agents: number;
    teams: number;
    workflows: number;
    toolkits: { total: number; active: number; failed: string[] };
  }>;
}

function buildStaticToolLibrary(opts: AdminOptions): Record<string, ToolDef> {
  const fromToolkits = opts.toolkits ? collectToolkitTools(opts.toolkits) : {};
  return { ...fromToolkits, ...(opts.toolLibrary ?? {}) };
}

export function createAdminRouter(opts: AdminOptions): AdminRouterResult {
  const staticToolLibrary = buildStaticToolLibrary(opts);
  const store = new ConfigStore(opts.storage);
  const tkManager = new ToolkitManager(opts.storage);

  const getToolLibrary = (): Record<string, ToolDef> => ({
    ...tkManager.getToolLibrary(),
    ...staticToolLibrary,
  });

  const factory = new EntityFactory(getToolLibrary);
  const router = Router();

  if (opts.middleware) {
    for (const mw of opts.middleware) {
      router.use(mw);
    }
  }

  // ── Agent CRUD ────────────────────────────────────────────────────────

  router.post("/agents", async (req: any, res: any) => {
    try {
      const body = req.body as Partial<AgentBlueprint>;
      if (!body.name || !body.provider || !body.model) {
        return res.status(400).json({ error: "name, provider, and model are required" });
      }

      const existing = await store.loadAgent(body.name);
      if (existing) {
        return res.status(409).json({ error: `Agent "${body.name}" already exists` });
      }

      const blueprint: AgentBlueprint = {
        name: body.name,
        provider: body.provider,
        model: body.model,
        instructions: body.instructions,
        tools: body.tools,
        temperature: body.temperature,
        providerConfig: body.providerConfig,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      factory.createAgent(blueprint);
      await store.saveAgent(blueprint);

      res.status(201).json(blueprint);
    } catch (error: any) {
      res.status(422).json({ error: error.message });
    }
  });

  router.get("/agents", async (_req: any, res: any) => {
    try {
      const agents = await store.listAgents();
      res.json(agents);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get("/agents/:name", async (req: any, res: any) => {
    try {
      const blueprint = await store.loadAgent(req.params.name);
      if (!blueprint) {
        return res.status(404).json({ error: `Agent "${req.params.name}" not found` });
      }
      res.json(blueprint);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  router.put("/agents/:name", async (req: any, res: any) => {
    try {
      const name = req.params.name;
      const existing = await store.loadAgent(name);
      if (!existing) {
        return res.status(404).json({ error: `Agent "${name}" not found` });
      }

      const body = req.body as Partial<AgentBlueprint>;
      const updated: AgentBlueprint = {
        ...existing,
        ...body,
        name,
        updatedAt: new Date().toISOString(),
      };

      factory.destroyAgent(name);
      factory.createAgent(updated);
      await store.saveAgent(updated);

      res.json(updated);
    } catch (error: any) {
      res.status(422).json({ error: error.message });
    }
  });

  router.delete("/agents/:name", async (req: any, res: any) => {
    try {
      const name = req.params.name;
      const existing = await store.loadAgent(name);
      if (!existing) {
        return res.status(404).json({ error: `Agent "${name}" not found` });
      }

      factory.destroyAgent(name);
      await store.deleteAgent(name);

      res.json({ deleted: name });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── Team CRUD ─────────────────────────────────────────────────────────

  router.post("/teams", async (req: any, res: any) => {
    try {
      const body = req.body as Partial<TeamBlueprint>;
      if (!body.name || !body.mode || !body.provider || !body.model || !body.members?.length) {
        return res.status(400).json({ error: "name, mode, provider, model, and members[] are required" });
      }

      const existing = await store.loadTeam(body.name);
      if (existing) {
        return res.status(409).json({ error: `Team "${body.name}" already exists` });
      }

      const blueprint: TeamBlueprint = {
        name: body.name,
        mode: body.mode,
        provider: body.provider,
        model: body.model,
        members: body.members,
        instructions: body.instructions,
        providerConfig: body.providerConfig,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      factory.createTeam(blueprint);
      await store.saveTeam(blueprint);

      res.status(201).json(blueprint);
    } catch (error: any) {
      res.status(422).json({ error: error.message });
    }
  });

  router.get("/teams", async (_req: any, res: any) => {
    try {
      const teams = await store.listTeams();
      res.json(teams);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get("/teams/:name", async (req: any, res: any) => {
    try {
      const blueprint = await store.loadTeam(req.params.name);
      if (!blueprint) {
        return res.status(404).json({ error: `Team "${req.params.name}" not found` });
      }
      res.json(blueprint);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  router.put("/teams/:name", async (req: any, res: any) => {
    try {
      const name = req.params.name;
      const existing = await store.loadTeam(name);
      if (!existing) {
        return res.status(404).json({ error: `Team "${name}" not found` });
      }

      const body = req.body as Partial<TeamBlueprint>;
      const updated: TeamBlueprint = {
        ...existing,
        ...body,
        name,
        updatedAt: new Date().toISOString(),
      };

      factory.destroyTeam(name);
      factory.createTeam(updated);
      await store.saveTeam(updated);

      res.json(updated);
    } catch (error: any) {
      res.status(422).json({ error: error.message });
    }
  });

  router.delete("/teams/:name", async (req: any, res: any) => {
    try {
      const name = req.params.name;
      const existing = await store.loadTeam(name);
      if (!existing) {
        return res.status(404).json({ error: `Team "${name}" not found` });
      }

      factory.destroyTeam(name);
      await store.deleteTeam(name);

      res.json({ deleted: name });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── Workflow CRUD (placeholder — name + metadata only) ────────────────

  router.post("/workflows", async (req: any, res: any) => {
    try {
      const body = req.body as Partial<WorkflowBlueprint>;
      if (!body.name) {
        return res.status(400).json({ error: "name is required" });
      }

      const existing = await store.loadWorkflow(body.name);
      if (existing) {
        return res.status(409).json({ error: `Workflow "${body.name}" already exists` });
      }

      const blueprint: WorkflowBlueprint = {
        name: body.name,
        description: body.description,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await store.saveWorkflow(blueprint);

      res.status(201).json(blueprint);
    } catch (error: any) {
      res.status(422).json({ error: error.message });
    }
  });

  router.get("/workflows", async (_req: any, res: any) => {
    try {
      const workflows = await store.listWorkflows();
      res.json(workflows);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get("/workflows/:name", async (req: any, res: any) => {
    try {
      const blueprint = await store.loadWorkflow(req.params.name);
      if (!blueprint) {
        return res.status(404).json({ error: `Workflow "${req.params.name}" not found` });
      }
      res.json(blueprint);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  router.delete("/workflows/:name", async (req: any, res: any) => {
    try {
      const name = req.params.name;
      const existing = await store.loadWorkflow(name);
      if (!existing) {
        return res.status(404).json({ error: `Workflow "${name}" not found` });
      }

      factory.destroyWorkflow(name);
      await store.deleteWorkflow(name);

      res.json({ deleted: name });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── Tools listing (merged: static + dynamic from toolkit configs) ────

  router.get("/tools", (_req: any, res: any) => {
    res.json(describeToolLibrary(getToolLibrary()));
  });

  router.get("/tools/:name", (req: any, res: any) => {
    const lib = getToolLibrary();
    const tool = lib[req.params.name];
    if (!tool) return res.status(404).json({ error: `Tool "${req.params.name}" not found` });
    res.json({
      name: tool.name,
      description: tool.description,
      parameters: Object.keys(tool.parameters.shape ?? {}),
    });
  });

  // ── Toolkit Catalog (available toolkit types) ─────────────────────────

  router.get("/toolkit-catalog", (_req: any, res: any) => {
    res.json(tkManager.listCatalog());
  });

  router.get("/toolkit-catalog/:id", (req: any, res: any) => {
    const entry = tkManager.getCatalogEntry(req.params.id);
    if (!entry) return res.status(404).json({ error: `Toolkit type "${req.params.id}" not found` });
    res.json(entry);
  });

  // ── Toolkit Config CRUD (manage credentials + instantiate) ────────────

  router.post("/toolkit-configs", async (req: any, res: any) => {
    try {
      const body = req.body as Partial<ToolkitConfig>;
      if (!body.toolkitId || !body.instanceName) {
        return res.status(400).json({ error: "toolkitId and instanceName are required" });
      }

      const existing = await tkManager.loadConfig(body.instanceName);
      if (existing) {
        return res.status(409).json({ error: `Toolkit config "${body.instanceName}" already exists` });
      }

      const config: ToolkitConfig = {
        toolkitId: body.toolkitId,
        instanceName: body.instanceName,
        config: body.config ?? {},
        enabled: body.enabled !== false,
      };

      const masked = await tkManager.saveConfig(config);
      res.status(201).json(masked);
    } catch (error: any) {
      res.status(422).json({ error: error.message });
    }
  });

  router.get("/toolkit-configs", async (_req: any, res: any) => {
    try {
      const configs = await tkManager.listConfigs();
      res.json(configs);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get("/toolkit-configs/:name", async (req: any, res: any) => {
    try {
      const cfg = await tkManager.loadConfig(req.params.name);
      if (!cfg) return res.status(404).json({ error: `Toolkit config "${req.params.name}" not found` });
      res.json(cfg);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  router.put("/toolkit-configs/:name", async (req: any, res: any) => {
    try {
      const body = req.body as Partial<Pick<ToolkitConfig, "config" | "enabled">>;
      const masked = await tkManager.updateConfig(req.params.name, body);
      res.json(masked);
    } catch (error: any) {
      if (error.message?.includes("not found")) {
        res.status(404).json({ error: error.message });
      } else {
        res.status(422).json({ error: error.message });
      }
    }
  });

  router.delete("/toolkit-configs/:name", async (req: any, res: any) => {
    try {
      const deleted = await tkManager.deleteConfig(req.params.name);
      if (!deleted) return res.status(404).json({ error: `Toolkit config "${req.params.name}" not found` });
      res.json({ deleted: req.params.name });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── Hydration ─────────────────────────────────────────────────────────

  async function hydrate(): Promise<{
    agents: number;
    teams: number;
    workflows: number;
    toolkits: { total: number; active: number; failed: string[] };
  }> {
    await store.initialize();

    const tkResult = await tkManager.hydrate();

    const agentBlueprints = await store.listAgents();
    for (const bp of agentBlueprints) {
      if (!registry.getAgent(bp.name)) {
        factory.createAgent(bp);
      }
    }

    const teamBlueprints = await store.listTeams();
    for (const bp of teamBlueprints) {
      if (!registry.getTeam(bp.name)) {
        factory.createTeam(bp);
      }
    }

    return {
      agents: agentBlueprints.length,
      teams: teamBlueprints.length,
      workflows: (await store.listWorkflows()).length,
      toolkits: tkResult,
    };
  }

  return { router, toolLibrary: staticToolLibrary, toolkitManager: tkManager, hydrate };
}
