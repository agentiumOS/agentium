import type { ToolDef } from "@agentium/core";
import { collectToolkitTools, describeToolLibrary, registry } from "@agentium/core";
import { ConfigStore } from "./config-store.js";
import { EntityFactory } from "./entity-factory.js";
import type { ToolkitConfig } from "./toolkit-manager.js";
import { ToolkitManager } from "./toolkit-manager.js";
import type { AdminOptions, AgentBlueprint, TeamBlueprint, WorkflowBlueprint } from "./types.js";

export interface AdminGatewayOptions extends AdminOptions {
  /** Socket.IO server instance. */
  io: any;
  /** Socket.IO namespace for admin events. Default: "/agentium-admin" */
  namespace?: string;
  /** Socket.IO middleware for authentication. */
  authMiddleware?: (socket: any, next: (err?: Error) => void) => void;
}

function buildStaticToolLibrary(opts: AdminGatewayOptions): Record<string, ToolDef> {
  const fromToolkits = opts.toolkits ? collectToolkitTools(opts.toolkits) : {};
  return { ...fromToolkits, ...(opts.toolLibrary ?? {}) };
}

/**
 * Attaches admin CRUD event handlers to a Socket.IO server.
 */
export function createAdminGateway(opts: AdminGatewayOptions): {
  hydrate: () => Promise<{
    agents: number;
    teams: number;
    workflows: number;
    toolkits: { total: number; active: number; failed: string[] };
  }>;
} {
  const staticToolLibrary = buildStaticToolLibrary(opts);
  const store = new ConfigStore(opts.storage);
  const tkManager = new ToolkitManager(opts.storage);

  const getToolLibrary = (): Record<string, ToolDef> => ({
    ...tkManager.getToolLibrary(),
    ...staticToolLibrary,
  });

  const factory = new EntityFactory(getToolLibrary);
  const ns = opts.io.of(opts.namespace ?? "/agentium-admin");

  if (opts.authMiddleware) {
    ns.use(opts.authMiddleware);
  }

  ns.on("connection", (socket: any) => {
    // ── Agent CRUD ──────────────────────────────────────────────────

    socket.on("admin.agent.create", async (data: Partial<AgentBlueprint>, ack?: Function) => {
      try {
        if (!data.name || !data.provider || !data.model) {
          return ack?.({ ok: false, error: "name, provider, and model are required" });
        }

        const existing = await store.loadAgent(data.name);
        if (existing) {
          return ack?.({ ok: false, error: `Agent "${data.name}" already exists` });
        }

        const blueprint: AgentBlueprint = {
          name: data.name,
          provider: data.provider,
          model: data.model,
          instructions: data.instructions,
          tools: data.tools,
          temperature: data.temperature,
          providerConfig: data.providerConfig,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        factory.createAgent(blueprint);
        await store.saveAgent(blueprint);

        ns.emit("admin.agent.created", blueprint);
        ack?.({ ok: true, data: blueprint });
      } catch (error: any) {
        ack?.({ ok: false, error: error.message });
      }
    });

    socket.on("admin.agent.list", async (_data: unknown, ack?: Function) => {
      try {
        const agents = await store.listAgents();
        ack?.({ ok: true, data: agents });
      } catch (error: any) {
        ack?.({ ok: false, error: error.message });
      }
    });

    socket.on("admin.agent.get", async (data: { name: string }, ack?: Function) => {
      try {
        const blueprint = await store.loadAgent(data.name);
        if (!blueprint) return ack?.({ ok: false, error: `Agent "${data.name}" not found` });
        ack?.({ ok: true, data: blueprint });
      } catch (error: any) {
        ack?.({ ok: false, error: error.message });
      }
    });

    socket.on("admin.agent.update", async (data: Partial<AgentBlueprint> & { name: string }, ack?: Function) => {
      try {
        const existing = await store.loadAgent(data.name);
        if (!existing) return ack?.({ ok: false, error: `Agent "${data.name}" not found` });

        const updated: AgentBlueprint = {
          ...existing,
          ...data,
          updatedAt: new Date().toISOString(),
        };

        factory.destroyAgent(data.name);
        factory.createAgent(updated);
        await store.saveAgent(updated);

        ns.emit("admin.agent.updated", updated);
        ack?.({ ok: true, data: updated });
      } catch (error: any) {
        ack?.({ ok: false, error: error.message });
      }
    });

    socket.on("admin.agent.delete", async (data: { name: string }, ack?: Function) => {
      try {
        const existing = await store.loadAgent(data.name);
        if (!existing) return ack?.({ ok: false, error: `Agent "${data.name}" not found` });

        factory.destroyAgent(data.name);
        await store.deleteAgent(data.name);

        ns.emit("admin.agent.deleted", { name: data.name });
        ack?.({ ok: true, data: { deleted: data.name } });
      } catch (error: any) {
        ack?.({ ok: false, error: error.message });
      }
    });

    // ── Team CRUD ───────────────────────────────────────────────────

    socket.on("admin.team.create", async (data: Partial<TeamBlueprint>, ack?: Function) => {
      try {
        if (!data.name || !data.mode || !data.provider || !data.model || !data.members?.length) {
          return ack?.({ ok: false, error: "name, mode, provider, model, and members[] are required" });
        }

        const existing = await store.loadTeam(data.name);
        if (existing) {
          return ack?.({ ok: false, error: `Team "${data.name}" already exists` });
        }

        const blueprint: TeamBlueprint = {
          name: data.name,
          mode: data.mode,
          provider: data.provider,
          model: data.model,
          members: data.members,
          instructions: data.instructions,
          providerConfig: data.providerConfig,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        factory.createTeam(blueprint);
        await store.saveTeam(blueprint);

        ns.emit("admin.team.created", blueprint);
        ack?.({ ok: true, data: blueprint });
      } catch (error: any) {
        ack?.({ ok: false, error: error.message });
      }
    });

    socket.on("admin.team.list", async (_data: unknown, ack?: Function) => {
      try {
        const teams = await store.listTeams();
        ack?.({ ok: true, data: teams });
      } catch (error: any) {
        ack?.({ ok: false, error: error.message });
      }
    });

    socket.on("admin.team.get", async (data: { name: string }, ack?: Function) => {
      try {
        const blueprint = await store.loadTeam(data.name);
        if (!blueprint) return ack?.({ ok: false, error: `Team "${data.name}" not found` });
        ack?.({ ok: true, data: blueprint });
      } catch (error: any) {
        ack?.({ ok: false, error: error.message });
      }
    });

    socket.on("admin.team.update", async (data: Partial<TeamBlueprint> & { name: string }, ack?: Function) => {
      try {
        const existing = await store.loadTeam(data.name);
        if (!existing) return ack?.({ ok: false, error: `Team "${data.name}" not found` });

        const updated: TeamBlueprint = {
          ...existing,
          ...data,
          updatedAt: new Date().toISOString(),
        };

        factory.destroyTeam(data.name);
        factory.createTeam(updated);
        await store.saveTeam(updated);

        ns.emit("admin.team.updated", updated);
        ack?.({ ok: true, data: updated });
      } catch (error: any) {
        ack?.({ ok: false, error: error.message });
      }
    });

    socket.on("admin.team.delete", async (data: { name: string }, ack?: Function) => {
      try {
        const existing = await store.loadTeam(data.name);
        if (!existing) return ack?.({ ok: false, error: `Team "${data.name}" not found` });

        factory.destroyTeam(data.name);
        await store.deleteTeam(data.name);

        ns.emit("admin.team.deleted", { name: data.name });
        ack?.({ ok: true, data: { deleted: data.name } });
      } catch (error: any) {
        ack?.({ ok: false, error: error.message });
      }
    });

    // ── Workflow CRUD ───────────────────────────────────────────────

    socket.on("admin.workflow.create", async (data: Partial<WorkflowBlueprint>, ack?: Function) => {
      try {
        if (!data.name) return ack?.({ ok: false, error: "name is required" });

        const existing = await store.loadWorkflow(data.name);
        if (existing) return ack?.({ ok: false, error: `Workflow "${data.name}" already exists` });

        const blueprint: WorkflowBlueprint = {
          name: data.name,
          description: data.description,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        await store.saveWorkflow(blueprint);

        ns.emit("admin.workflow.created", blueprint);
        ack?.({ ok: true, data: blueprint });
      } catch (error: any) {
        ack?.({ ok: false, error: error.message });
      }
    });

    socket.on("admin.workflow.list", async (_data: unknown, ack?: Function) => {
      try {
        const workflows = await store.listWorkflows();
        ack?.({ ok: true, data: workflows });
      } catch (error: any) {
        ack?.({ ok: false, error: error.message });
      }
    });

    socket.on("admin.workflow.delete", async (data: { name: string }, ack?: Function) => {
      try {
        const existing = await store.loadWorkflow(data.name);
        if (!existing) return ack?.({ ok: false, error: `Workflow "${data.name}" not found` });

        factory.destroyWorkflow(data.name);
        await store.deleteWorkflow(data.name);

        ns.emit("admin.workflow.deleted", { name: data.name });
        ack?.({ ok: true, data: { deleted: data.name } });
      } catch (error: any) {
        ack?.({ ok: false, error: error.message });
      }
    });

    // ── Registry listing ────────────────────────────────────────────

    socket.on("admin.registry.list", async (_data: unknown, ack?: Function) => {
      ack?.({ ok: true, data: registry.list() });
    });

    // ── Tools listing ────────────────────────────────────────────

    socket.on("admin.tools.list", async (_data: unknown, ack?: Function) => {
      ack?.({ ok: true, data: describeToolLibrary(getToolLibrary()) });
    });

    socket.on("admin.tools.get", async (data: { name: string }, ack?: Function) => {
      const lib = getToolLibrary();
      const tool = lib[data.name];
      if (!tool) return ack?.({ ok: false, error: `Tool "${data.name}" not found` });
      ack?.({
        ok: true,
        data: {
          name: tool.name,
          description: tool.description,
          parameters: Object.keys(tool.parameters.shape ?? {}),
        },
      });
    });

    // ── Toolkit Catalog ─────────────────────────────────────────────

    socket.on("admin.toolkit-catalog.list", async (_data: unknown, ack?: Function) => {
      ack?.({ ok: true, data: tkManager.listCatalog() });
    });

    socket.on("admin.toolkit-catalog.get", async (data: { id: string }, ack?: Function) => {
      const entry = tkManager.getCatalogEntry(data.id);
      if (!entry) return ack?.({ ok: false, error: `Toolkit type "${data.id}" not found` });
      ack?.({ ok: true, data: entry });
    });

    // ── Toolkit Config CRUD ─────────────────────────────────────────

    socket.on("admin.toolkit-config.create", async (data: Partial<ToolkitConfig>, ack?: Function) => {
      try {
        if (!data.toolkitId || !data.instanceName) {
          return ack?.({ ok: false, error: "toolkitId and instanceName are required" });
        }

        const existing = await tkManager.loadConfig(data.instanceName);
        if (existing) {
          return ack?.({ ok: false, error: `Toolkit config "${data.instanceName}" already exists` });
        }

        const config: ToolkitConfig = {
          toolkitId: data.toolkitId,
          instanceName: data.instanceName,
          config: data.config ?? {},
          enabled: data.enabled !== false,
        };

        const masked = await tkManager.saveConfig(config);
        ns.emit("admin.toolkit-config.created", masked);
        ack?.({ ok: true, data: masked });
      } catch (error: any) {
        ack?.({ ok: false, error: error.message });
      }
    });

    socket.on("admin.toolkit-config.list", async (_data: unknown, ack?: Function) => {
      try {
        const configs = await tkManager.listConfigs();
        ack?.({ ok: true, data: configs });
      } catch (error: any) {
        ack?.({ ok: false, error: error.message });
      }
    });

    socket.on("admin.toolkit-config.get", async (data: { instanceName: string }, ack?: Function) => {
      try {
        const cfg = await tkManager.loadConfig(data.instanceName);
        if (!cfg) return ack?.({ ok: false, error: `Toolkit config "${data.instanceName}" not found` });
        ack?.({ ok: true, data: cfg });
      } catch (error: any) {
        ack?.({ ok: false, error: error.message });
      }
    });

    socket.on(
      "admin.toolkit-config.update",
      async (data: { instanceName: string; config?: Record<string, unknown>; enabled?: boolean }, ack?: Function) => {
        try {
          const masked = await tkManager.updateConfig(data.instanceName, {
            config: data.config,
            enabled: data.enabled,
          });
          ns.emit("admin.toolkit-config.updated", masked);
          ack?.({ ok: true, data: masked });
        } catch (error: any) {
          ack?.({ ok: false, error: error.message });
        }
      },
    );

    socket.on("admin.toolkit-config.delete", async (data: { instanceName: string }, ack?: Function) => {
      try {
        const deleted = await tkManager.deleteConfig(data.instanceName);
        if (!deleted) return ack?.({ ok: false, error: `Toolkit config "${data.instanceName}" not found` });
        ns.emit("admin.toolkit-config.deleted", { instanceName: data.instanceName });
        ack?.({ ok: true, data: { deleted: data.instanceName } });
      } catch (error: any) {
        ack?.({ ok: false, error: error.message });
      }
    });
  });

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

  return { hydrate };
}
