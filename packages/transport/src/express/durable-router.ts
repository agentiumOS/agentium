import { createRequire } from "node:module";
import {
  DurableEventGapError,
  type DurableReader,
  type DurableRunRecords,
  type DurableTaskKey,
  type DurableTaskRecord,
  type DurableTaskSupervisor,
} from "@agentium/core";
import type { Request, Response, Router } from "express";

export interface DurableTaskRouterOptions {
  supervisor: DurableTaskSupervisor;
  records: DurableRunRecords;
  /** Verify credentials/audience. Returned identity must never come from body/query claims. */
  authenticate: (request: Request) => Promise<DurableReader | null>;
  /** Recheck current host policy/grants on every request, including event reconnections. */
  authorize: (
    identity: DurableReader,
    task: Readonly<DurableTaskRecord>,
    operation: "read" | "cancel",
  ) => Promise<boolean>;
  /** Re-deliver cancellation to a worker. Cancellation remains persisted if Redis is unavailable. */
  wake: (key: DurableTaskKey) => Promise<unknown>;
}

/** Authenticated control and bounded replay for tasks already admitted by the host.
 * Event responses close after the retained batch; reconnect with Last-Event-ID.
 * This is an Agentium endpoint, not an A2A or MCP wire-protocol endpoint.
 */
export function createDurableTaskRouter(options: DurableTaskRouterOptions): Router {
  for (const callback of [options.authenticate, options.authorize, options.wake])
    if (typeof callback !== "function")
      throw new Error("Durable routes require authentication, authorization and wake");
  if (options.records.store !== options.supervisor.store)
    throw new Error("Durable routes require one shared authoritative store");
  const { Router } = createRequire(import.meta.url)("express") as typeof import("express");
  const router = Router();
  router.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  async function owned(request: Request, response: Response, operation: "read" | "cancel") {
    const identity = await options.authenticate(request);
    if (!identity?.tenantId || !identity.actorId) {
      response.status(401).json({ error: "Authentication required" });
      return;
    }
    const taskId = request.params.taskId;
    if (typeof taskId !== "string" || !taskId.trim() || taskId.length > 512) {
      response.status(400).json({ error: "Invalid task ID" });
      return;
    }
    const key = { tenantId: identity.tenantId, taskId };
    const task = await options.supervisor.get(key);
    if (
      !task ||
      task.identity.actorId !== identity.actorId ||
      !(await options.authorize(identity, structuredClone(task), operation))
    ) {
      response.status(404).json({ error: "Task not found" });
      return;
    }
    return { identity, task, key };
  }
  // Never serialize private input, connector arguments, internal failure messages or blob keys.
  const view = (task: DurableTaskRecord) => ({
    taskId: task.id,
    state: task.state,
    revision: task.revision,
    updatedAt: task.updatedAt,
  });
  const fail = (response: Response) => {
    if (!response.headersSent) response.status(500).json({ error: "Durable task operation failed" });
    else response.end();
  };
  router.get("/:taskId", async (request, response) => {
    try {
      const record = await owned(request, response, "read");
      if (record) response.json(view(record.task));
    } catch {
      fail(response);
    }
  });
  router.post("/:taskId/cancel", async (request, response) => {
    try {
      const record = await owned(request, response, "cancel");
      if (!record) return;
      const canceled = await options.supervisor.cancel(record.key);
      let deliveryPending = false;
      try {
        await options.wake(record.key);
      } catch {
        deliveryPending = true;
      }
      response.status(202).json({ ...view(canceled), deliveryPending });
    } catch {
      fail(response);
    }
  });
  router.get("/:taskId/events", async (request, response) => {
    try {
      const record = await owned(request, response, "read");
      if (!record) return;
      const raw = request.headers["last-event-id"] ?? "0";
      if (typeof raw !== "string" || !/^(0|[1-9][0-9]{0,15})$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
        response.status(400).json({ error: "Invalid event cursor" });
        return;
      }
      const events = await options.records.events(record.key, record.identity, Number(raw));
      response.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
      // One bounded write avoids an unbounded per-client stream queue. JSON safely escapes newlines.
      response.end(
        `retry: 1000\n\n${events.map((event) => `id: ${event.sequence}\nevent: durable.event\ndata: ${JSON.stringify(event)}\n\n`).join("")}`,
      );
    } catch (error) {
      if (error instanceof DurableEventGapError)
        response.status(409).json({ error: "Event history gap", earliest: error.earliest, latest: error.latest });
      else fail(response);
    }
  });
  return router;
}
