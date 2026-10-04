import { createRequire } from "node:module";
import type { A2ARequestHandler, ServerCallContext } from "@a2a-js/sdk/server";
import type { DurableReader, DurableTaskRecord } from "@agentium/core";
import type { Request, Router } from "express";
import {
  admitTask,
  assertProtocolHost,
  DurableProtocolError,
  type DurableProtocolHost,
  type DurableProtocolPart,
  ownedTask,
  pendingApprovals,
  protocolId,
  protocolJSON,
  protocolObject,
  publicOutput,
  respondToApproval,
  wakeTask,
} from "../durable/protocol-host.js";

export interface DurableA2AV1ServerOptions extends DurableProtocolHost {
  name: string;
  /** Absolute public JSON-RPC URL; mount the returned router at its origin. */
  url: string;
  audience: string;
  authenticate(request: Request, audience: string): Promise<DurableReader | null>;
  cardPath?: string;
  /** Blocking SendMessage waits only this long; timeout does not cancel admitted work. */
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
}

/** Optional A2A 1.0 JSON-RPC bridge. Polling only; all state remains in the durable store. */
export async function createDurableA2AV1Server(options: DurableA2AV1ServerOptions): Promise<Router> {
  assertProtocolHost(options);
  protocolId(options.name);
  if (typeof options.authenticate !== "function" || !options.audience)
    throw new Error("Verified authentication and audience are required");
  const endpoint = new URL(options.url);
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("Invalid A2A endpoint");
  const waitMs = options.waitTimeoutMs ?? 30_000;
  const pollMs = options.pollIntervalMs ?? 100;
  if (![waitMs, pollMs].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 60_000))
    throw new Error("Wait intervals must be 1–60000ms");
  const [sdk, server, http, errors] = await Promise.all([
    import("@a2a-js/sdk"),
    import("@a2a-js/sdk/server"),
    import("@a2a-js/sdk/server/express"),
    import("@a2a-js/sdk/errors"),
  ]);
  const card = sdk.AgentCard.fromJSON({
    name: options.name,
    description: "Agentium durable task endpoint",
    version: "3.2.0",
    supportedInterfaces: [{ url: options.url, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } } },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    skills: [{ id: options.name, name: options.name, description: "Admit an owned durable task", tags: ["agentium"] }],
  });
  const identity = (context: ServerCallContext): DurableReader => {
    if (!context.user?.isAuthenticated) throw new errors.TaskNotFoundError();
    const [tenantId, actorId] = JSON.parse(context.user.userName) as [string, string];
    return { tenantId, actorId };
  };
  const safe = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof errors.A2AError) throw error;
      if (error instanceof DurableProtocolError) {
        if (error.code === "not-found") throw new errors.TaskNotFoundError();
        if (error.code === "invalid") throw new errors.RequestMalformedError(error.message);
        throw new errors.UnsupportedOperationError(error.message);
      }
      throw new errors.UnsupportedOperationError("Durable task operation failed");
    }
  };
  async function view(task: DurableTaskRecord, who: DurableReader) {
    const approvals = pendingApprovals(task, who);
    const state = {
      queued: "TASK_STATE_SUBMITTED",
      running: "TASK_STATE_WORKING",
      cancel_requested: "TASK_STATE_WORKING",
      awaiting_approval: approvals.length ? "TASK_STATE_INPUT_REQUIRED" : "TASK_STATE_WORKING",
      completed: "TASK_STATE_COMPLETED",
      canceled: "TASK_STATE_CANCELED",
      stopped: "TASK_STATE_FAILED",
      failed: "TASK_STATE_FAILED",
    }[task.state];
    const parts =
      state === "TASK_STATE_INPUT_REQUIRED"
        ? [{ data: { approvals: approvals.map(({ id, preparedHash }) => ({ approvalId: id, preparedHash })) } }]
        : [];
    const output = task.state === "completed" ? await publicOutput(options, who, task) : undefined;
    return sdk.Task.fromJSON(
      protocolJSON({
        id: task.id,
        contextId: task.identity.sessionId,
        status: {
          state,
          timestamp: new Date(task.updatedAt).toISOString(),
          ...(parts.length
            ? {
                message: {
                  messageId: `${task.id}:approval:${task.revision}`,
                  taskId: task.id,
                  contextId: task.identity.sessionId,
                  role: "ROLE_AGENT",
                  parts,
                },
              }
            : {}),
        },
        artifacts: output
          ? [
              {
                artifactId: `${task.id}:result`,
                parts: [
                  ...(output.text !== undefined ? [{ text: output.text }] : []),
                  ...(output.data !== undefined ? [{ data: output.data }] : []),
                ],
              },
            ]
          : [],
        metadata: {
          revision: task.revision,
          ...(output?.isError ? { resultIsError: true } : {}),
          ...(task.state === "cancel_requested" ? { cancellationRequested: true } : {}),
        },
      }),
    );
  }
  async function wait(task: DurableTaskRecord, who: DurableReader, immediate = false) {
    const deadline = Date.now() + waitMs;
    while (
      !immediate &&
      (["queued", "running", "cancel_requested"].includes(task.state) ||
        (task.state === "awaiting_approval" && !pendingApprovals(task, who).length))
    ) {
      if (Date.now() >= deadline)
        throw new errors.UnsupportedOperationError(
          `Task ${task.id} is still running; use GetTask or returnImmediately`,
        );
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())));
      task = await ownedTask(options, who, task.id);
    }
    return view(task, who);
  }
  const unsupported = async (): Promise<never> => {
    throw new errors.UnsupportedOperationError(
      "This durable endpoint supports SendMessage, GetTask and CancelTask only",
    );
  };
  const handler: A2ARequestHandler = {
    getAgentCard: async () => card,
    getAuthenticatedExtendedAgentCard: unsupported,
    sendMessage: (params, context) =>
      safe(async () => {
        const who = identity(context);
        const message = params.message;
        if (!message || message.role !== sdk.Role.ROLE_USER || !message.parts.length || message.parts.length > 32)
          throw new DurableProtocolError("invalid", "A bounded user message is required");
        protocolId(message.messageId);
        if (params.configuration?.taskPushNotificationConfig) throw new errors.PushNotificationNotSupportedError();
        const modes = params.configuration?.acceptedOutputModes ?? [];
        if (modes.length && !modes.some((mode) => ["text/plain", "application/json"].includes(mode)))
          throw new errors.ContentTypeNotSupportedError();
        const parts: DurableProtocolPart[] = message.parts.map((part) => {
          if (part.content?.$case === "text" && (!part.mediaType || part.mediaType === "text/plain"))
            return { text: part.content.value };
          if (part.content?.$case === "data" && (!part.mediaType || part.mediaType === "application/json"))
            return { data: protocolJSON(part.content.value) };
          throw new errors.ContentTypeNotSupportedError("Only text and JSON input are supported");
        });
        protocolJSON(parts);
        let task: DurableTaskRecord;
        if (message.taskId) {
          task = await ownedTask(options, who, message.taskId, "input");
          if (message.contextId && message.contextId !== task.identity.sessionId)
            throw new DurableProtocolError("not-found", "Task not found");
          if (parts.length !== 1 || !("data" in parts[0]))
            throw new DurableProtocolError("invalid", "Approval response must be one JSON part");
          const response = protocolObject(parts[0].data);
          if (
            typeof response.approved !== "boolean" ||
            Object.keys(response).some((key) => !["approvalId", "preparedHash", "approved"].includes(key))
          )
            throw new DurableProtocolError("invalid", "Invalid approval response");
          await respondToApproval(options, who, task.id, {
            approvalId: protocolId(response.approvalId),
            preparedHash: protocolId(response.preparedHash),
            approved: response.approved,
          });
          task = await ownedTask(options, who, task.id);
        } else {
          if (message.contextId)
            throw new DurableProtocolError("invalid", "New task context is assigned by host admission");
          task = await admitTask(options, who, {
            protocol: "a2a-1.0",
            name: options.name,
            messageId: message.messageId,
            parts,
          });
        }
        return wait(task, who, params.configuration?.returnImmediately);
      }),
    getTask: (params, context) =>
      safe(async () => view(await ownedTask(options, identity(context), params.id), identity(context))),
    cancelTask: (params, context) =>
      safe(async () => {
        const who = identity(context);
        const task = await ownedTask(options, who, params.id, "cancel");
        if (["completed", "failed", "stopped", "canceled"].includes(task.state))
          throw new errors.TaskNotCancelableError();
        await options.supervisor.cancel({ tenantId: who.tenantId, taskId: task.id });
        await wakeTask(options, who, task.id);
        // A2A CancelTask acknowledges cancellation only after the supervisor has quiesced work.
        const deadline = Date.now() + waitMs;
        let current = await ownedTask(options, who, task.id);
        while (current.state === "cancel_requested" && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())));
          current = await ownedTask(options, who, task.id);
        }
        if (current.state !== "canceled")
          throw new errors.TaskNotCancelableError("Cancellation requested; await acknowledged state using GetTask");
        return view(current, who);
      }),
    async *sendMessageStream() {
      yield await unsupported();
    },
    async *resubscribe() {
      yield await unsupported();
    },
    listTasks: unsupported,
    createTaskPushNotificationConfig: unsupported,
    getTaskPushNotificationConfig: unsupported,
    listTaskPushNotificationConfigs: unsupported,
    deleteTaskPushNotificationConfig: unsupported,
  };
  const { Router, json } = createRequire(import.meta.url)("express") as typeof import("express");
  const router = Router();
  const identities = new WeakMap<Request, DurableReader>();
  router.get(options.cardPath ?? "/.well-known/agent-card.json", (_request, response) =>
    response.set("Cache-Control", "no-store").json(sdk.AgentCard.toJSON(card)),
  );
  router.use(
    endpoint.pathname,
    json({ limit: 65_536 }),
    async (request, response, next) => {
      response.setHeader("Cache-Control", "no-store");
      try {
        if (request.path !== "/") {
          response.status(404).end();
          return;
        }
        if (request.method !== "POST") {
          response.status(405).end();
          return;
        }
        const who = await options.authenticate(request, options.audience);
        if (!who?.tenantId || !who.actorId) {
          response.status(401).json({ error: "Authentication required" });
          return;
        }
        protocolId(who.tenantId);
        protocolId(who.actorId);
        if (request.body?.params?.tenant && request.body.params.tenant !== who.tenantId) {
          response.status(403).json({ error: "Tenant mismatch" });
          return;
        }
        protocolJSON(request.body);
        if (request.body?.method === "SendMessage") {
          // The SDK's protobuf mapper accepts oneof fields permissively. Reject ambiguous wire
          // parts before it can discard an unsupported arm and admit a different request.
          const message = request.body.params?.message;
          if (
            message?.role !== "ROLE_USER" ||
            !Array.isArray(message.parts) ||
            message.parts.length < 1 ||
            message.parts.length > 32
          )
            throw new Error("Invalid user message");
          protocolId(message.messageId);
          for (const part of message.parts) {
            const content = protocolObject(part);
            if (
              Object.keys(content).filter((key) => ["text", "data", "raw", "url"].includes(key)).length !== 1 ||
              "raw" in content ||
              "url" in content ||
              ("text" in content && typeof content.text !== "string")
            )
              throw new Error("Unsupported or ambiguous message part");
          }
        }
        identities.set(request, Object.freeze({ ...who }));
        next();
      } catch {
        response.status(400).json({ error: "Invalid durable request" });
      }
    },
    http.jsonRpcHandler({
      requestHandler: handler,
      userBuilder: async (request) => ({
        isAuthenticated: true,
        userName: JSON.stringify([identities.get(request)!.tenantId, identities.get(request)!.actorId]),
      }),
      contextBuilder: (context) => {
        const [tenant] = JSON.parse(context.user!.userName) as [string, string];
        if (context.tenant && context.tenant !== tenant) throw new errors.TaskNotFoundError();
        return new server.ServerCallContext({ user: context.user, tenant, requestedVersion: context.requestedVersion });
      },
    }),
  );
  return router;
}
