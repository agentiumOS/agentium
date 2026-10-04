import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { Registry } from "@agentium/core";
import {
  classifyServables,
  collectToolkitTools,
  describeToolLibrary,
  registry as globalRegistry,
  schemaShape,
} from "@agentium/core";
import { responseLifetime, serveTextStream, textStreamLimits } from "../text-stream.js";
import { createAdminRouter } from "./admin-router.js";
import { buildMultiModalInput, createFileUploadMiddleware } from "./file-upload.js";
import { createJwtMiddleware } from "./jwt-middleware.js";
import { createRbacMiddleware, routeMatches } from "./rbac-middleware.js";
import { generateOpenAPISpec, serveSwaggerUI } from "./swagger.js";
import type { HostedIdentity, HostedResourceRequest, RouterOptions } from "./types.js";

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
  textStreamLimits(opts?.textStream);
  const security = opts?.security;
  if (!security || !["local", "authenticated"].includes(security.mode))
    throw new Error('createAgentRouter requires explicit security: { mode: "local" } or authenticated host hooks');
  const authenticated = security.mode === "authenticated";
  if (
    (!authenticated && (opts.jwt || opts.rbac)) ||
    (authenticated &&
      (typeof security.resolveIdentity !== "function" || typeof security.authorizeResource !== "function"))
  )
    throw new Error("Authenticated routers require security.resolveIdentity and security.authorizeResource");

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

  const router = express.Router({ caseSensitive: true });

  if (opts.cors) {
    router.use(corsMiddleware(opts.cors));
  }

  if (opts.rateLimit) {
    const config = opts.rateLimit === true ? {} : opts.rateLimit;
    router.use(rateLimitMiddleware(config));
  }

  const publicRequest = (req: any) =>
    opts.rbac?.publicRoutes?.some((pattern) => routeMatches(`${req.method} ${req.path}`, pattern)) ?? false;
  // Host middleware may verify external credentials and populate req.user.
  for (const mw of opts.middleware ?? []) router.use(mw);
  if (opts.jwt) {
    const verifyJwt = createJwtMiddleware(opts.jwt);
    router.use((req: any, res: any, next: any) => (publicRequest(req) ? next() : verifyJwt(req, res, next)));
  }
  if (opts.rbac) router.use(createRbacMiddleware(opts.rbac));

  async function permitted(req: any, operation: string, resource: HostedResourceRequest["resource"]): Promise<boolean> {
    if (!authenticated) return true;
    if (security?.mode !== "authenticated" || !req.agentiumIdentity) return false;
    return (await security.authorizeResource({ identity: req.agentiumIdentity, operation, resource })) === true;
  }
  function executionOptions(req: any) {
    return authenticated
      ? { sessionId: req.agentiumSessionId, ...(req.agentiumIdentity as HostedIdentity) }
      : { sessionId: req.body?.sessionId, userId: req.body?.userId, tenantId: req.body?.tenantId };
  }
  async function authorizeExecution(req: any, res: any, name: string) {
    const supplied = req.body?.sessionId;
    if (supplied !== undefined && (typeof supplied !== "string" || !supplied)) throw new Error("Invalid sessionId");
    req.agentiumSessionId = supplied ?? randomUUID();
    if (
      !(await permitted(req, supplied ? "session:use" : "session:create", {
        kind: "session",
        id: req.agentiumSessionId,
        agentName: name,
      }))
    )
      throw new Error("Resource access denied");
    res.setHeader("X-Agentium-Session-Id", req.agentiumSessionId);
  }
  if (authenticated)
    router.use(async (req: any, res: any, next: any) => {
      try {
        if (!req.user) {
          // Public listings/docs may omit identity. Resource controls still require it below.
          if (
            publicRequest(req) &&
            req.method === "GET" &&
            !/^\/(approvals|schedules|admin)(?:\/|$)/.test(req.path) &&
            !req.path.includes("/checkpoints")
          )
            return next();
          return res.status(401).json({ error: "Authentication required" });
        }
        const identity = security?.mode === "authenticated" ? await security.resolveIdentity(req.user) : null;
        if (
          !identity ||
          typeof identity.userId !== "string" ||
          !identity.userId ||
          (identity.tenantId !== undefined && (typeof identity.tenantId !== "string" || !identity.tenantId))
        ) {
          return res.status(401).json({ error: "Verified identity required" });
        }
        req.agentiumIdentity = Object.freeze({ userId: identity.userId, tenantId: identity.tenantId });
        for (const key of ["userId", "tenantId"]) {
          if (req.body?.[key] !== undefined && req.body[key] !== req.agentiumIdentity[key]) {
            return res.status(403).json({ error: "Request identity does not match verified identity" });
          }
        }
        const requireResource = async (operation: string, resource: HostedResourceRequest["resource"]) => {
          if (!(await permitted(req, operation, resource))) throw new Error("Resource access denied");
        };
        const execution = /^\/(agents|teams|workflows)\/([^/]+)\/(run|stream)\/?$/.exec(req.path);
        if (
          execution &&
          !(opts.fileUpload && req.is?.("multipart/form-data") && execution[3] === "run" && execution[1] === "agents")
        ) {
          await authorizeExecution(req, res, decodeURIComponent(execution[2]));
        }
        const checkpoint = /^\/agents\/([^/]+)\/checkpoints\/?$/.exec(req.path);
        if (checkpoint) {
          if (typeof req.query.runId !== "string" || !req.query.runId)
            return res.status(400).json({ error: "runId query param required" });
          await requireResource("checkpoints:list", {
            kind: "run",
            id: req.query.runId,
            agentName: decodeURIComponent(checkpoint[1]),
          });
        }
        const rollback = /^\/agents\/([^/]+)\/rollback\/([^/]+)\/?$/.exec(req.path);
        if (rollback)
          await requireResource("checkpoint:restore", {
            kind: "checkpoint",
            id: decodeURIComponent(rollback[2]),
            agentName: decodeURIComponent(rollback[1]),
          });
        const approval = /^\/approvals\/([^/]+)\/(approve|deny)\/?$/.exec(req.path);
        if (approval)
          await requireResource(`approval:${approval[2]}`, { kind: "approval", id: decodeURIComponent(approval[1]) });
        const correction = /^\/agents\/([^/]+)\/corrections\/?$/.exec(req.path);
        if (correction) {
          const agentName = decodeURIComponent(correction[1]);
          await requireResource("correction:create", { kind: "correction", agentName, scope: req.body?.scope });
          for (const [key, kind] of [
            ["sessionId", "session"],
            ["runId", "run"],
          ] as const) {
            if (req.body?.[key] !== undefined) {
              if (typeof req.body[key] !== "string" || !req.body[key])
                return res.status(400).json({ error: `Invalid ${key}` });
              await requireResource(`${kind}:use`, { kind, id: req.body[key], agentName });
            }
          }
        }
        if (/^\/schedules(?:\/|$)/.test(req.path))
          await requireResource(
            req.method === "GET" ? "schedules:list" : req.method === "POST" ? "schedule:create" : "schedule:delete",
            {
              kind: "schedule",
              id: req.path.split("/")[2] ? decodeURIComponent(req.path.split("/")[2]) : req.body?.id,
            },
          );
        if (/^\/admin(?:\/|$)/.test(req.path))
          await requireResource(`admin:${req.method.toLowerCase()}`, { kind: "admin", id: req.path });
        next();
      } catch {
        res.status(403).json({ error: "Resource access denied" });
      }
    });

  // ── File upload middleware (lazy-initialized) ───────────────────────────
  let uploadMiddleware: any = null;
  if (opts.fileUpload) {
    const uploadOpts = typeof opts.fileUpload === "object" ? opts.fileUpload : {};
    uploadMiddleware = createFileUploadMiddleware(uploadOpts);
  }

  function withUpload(handler: (req: any, res: any) => Promise<void>) {
    if (!uploadMiddleware) return handler;
    return (req: any, res: any, next: any) => {
      uploadMiddleware(req, res, async (err: any) => {
        if (req.aborted || res.destroyed) return;
        if (err) {
          return res.status(400).json({ error: err.message });
        }
        try {
          if (authenticated && req.is?.("multipart/form-data")) {
            for (const key of ["userId", "tenantId"]) {
              if (req.body?.[key] !== undefined && req.body[key] !== req.agentiumIdentity?.[key]) {
                return res.status(403).json({ error: "Request identity does not match verified identity" });
              }
            }
            await authorizeExecution(req, res, decodeURIComponent(req.path.split("/")[2]));
          }
        } catch {
          return res.status(403).json({ error: "Resource access denied" });
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

  async function recordCorrection(req: any, res: any, agent: any, name: string) {
    try {
      const memory = (agent as any).memory;
      if (!memory?.getCorrectionStore?.()) {
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
        userId: executionOptions(req).userId,
        tenantId: executionOptions(req).tenantId,
      });

      res.status(201).json(correction);
    } catch (error: any) {
      if (!res.destroyed) res.status(400).json({ error: error.message });
    }
  }

  async function runResponse(res: any, run: (signal: AbortSignal) => Promise<unknown>) {
    const lifetime = responseLifetime(res);
    try {
      lifetime.controller.signal.throwIfAborted();
      const result = await run(lifetime.controller.signal);
      if (!res.destroyed && !lifetime.controller.signal.aborted) res.json(result);
    } finally {
      lifetime.dispose();
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
            const apiKey = extractApiKey(req, agent);
            await runResponse(res, (signal) => agent.run(input, { ...executionOptions(req), apiKey, signal }));
          } catch (error: any) {
            if (!res.destroyed) res.status(400).json({ error: error.message });
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
          const apiKey = extractApiKey(req, agent);

          await serveTextStream(
            res,
            (signal) => agent.stream(input, { ...executionOptions(req), apiKey, signal }),
            opts.textStream,
          );
        } catch (error: any) {
          if (!res.destroyed && !res.headersSent) res.status(500).json({ error: error.message });
          else if (!res.destroyed) res.destroy();
        }
      });

      router.post(`/agents/${name}/corrections`, (req: any, res: any) => recordCorrection(req, res, agent, name));
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
          const apiKey = req.headers["x-api-key"] ?? req.body?.apiKey;
          await runResponse(res, (signal) => team.run(input, { ...executionOptions(req), apiKey, signal }));
        } catch (error: any) {
          if (!res.destroyed) res.status(500).json({ error: error.message });
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
          const apiKey = req.headers["x-api-key"] ?? req.body?.apiKey;

          await serveTextStream(
            res,
            (signal) => team.stream(input, { ...executionOptions(req), apiKey, signal }),
            opts.textStream,
          );
        } catch (error: any) {
          if (!res.destroyed && !res.headersSent) res.status(500).json({ error: error.message });
          else if (!res.destroyed) res.destroy();
        }
      });
    }
  }

  // ── Workflow endpoints ──────────────────────────────────────────────────
  if (opts.workflows) {
    for (const [name, workflow] of Object.entries(opts.workflows)) {
      router.post(`/workflows/${name}/run`, async (req: any, res: any) => {
        try {
          await runResponse(res, (signal) => workflow.run({ ...executionOptions(req), signal }));
        } catch (error: any) {
          if (!res.destroyed) res.status(500).json({ error: error.message });
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
          await runResponse(res, (signal) => agent.run(input, { ...executionOptions(req), apiKey, signal }));
        } catch (error: any) {
          if (!res.destroyed) res.status(400).json({ error: error.message });
        }
      }),
    );

    router.post("/agents/:name/corrections", (req: any, res: any) => {
      const agent = reg.getAgent(req.params.name);
      if (!agent) return res.status(404).json({ error: "Agent not found" });
      return recordCorrection(req, res, agent, req.params.name);
    });

    router.post("/agents/:name/stream", async (req: any, res: any) => {
      const agent = opts.agents?.[req.params.name] ?? reg?.getAgent(req.params.name);
      if (!agent) return res.status(404).json({ error: `Agent "${req.params.name}" not found` });
      try {
        const validated = validateBody(req.body, { input: "string", sessionId: "string?", userId: "string?" });
        const input = validated.input as string;
        if (!input) return res.status(400).json({ error: "input is required" });
        const apiKey = extractApiKey(req, agent);
        await serveTextStream(
          res,
          (signal) => agent.stream(input, { ...executionOptions(req), apiKey, signal }),
          opts.textStream,
        );
      } catch (error: any) {
        if (!res.destroyed && !res.headersSent) res.status(500).json({ error: error.message });
        else if (!res.destroyed) res.destroy();
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
        await runResponse(res, (signal) => team.run(input, { ...executionOptions(req), apiKey, signal }));
      } catch (error: any) {
        if (!res.destroyed) res.status(500).json({ error: error.message });
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
        await serveTextStream(
          res,
          (signal) => team.stream(input, { ...executionOptions(req), apiKey, signal }),
          opts.textStream,
        );
      } catch (error: any) {
        if (!res.destroyed && !res.headersSent) res.status(500).json({ error: error.message });
        else if (!res.destroyed) res.destroy();
      }
    });

    router.post("/workflows/:name/run", async (req: any, res: any) => {
      const workflow = reg.getWorkflow(req.params.name);
      if (!workflow) return res.status(404).json({ error: `Workflow "${req.params.name}" not found` });
      try {
        await runResponse(res, (signal) => workflow.run({ ...executionOptions(req), signal }));
      } catch (error: any) {
        if (!res.destroyed) res.status(500).json({ error: error.message });
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
  }

  function allAgents() {
    return [...new Set([...Object.values(opts.agents ?? {}), ...(reg?.agents.values() ?? [])])];
  }

  // ── Approval gate endpoints ────────────────────────────────────────
  router.get("/approvals/pending", async (req: any, res: any) => {
    const pending: any[] = [];
    for (const agent of allAgents()) {
      const mgr = (agent as any).approvalManager;
      if (mgr && typeof mgr.listPending === "function") {
        for (const item of mgr.listPending()) {
          try {
            if (await permitted(req, "approval:read", { kind: "approval", id: item.requestId })) pending.push(item);
          } catch {
            /* Authorization failures are never disclosed as pending requests. */
          }
        }
      }
    }
    res.json(pending);
  });

  router.post("/approvals/:requestId/approve", (req: any, res: any) => {
    const { requestId } = req.params;
    for (const agent of allAgents()) {
      const mgr = (agent as any).approvalManager;
      if (mgr?.listPending().some((item: any) => item.requestId === requestId)) {
        mgr.approve(requestId, req.body?.reason);
        return res.json({ status: "approved", requestId });
      }
    }
    res.status(404).json({ error: "Approval request not found" });
  });

  router.post("/approvals/:requestId/deny", (req: any, res: any) => {
    const { requestId } = req.params;
    for (const agent of allAgents()) {
      const mgr = (agent as any).approvalManager;
      if (mgr?.listPending().some((item: any) => item.requestId === requestId)) {
        mgr.deny(requestId, req.body?.reason);
        return res.json({ status: "denied", requestId });
      }
    }
    res.status(404).json({ error: "Approval request not found" });
  });

  // ── Checkpoint endpoints ──────────────────────────────────────────
  router.get("/agents/:name/checkpoints", async (req: any, res: any) => {
    const agent = opts.agents?.[req.params.name] ?? reg?.getAgent(req.params.name);
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
    const agent = opts.agents?.[req.params.name] ?? reg?.getAgent(req.params.name);
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
    const listener = async (data: any) => {
      try {
        if (!res.destroyed && (await permitted(req, "approval:read", { kind: "approval", id: data.requestId }))) {
          if (!res.destroyed) res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
      } catch {
        /* Fail closed on authorizer errors. */
      }
    };
    const subscribedAgents = allAgents();
    for (const agent of subscribedAgents) {
      agent.eventBus?.on("tool.approval.request", listener);
    }
    req.on("close", () => {
      for (const agent of subscribedAgents) {
        agent.eventBus?.off("tool.approval.request", listener);
      }
    });
  });
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
      middleware:
        adminOpts.middleware ?? (authenticated ? [(_req: any, _res: any, next: any) => next()] : opts.middleware),
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
        parameters: Object.keys(schemaShape(tool.parameters)),
      });
    });
  }

  return router;
}
