import { once } from "node:events";
import { createServer, type Server } from "node:http";
import {
  DurableRunRecords,
  DurableTaskSupervisor,
  InMemoryDurableTaskStore,
  JournaledDurableTaskStore,
} from "@agentium/core";
import express from "express";
import { afterEach, expect, it } from "vitest";
import { createDurableTaskRouter } from "../express/durable-router.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function setup() {
  const store = new JournaledDurableTaskStore(new InMemoryDurableTaskStore(), 2);
  const supervisor = new DurableTaskSupervisor(store);
  const records = new DurableRunRecords(
    store,
    { durable: false, put: async () => {}, get: async () => null, delete: async () => {} },
    { maxEvents: 2 },
  );
  const key = { tenantId: "tenant", taskId: "task" };
  await supervisor.create({
    id: "task",
    identity: { tenantId: "tenant", actorId: "actor", sessionId: "s", runId: "r", rootRunId: "r" },
    manifestHash: "manifest",
    inputRef: "secret-ref",
    input: { private: true },
    policyRevision: 1,
    grantRefs: [],
  });
  const app = express();
  let grant = true;
  app.use(
    "/tasks",
    createDurableTaskRouter({
      supervisor,
      records,
      authenticate: async (req) =>
        req.headers.authorization ? { tenantId: "tenant", actorId: req.headers.authorization } : null,
      authorize: async () => grant,
      wake: async () => {
        throw new Error("Redis down");
      },
    }),
  );
  const server = createServer(app);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/tasks/task`;
  return {
    store,
    supervisor,
    records,
    key,
    origin,
    revoke: () => {
      grant = false;
    },
  };
}
it("verifies owner/current grants and redacts task internals", async () => {
  const { origin, revoke } = await setup();
  expect((await fetch(origin)).status).toBe(401);
  expect((await fetch(origin, { headers: { Authorization: "other" } })).status).toBe(404);
  const response = await fetch(origin, { headers: { Authorization: "actor" } });
  expect(await response.json()).toEqual({
    taskId: "task",
    state: "queued",
    revision: 0,
    updatedAt: expect.any(Number),
  });
  revoke();
  expect((await fetch(origin, { headers: { Authorization: "actor" } })).status).toBe(404);
});
it("persists cancellation even if delivery fails, without claiming immediate acknowledgement", async () => {
  const { origin, supervisor, key } = await setup();
  const response = await fetch(`${origin}/cancel`, { method: "POST", headers: { Authorization: "actor" } });
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ state: "cancel_requested", deliveryPending: true });
  expect((await supervisor.get(key))?.state).toBe("cancel_requested");
});
it("replays authoritative event cursors, signals gaps, and rechecks grants on reconnect", async () => {
  const { origin, supervisor, records, key, revoke } = await setup();
  await supervisor.run(key, "worker", async (ctx) => {
    await records.append(key, ctx.lease, "text\nunsafe", { text: "line\nline" });
  });
  const headers = { Authorization: "actor" };
  const gap = await fetch(`${origin}/events`, { headers });
  expect(gap.status).toBe(409);
  expect(await gap.json()).toMatchObject({ earliest: 2, latest: 3 });
  const events = await fetch(`${origin}/events`, { headers: { ...headers, "Last-Event-ID": "1" } });
  expect(events.headers.get("content-type")).toMatch(/text\/event-stream/);
  const text = await events.text();
  expect(text).toContain("id: 2\nevent: durable.event");
  expect(text).toContain('"type":"text\\nunsafe"');
  expect(text).toContain('"state":"completed"');
  expect((await fetch(`${origin}/events`, { headers: { ...headers, "Last-Event-ID": "-1" } })).status).toBe(400);
  revoke();
  expect((await fetch(`${origin}/events`, { headers: { ...headers, "Last-Event-ID": "3" } })).status).toBe(404);
});
