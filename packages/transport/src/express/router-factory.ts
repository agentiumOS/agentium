import { createRequire } from "node:module";
import type { Registry } from "@agentium/core";
import {
  classifyServables,
  collectToolkitTools,
  describeToolLibrary,
  registry as globalRegistry,
} from "@agentium/core";
import { createAdminRouter } from "./admin-router.js";
import { buildMultiModalInput, createFileUploadMiddleware } from "./file-upload.js";
import { createJwtMiddleware } from "./jwt-middleware.js";
import { createRbacMiddleware } from "./rbac-middleware.js";
import { generateOpenAPISpec, serveSwaggerUI } from "./swagger.js";
import type { RouterOptions } from "./types.js";

const _require = createRequire(import.meta.url);

function corsMiddleware(origins: string | string[] | boolean): (req: any, res: any, next: any) => void {
  return (req: any, res: any, next: any) => {
    const origin = req.headers.origin;
    let allowed = false;

    if (origins === true || origins === "*") {
      allowed = true;
      res.setHeader("Access-Control-Allow-Origin", "*");
    } else if (typeof origins === "string") {
      allowed = origin === origins;
      if (allowed) res.setHeader("Access-Control-Allow-Origin", origin);
    } else if (Array.isArray(origins)) {
      allowed = origins.includes(origin);
      if (allowed) res.setHeader("Access-Control-Allow-Origin", origin);
    }

    if (allowed) {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
      res.setHeader("Access-Control-Max-Age", "86400");
    }

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

function rateLimitMiddleware(
  config: { windowMs?: number; max?: number } = {},
): (req: any, res: any, next: any) => void {
  const windowMs = config.windowMs ?? 60000;
  const max = config.max ?? 100;
  const hits = new Map<string, { count: number; resetTime: number }>();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of hits) {
      if (now > record.resetTime) hits.delete(key);
    }
  }, windowMs);
  cleanup.unref();

  return (req: any, res: any, next: any) => {
    const key = req.ip ?? req.socket?.remoteAddress ?? "unknown";
    const now = Date.now();
    const record = hits.get(key);

    if (!record || now > record.resetTime) {
      hits.set(key, { count: 1, resetTime: now + windowMs });
      next();
      return;
    }

    record.count++;
    if (record.count > max) {
      res.status(429).json({ error: "Too many requests, please try again later" });
      return;
    }
    next();
  };
}

const API_KEY_HEADERS: Record<string, string> = {
  "x-openai-api-key": "openai",
  "x-google-api-key": "google",
  "x-anthropic-api-key": "anthropic",
  "x-api-key": "_generic",
};

function validateBody(
  body: unknown,
  fields: Record<string, "string" | "string?" | "object?">,
): Record<string, unknown> {
  if (!body || typeof body !== "object") throw new Error("Invalid request body");
  const result: Record<string, unknown> = {};
  for (const [key, type] of Object.entries(fields)) {
    const val = (body as Record<string, unknown>)[key];
    const isOptional = type.endsWith("?");
    const baseType = type.replace("?", "");
    if (val === undefined || val === null) {
      if (!isOptional) throw new Error(`Missing required field: ${key}`);
      continue;
    }
    if (baseType === "string" && typeof val !== "string") throw new Error(`Field ${key} must be a string`);
    if (baseType === "object" && typeof val !== "object") throw new Error(`Field ${key} must be an object`);
    result[key] = val;
  }
  return result;
}

function extractApiKey(req: any, agent: any): string | undefined {
  for (const [header, provider] of Object.entries(API_KEY_HEADERS)) {
    const value = req.headers[header];
    if (value && (provider === "_generic" || provider === agent.providerId)) {
      return value;
    }
  }
  return req.body?.apiKey ?? undefined;
}

export function createAgentRouter(opts: RouterOptions) {
  if (opts.serve?.length) {
    const discovered = classifyServables(opts.serve);
    opts = {
      ...opts,
      agents: { ...discovered.agents, ...opts.agents },
      teams: { ...discovered.teams, ...opts.teams },
      workflows: { ...discovered.workflows, ...opts.workflows },
    };
  }

  const reg: Registry | null = opts.registry === false ? null : (opts.registry ?? globalRegistry);

  let express: any;
  try {
    express = _require("express");
  } catch {
    throw new Error("express is required for createAgentRouter. Install it: npm install express");
  }

  const router = express.Router();

  if (opts.cors) {
    router.use(corsMiddleware(opts.cors));
  }

  if (opts.rateLimit) {
    const config = opts.rateLimit === true ? {} : opts.rateLimit;
    router.use(rateLimitMiddleware(config));
  }

  if (opts.jwt) {
    router.use(createJwtMiddleware(opts.jwt));
  }

  if (opts.rbac) {
    router.use(createRbacMiddleware(opts.rbac));
  }

  if (opts.middleware) {
    for (const mw of opts.middleware) {
      router.use(mw);
    }
  }

  // ── File upload middleware (lazy-initialized) ───────────────────────────
  let uploadMiddleware: any = null;
  if (opts.fileUpload) {
    const uploadOpts = typeof opts.fileUpload === "object" ? opts.fileUpload : {};
    uploadMiddleware = createFileUploadMiddleware(uploadOpts);
  }

  function withUpload(handler: (req: any, res: any) => Promise<void>) {
    if (!uploadMiddleware) return handler;
    return (req: any, res: any, next: any) => {
      uploadMiddleware(req, res, (err: any) => {
        if (err) {
          return res.status(400).json({ error: err.message });
        }
        handler(req, res).catch(next);
      });
    };
  }

  // ── Swagger UI ──────────────────────────────────────────────────────────
  if (opts.swagger?.enabled) {
    const spec = generateOpenAPISpec(opts, opts.swagger);
    const docsPath = opts.swagger.docsPath ?? "/docs";
    const specPath = opts.swagger.specPath ?? "/docs/spec.json";

    router.get(specPath, (_req: any, res: any) => {
      res.json(spec);
    });

    try {
      const { serve, setup } = serveSwaggerUI(spec);
      router.use(docsPath, serve, setup);
    } catch (e: any) {
      console.warn(`[agentium:transport] Swagger UI disabled: ${e.message}`);
    }
  }

  // ── Agent endpoints ─────────────────────────────────────────────────────
  if (opts.agents) {
    for (const [name, agent] of Object.entries(opts.agents)) {
      router.post(
        `/agents/${name}/run`,
        withUpload(async (req: any, res: any) => {
          try {
            const validated = validateBody(req.body, {
              input: "string",
              sessionId: "string?",
              userId: "string?",
            });
            const input = buildMultiModalInput(req.body, req.files) ?? validated.input;
            if (!input) {
              return res.status(400).json({ error: "input is required" });
            }

            const sessionId = validated.sessionId as string | undefined;
            const userId = validated.userId as string | undefined;
            const apiKey = extractApiKey(req, agent);
            const result = await agent.run(input, { sessionId, userId, apiKey });
            res.json(result);
          } catch (error: any) {
            res.status(400).json({ error: error.message });
          }
        }),
      );

      router.post(`/agents/${name}/stream`, async (req: any, res: any) => {
        try {
          const validated = validateBody(req.body, {
            input: "string",
            sessionId: "string?",
            userId: "string?",
          });
          const input = validated.input as string;
          if (!input) {
            return res.status(400).json({ error: "input is required" });
          }

          const sessionId = validated.sessionId as string | undefined;
          const userId = validated.userId as string | undefined;
          const apiKey = extractApiKey(req, agent);

          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          const stream = agent.stream(input, { sessionId, userId, apiKey });
          for await (const chunk of stream) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }

          res.write("data: [DONE]\n\n");
          res.end();
        } catch (error: any) {
          if (!res.headersSent) {
            res.status(500).json({ error: error.message });
          } else {
            res.write(`data: ${JSON.stringify({ type: "error", error: error.message })}\n\n`);
            res.end();
          }
        }
      });

      router.post(`/agents/${name}/corrections`, async (req: any, res: any) => {
        try {
          const memory = (agent as any).memory;
          if (!memory || !memory.getCorrectionStore?.()) {
            return res.status(404).json({
              error: `Corrections are not enabled for agent "${name}". Configure memory.corrections with a vectorStore.`,
            });
          }

          const validated = validateBody(req.body, {
            originalValue: "string",
            correctedValue: "string",
            field: "string?",
            reason: "string?",
            entityKey: "string?",
            runId: "string?",
            sessionId: "string?",
            userId: "string?",
            tenantId: "string?",
            scope: "string?",
            originalInput: "string?",
          });

          const correction = await memory.recordCorrection({
            agentName: name,
            runId: validated.runId,
            sessionId: validated.sessionId,
            originalInput: validated.originalInput,
            field: validated.field,
            originalValue: validated.originalValue,
            correctedValue: validated.correctedValue,
            reason: validated.reason,
            entityKey: validated.entityKey,
            tags: Array.isArray(req.body?.tags) ? req.body.tags : undefined,
            scope: validated.scope,
            userId: validated.userId,
            tenantId: validated.tenantId,
          });

          res.status(201).json(correction);
        } catch (error: any) {
          res.status(400).json({ error: error.message });
        }
      });
    }
  }

  // ── Team endpoints ──────────────────────────────────────────────────────
  if (opts.teams) {
    for (const [name, team] of Object.entries(opts.teams)) {
      router.post(`/teams/${name}/run`, async (req: any, res: any) => {
        try {
          const validated = validateBody(req.body, {
            input: "string",
            sessionId: "string?",
            userId: "string?",
          });
          const input = validated.input as string;
          if (!input) {
            return res.status(400).json({ error: "input is required" });
          }

          const sessionId = validated.sessionId as string | undefined;
          const userId = validated.userId as string | undefined;
          const apiKey = req.headers["x-api-key"] ?? req.body?.apiKey;
          const result = await team.run(input, { sessionId, userId, apiKey });
          res.json(result);
        } catch (error: any) {
          res.status(500).json({ error: error.message });
        }
      });

      router.post(`/teams/${name}/stream`, async (req: any, res: any) => {
        try {
          const validated = validateBody(req.body, {
            input: "string",
            sessionId: "string?",
            userId: "string?",
          });
          const input = validated.input as string;
          if (!input) {
            return res.status(400).json({ error: "input is required" });
          }

          const sessionId = validated.sessionId as string | undefined;
          const userId = validated.userId as string | undefined;
          const apiKey = req.headers["x-api-key"] ?? req.body?.apiKey;

          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          const stream = team.stream(input, { sessionId, userId, apiKey });
          for await (const chunk of stream) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }

          res.write("data: [DONE]\n\n");
          res.end();
        } catch (error: any) {
          if (!res.headersSent) {
            res.status(500).json({ error: error.message });
          } else {
            res.write(`data: ${JSON.stringify({ type: "error", error: error.message })}\n\n`);
            res.end();
          }
        }
      });
    }
  }

  // ── Workflow endpoints ──────────────────────────────────────────────────
  if (opts.workflows) {
    for (const [name, workflow] of Object.entries(opts.workflows)) {
      router.post(`/workflows/${name}/run`, async (req: any, res: any) => {
        try {
          const { sessionId, userId } = req.body ?? {};
          const result = await workflow.run({ sessionId, userId });
          res.json(result);
        } catch (error: any) {
          res.status(500).json({ error: error.message });
        }
      });
    }
  }

  // ── Dynamic registry routes (live auto-discovery) ──────────────────────
  if (reg) {
    router.post(
      "/agents/:name/run",
      withUpload(async (req: any, res: any) => {
        const agent = reg.getAgent(req.params.name);
        if (!agent) return res.status(404).json({ error: `Agent "${req.params.name}" not found` });
        try {
          const validated = validateBody(req.body, { input: "string", sessionId: "string?", userId: "string?" });
          const input = buildMultiModalInput(req.body, req.files) ?? validated.input;
          if (!input) return res.status(400).json({ error: "input is required" });
          const apiKey = extractApiKey(req, agent);
          const result = await agent.run(input, {
            sessionId: validated.sessionId as string | undefined,
            userId: validated.userId as string | undefined,
            apiKey,
          });
          res.json(result);
        } catch (error: any) {
          res.status(400).json({ error: error.message });
        }
      }),
    );

    router.post("/agents/:name/stream", async (req: any, res: any) => {
      const agent = reg.getAgent(req.params.name);
      if (!agent) return res.status(404).json({ error: `Agent "${req.params.name}" not found` });
      try {
        const validated = validateBody(req.body, { input: "string", sessionId: "string?", userId: "string?" });
        const input = validated.input as string;
        if (!input) return res.status(400).json({ error: "input is required" });
        const apiKey = extractApiKey(req, agent);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        for await (const chunk of agent.stream(input, {
          sessionId: validated.sessionId as string | undefined,
          userId: validated.userId as string | undefined,
          apiKey,
        })) {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      } catch (error: any) {
        if (!res.headersSent) res.status(500).json({ error: error.message });
        else {
          res.write(`data: ${JSON.stringify({ type: "error", error: error.message })}\n\n`);
          res.end();
        }
      }
    });

    router.post("/teams/:name/run", async (req: any, res: any) => {
      const team = reg.getTeam(req.params.name);
      if (!team) return res.status(404).json({ error: `Team "${req.params.name}" not found` });
      try {
        const validated = validateBody(req.body, { input: "string", sessionId: "string?", userId: "string?" });
        const input = validated.input as string;
        if (!input) return res.status(400).json({ error: "input is required" });
        const apiKey = req.headers["x-api-key"] ?? req.body?.apiKey;
        const result = await team.run(input, {
          sessionId: validated.sessionId as string | undefined,
          userId: validated.userId as string | undefined,
          apiKey,
        });
        res.json(result);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    router.post("/teams/:name/stream", async (req: any, res: any) => {
      const team = reg.getTeam(req.params.name);
      if (!team) return res.status(404).json({ error: `Team "${req.params.name}" not found` });
      try {
        const validated = validateBody(req.body, { input: "string", sessionId: "string?", userId: "string?" });
        const input = validated.input as string;
        if (!input) return res.status(400).json({ error: "input is required" });
        const apiKey = req.headers["x-api-key"] ?? req.body?.apiKey;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        for await (const chunk of team.stream(input, {
          sessionId: validated.sessionId as string | undefined,
          userId: validated.userId as string | undefined,
          apiKey,
        })) {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      } catch (error: any) {
        if (!res.headersSent) res.status(500).json({ error: error.message });
        else {
          res.write(`data: ${JSON.stringify({ type: "error", error: error.message })}\n\n`);
          res.end();
        }
      }
    });

    router.post("/workflows/:name/run", async (req: any, res: any) => {
      const workflow = reg.getWorkflow(req.params.name);
      if (!workflow) return res.status(404).json({ error: `Workflow "${req.params.name}" not found` });
      try {
        const { sessionId, userId } = req.body ?? {};
        const result = await workflow.run({ sessionId, userId });
        res.json(result);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    router.get("/agents", (_req: any, res: any) => {
      res.json(reg.describeAgents());
    });

    router.get("/teams", (_req: any, res: any) => {
      res.json(reg.describeTeams());
    });

    router.get("/workflows", (_req: any, res: any) => {
      res.json(reg.describeWorkflows());
    });

    router.get("/registry", (_req: any, res: any) => {
      res.json(reg.list());
    });

    // ── Agent Discovery Cards (A2A) ──────────────────────────────────
    router.get("/agents/:name/card", (req: any, res: any) => {
      const r = reg as any;
      if (typeof r.getAgentCard !== "function") return res.status(501).json({ error: "Discovery cards not available" });
      const card = r.getAgentCard(req.params.name);
      if (!card) return res.status(404).json({ error: `Agent "${req.params.name}" not found` });
      res.json(card);
    });

    router.get("/.well-known/agent-cards.json", (_req: any, res: any) => {
      const r = reg as any;
      if (typeof r.getAllAgentCards !== "function") return res.json([]);
      res.json(r.getAllAgentCards());
    });

    // ── Approval gate endpoints ────────────────────────────────────────
    router.get("/approvals/pending", (_req: any, res: any) => {
      const pending: any[] = [];
      for (const agent of reg.agents.values()) {
        const mgr = (agent as any).approvalManager;
        if (mgr && typeof mgr.listPending === "function") {
          pending.push(...mgr.listPending());
        }
      }
      res.json(pending);
    });

    router.post("/approvals/:requestId/approve", (req: any, res: any) => {
      const { requestId } = req.params;
      const { reason } = req.body ?? {};
      for (const agent of reg.agents.values()) {
        const mgr = (agent as any).approvalManager;
        if (mgr && typeof mgr.approve === "function") {
          mgr.approve(requestId, reason);
        }
      }
      res.json({ status: "approved", requestId });
    });

    router.post("/approvals/:requestId/deny", (req: any, res: any) => {
      const { requestId } = req.params;
      const { reason } = req.body ?? {};
      for (const agent of reg.agents.values()) {
        const mgr = (agent as any).approvalManager;
        if (mgr && typeof mgr.deny === "function") {
          mgr.deny(requestId, reason);
        }
      }
      res.json({ status: "denied", requestId });
    });

    // ── Checkpoint endpoints ──────────────────────────────────────────
    router.get("/agents/:name/checkpoints", async (req: any, res: any) => {
      const agent = reg.getAgent(req.params.name);
      if (!agent) return res.status(404).json({ error: `Agent "${req.params.name}" not found` });
      const checkpointMgr = (agent as any).checkpointManager ?? (agent as any).config?._checkpointManager;
      if (!checkpointMgr) return res.json([]);
      const runId = req.query.runId as string;
      if (!runId) return res.status(400).json({ error: "runId query param required" });
      try {
        const checkpoints = await checkpointMgr.list(runId);
        res.json(checkpoints);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    router.post("/agents/:name/rollback/:checkpointId", async (req: any, res: any) => {
      const agent = reg.getAgent(req.params.name);
      if (!agent) return res.status(404).json({ error: `Agent "${req.params.name}" not found` });
      const checkpointMgr = (agent as any).checkpointManager ?? (agent as any).config?._checkpointManager;
      if (!checkpointMgr) return res.status(400).json({ error: "Checkpointing not enabled for this agent" });
      try {
        const checkpoint = await checkpointMgr.rollback(req.params.checkpointId);
        if (!checkpoint) return res.status(404).json({ error: "Checkpoint not found" });
        res.json(checkpoint);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    router.get("/approvals/stream", (req: any, res: any) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const listener = (data: any) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };
      for (const agent of reg.agents.values()) {
        agent.eventBus?.on("tool.approval.request", listener);
      }
      req.on("close", () => {
        for (const agent of reg.agents.values()) {
          agent.eventBus?.off("tool.approval.request", listener);
        }
      });
    });
  }

  // ── Schedule management routes ──────────────────────────────────────
  if (opts.scheduler) {
    const queue = opts.scheduler;

    router.get("/schedules", async (_req: any, res: any) => {
      try {
        const schedules = await queue.listSchedules();
        res.json(schedules);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    router.post("/schedules", async (req: any, res: any) => {
      try {
        const { id, cron, timezone, agent, workflow } = req.body;
        if (!id || !cron) return res.status(400).json({ error: "id and cron are required" });
        const result = await queue.schedule({ id, cron, timezone, agent, workflow });
        res.status(201).json(result);
      } catch (err: any) {
        res.status(400).json({ error: err.message });
      }
    });

    router.delete("/schedules/:id", async (req: any, res: any) => {
      try {
        await queue.unschedule(req.params.id);
        res.json({ status: "unscheduled", id: req.params.id });
      } catch (err: any) {
        res.status(404).json({ error: err.message });
      }
    });
  }

  // ── Metrics endpoints ──────────────────────────────────────────────
  if (opts.metricsExporter) {
    const exporter = opts.metricsExporter;

    router.get("/metrics", (_req: any, res: any) => {
      res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      res.send(exporter.toPrometheus());
    });

    router.get("/metrics/json", (req: any, res: any) => {
      const agent = req.query.agent as string | undefined;
      if (agent) {
        res.json(exporter.getMetrics(agent));
      } else {
        res.json(exporter.toJSON());
      }
    });

    router.get("/metrics/stream", (req: any, res: any) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const handler = (event: any) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      const subscribers = (exporter as any).subscribers as Set<(e: any) => void>;
      subscribers.add(handler);
      req.on("close", () => {
        subscribers.delete(handler);
      });
    });
  }

  // ── Admin routes (MCP management, toolkit catalog) ─────────────────
  if (opts.admin) {
    const adminOpts = typeof opts.admin === "object" ? opts.admin : {};
    const { router: adminRouter } = createAdminRouter({
      mcpManager: adminOpts.mcpManager,
      middleware: adminOpts.middleware ?? opts.middleware,
    });
    router.use("/admin", adminRouter);
  }

  // ── Tools listing ──────────────────────────────────────────────────
  const fromToolkits = opts.toolkits ? collectToolkitTools(opts.toolkits) : {};
  const mergedTools = { ...fromToolkits, ...(opts.toolLibrary ?? {}) };

  if (Object.keys(mergedTools).length > 0) {
    router.get("/tools", (_req: any, res: any) => {
      res.json(describeToolLibrary(mergedTools));
    });

    router.get("/tools/:name", (req: any, res: any) => {
      const tool = mergedTools[req.params.name];
      if (!tool) return res.status(404).json({ error: `Tool "${req.params.name}" not found` });
      res.json({
        name: tool.name,
        description: tool.description,
        parameters: Object.keys(tool.parameters.shape ?? {}),
      });
    });
  }

  return router;
}
