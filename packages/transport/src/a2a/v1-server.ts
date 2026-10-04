import { createHash, randomUUID } from "node:crypto";
import type { A2AV1Card, Agent, MessageContent, RunOutput } from "@agentium/core";
import type { Express, Request } from "express";

export interface A2AV1Identity {
  tenantId: string;
  userId: string;
}
export interface A2AV1ServerOptions {
  agents: Record<string, Pick<Agent, "name" | "run">>;
  /** Absolute URL of this JSON-RPC endpoint. */
  url: string;
  basePath?: string;
  cardPath?: string;
  /** Passed to the host verifier; the verifier must validate token audience. */
  audience: string;
  authenticate: (request: Request, audience: string) => Promise<A2AV1Identity | null>;
  maxTasks?: number;
  /** Local history retention and follow-up admission bound; default 128. */
  maxHistoryMessages?: number;
  /** Domain-specific interrupted results remain distinguishable from success. */
  completionState?: (
    output: RunOutput,
  ) => "TASK_STATE_COMPLETED" | "TASK_STATE_INPUT_REQUIRED" | "TASK_STATE_AUTH_REQUIRED" | "TASK_STATE_FAILED";
}

/** A2A 1.0 JSON-RPC using the optional official SDK. Local task state is
 * process-local and ownership-scoped; this adapter does not promise recovery. */
export async function createA2AV1Server(app: Express, options: A2AV1ServerOptions): Promise<{ card: A2AV1Card }> {
  const sdk = await import("@a2a-js/sdk");
  const server = await import("@a2a-js/sdk/server");
  const http = await import("@a2a-js/sdk/server/express");
  const errors = await import("@a2a-js/sdk/errors");
  const { json } = await import("express");
  if (!options.audience || typeof options.authenticate !== "function")
    throw new Error("A2A requires a host identity verifier and audience");
  const endpoint = new URL(options.url);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password)
    throw new Error("Invalid A2A endpoint URL");
  const maxTasks = options.maxTasks ?? 10_000;
  if (!Number.isInteger(maxTasks) || maxTasks <= 0) throw new Error("maxTasks must be a positive integer");
  const maxHistoryMessages = options.maxHistoryMessages ?? 128;
  if (!Number.isInteger(maxHistoryMessages) || maxHistoryMessages <= 0)
    throw new Error("maxHistoryMessages must be a positive integer");
  const agents = { ...options.agents };
  const names = Object.keys(agents);
  if (!names.length) throw new Error("At least one A2A agent is required");
  const card = sdk.AgentCard.fromJSON({
    name: names.length === 1 ? agents[names[0]].name : "Agentium agents",
    description: "Agentium A2A 1.0 endpoint",
    version: "3.2.0",
    supportedInterfaces: [{ url: options.url, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ["text/plain", "application/json", "image/png", "image/jpeg", "image/webp"],
    defaultOutputModes: ["text/plain", "application/json"],
    securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } } },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    skills: names.map((name) => ({
      id: name,
      name: agents[name].name,
      description: `Run ${name}`,
      tags: ["agentium"],
    })),
  });
  const memoryStore = new server.InMemoryTaskStore();
  const knownTasks = new Set<string>();
  const taskStore: import("@a2a-js/sdk/server").TaskStore = {
    load: (id, context) => memoryStore.load(id, context),
    list: (params, context) => memoryStore.list(params, context),
    async save(task, context) {
      // Bound the actual SDK store, including tasks synthesized for errors.
      if (!knownTasks.has(task.id) && knownTasks.size >= maxTasks)
        throw new errors.UnsupportedOperationError("A2A local task capacity reached");
      knownTasks.add(task.id);
      await memoryStore.save({ ...task, history: task.history.slice(-maxHistoryMessages) }, context);
    },
  };
  const sessions = new Set<string>();
  const admissions = new Set<string>();
  let pendingNewTasks = 0;
  const active = new Map<string, { controller: AbortController; done: Promise<void>; contextId: string }>();
  const identityKey = (identity: A2AV1Identity) => JSON.stringify([identity.tenantId, identity.userId]);
  const sessionKey = (identity: A2AV1Identity, contextId: string) =>
    createHash("sha256")
      .update(JSON.stringify([[identity.tenantId, identity.userId], contextId]))
      .digest("hex");
  const executor: import("@a2a-js/sdk/server").AgentExecutor = {
    async execute(request, bus) {
      const { taskId, contextId } = request;
      const identity = JSON.parse(request.context.user!.userName) as [string, string];
      const sessionId = sessionKey({ tenantId: identity[0], userId: identity[1] }, contextId);
      const task =
        request.task ??
        sdk.Task.fromJSON({
          id: taskId,
          contextId,
          status: { state: "TASK_STATE_SUBMITTED" },
          history: [sdk.Message.toJSON(request.userMessage)],
        });
      if (sessions.has(sessionId) || active.has(taskId)) throw new Error("A writer already owns this A2A session");
      sessions.add(sessionId);
      bus.publish(server.AgentEvent.task(task));
      const controller = new AbortController();
      let release!: () => void;
      const done = new Promise<void>((resolve) => {
        release = resolve;
      });
      active.set(taskId, { controller, done, contextId });
      const status = (state: string, message?: unknown) =>
        bus.publish(
          server.AgentEvent.statusUpdate(
            sdk.TaskStatusUpdateEvent.fromJSON({
              taskId,
              contextId,
              status: { state, message, timestamp: new Date().toISOString() },
            }),
          ),
        );
      try {
        const name = request.userMessage.metadata?.agentName ?? (names.length === 1 ? names[0] : undefined);
        if (typeof name !== "string" || !Object.hasOwn(agents, name))
          throw new Error("An exact registered agentName is required");
        if (request.userMessage.role !== sdk.Role.ROLE_USER) throw new Error("A user message is required");
        const parts: Exclude<MessageContent, string> = [];
        for (const part of request.userMessage.parts) {
          if (part.content?.$case === "text") parts.push({ type: "text", text: part.content.value });
          else if (part.content?.$case === "data")
            parts.push({ type: "text", text: JSON.stringify({ source: "a2a:user-data", data: part.content.value }) });
          else if (
            ["image/png", "image/jpeg", "image/webp"].includes(part.mediaType) &&
            (part.content?.$case === "raw" || part.content?.$case === "url")
          ) {
            parts.push({
              type: "image",
              data:
                part.content.$case === "url" ? part.content.value : Buffer.from(part.content.value).toString("base64"),
              mimeType: part.mediaType as "image/png" | "image/jpeg" | "image/webp",
            });
          } else throw new errors.ContentTypeNotSupportedError();
        }
        status("TASK_STATE_WORKING");
        const output = await agents[name].run(parts, {
          sessionId,
          tenantId: identity[0],
          userId: identity[1],
          signal: controller.signal,
          metadata: { a2aTaskId: taskId, a2aContextId: contextId },
        });
        if (controller.signal.aborted || output.status === "cancelled") status("TASK_STATE_CANCELED");
        else {
          const state =
            output.status && output.status !== "completed"
              ? "TASK_STATE_FAILED"
              : (options.completionState?.(output) ?? "TASK_STATE_COMPLETED");
          const response = {
            messageId: randomUUID(),
            role: "ROLE_AGENT",
            taskId,
            contextId,
            parts: [{ text: output.text }],
          };
          if (output.structured !== undefined)
            bus.publish(
              server.AgentEvent.artifactUpdate(
                sdk.TaskArtifactUpdateEvent.fromJSON({
                  taskId,
                  contextId,
                  lastChunk: true,
                  append: false,
                  artifact: {
                    artifactId: randomUUID(),
                    name: "structured-result",
                    parts: [{ data: output.structured, mediaType: "application/json" }],
                  },
                }),
              ),
            );
          status(state, response);
        }
      } catch {
        status(controller.signal.aborted ? "TASK_STATE_CANCELED" : "TASK_STATE_FAILED", {
          messageId: randomUUID(),
          role: "ROLE_AGENT",
          taskId,
          contextId,
          parts: [{ text: controller.signal.aborted ? "Cancellation acknowledged" : "Agent execution failed" }],
        });
      } finally {
        active.delete(taskId);
        sessions.delete(sessionId);
        release();
        bus.finished();
      }
    },
    async cancelTask(taskId) {
      const run = active.get(taskId);
      if (!run) throw new errors.TaskNotCancelableError();
      run.controller.abort(new Error("A2A cancellation requested"));
      // The terminal event is emitted by execute after owned work acknowledges
      // cancellation. A late result cannot overwrite it as completed.
      await run.done;
    },
  };
  const handler = new server.DefaultRequestHandler(
    card,
    taskStore,
    executor,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { validateInputModes: true },
  );
  const identities = new WeakMap<Request, A2AV1Identity>();
  const basePath = options.basePath ?? endpoint.pathname;
  app.use(options.cardPath ?? "/.well-known/agent-card.json", http.agentCardHandler({ agentCardProvider: handler }));
  app.use(basePath, json({ limit: "1mb" }));
  app.use(basePath, async (req, res, next) => {
    try {
      const identity = await options.authenticate(req, options.audience);
      if (!identity?.tenantId || !identity.userId) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      if (req.body?.params?.tenant && req.body.params.tenant !== identity.tenantId) {
        res.status(403).json({ error: "Tenant mismatch" });
        return;
      }
      identities.set(req, Object.freeze({ ...identity }));
      next();
    } catch {
      res.status(401).json({ error: "Authentication failed" });
    }
  });
  app.use(basePath, async (req, res, next) => {
    if (["message/send", "message/stream"].includes(req.body?.method)) {
      res.status(400).json({ error: "Use A2A 1.0 methods on this endpoint; configure the legacy adapter separately" });
      return;
    }
    if (!["SendMessage", "SendStreamingMessage"].includes(req.body?.method)) return next();
    const message = req.body?.params?.message;
    if (!message || typeof message !== "object") return next();
    const reject = (status: number, error: string) => {
      res.status(status).json({ error });
    };
    // Validate file parts before the SDK allocates a task or appends history.
    for (const part of Array.isArray(message.parts) ? message.parts : []) {
      if (part.raw !== undefined || part.url !== undefined) {
        if (!["image/png", "image/jpeg", "image/webp"].includes(part.mediaType))
          return reject(415, "Unsupported image media type");
        if (part.url !== undefined) {
          try {
            const url = new URL(part.url);
            if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
              return reject(415, "Image URLs must use HTTP(S) without credentials; use raw for inline bytes");
          } catch {
            return reject(415, "Invalid image URL");
          }
        }
      }
    }
    try {
      const identity = identities.get(req)!;
      const context = new server.ServerCallContext({
        tenant: identity.tenantId,
        user: { isAuthenticated: true, userName: identityKey(identity) },
      });
      const existing = message.taskId ? await taskStore.load(message.taskId, context) : undefined;
      if (message.taskId && !existing) return reject(404, "Task not found");
      if (existing && existing.history.length >= maxHistoryMessages)
        return reject(429, "Task history capacity reached");
      const contextId = message.contextId || existing?.contextId;
      const key = contextId ? sessionKey(identity, contextId) : undefined;
      if ((key && (admissions.has(key) || sessions.has(key))) || (message.taskId && active.has(message.taskId)))
        return reject(409, "A writer already owns this A2A session");
      if (!existing && knownTasks.size + pendingNewTasks >= maxTasks)
        return reject(429, "A2A local task capacity reached");
      if (!existing) pendingNewTasks++;
      if (key) admissions.add(key);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        if (!existing) pendingNewTasks--;
        if (key) admissions.delete(key);
      };
      res.once("finish", release);
      res.once("close", release);
      next();
    } catch {
      reject(400, "Invalid A2A request");
    }
  });
  app.use(
    basePath,
    http.jsonRpcHandler({
      requestHandler: handler,
      userBuilder: async (req) => ({ isAuthenticated: true, userName: identityKey(identities.get(req)!) }),
      contextBuilder: (opts) => {
        const [tenant] = JSON.parse(opts.user!.userName) as [string, string];
        if (opts.tenant && opts.tenant !== tenant) throw new Error("Tenant mismatch");
        return new server.ServerCallContext({
          user: opts.user,
          tenant,
          requestedVersion: opts.requestedVersion,
          requestedExtensions: opts.extensions,
        });
      },
    }),
  );
  return { card: sdk.AgentCard.toJSON(card) as A2AV1Card };
}
