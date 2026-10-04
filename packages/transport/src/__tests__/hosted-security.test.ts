import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentRouter } from "../express/router-factory.js";
import type { HostedResourceRequest, RouterOptions } from "../express/types.js";

const express = createRequire(import.meta.url)("express");
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

async function serve(options: RouterOptions) {
  const app = express();
  app.use(express.json());
  app.use(createAgentRouter(options));
  const server: Server = await new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve(server)));
    server.on("error", reject);
  });
  servers.push(server);
  const port = (server.address() as { port: number }).port;
  const request = async (
    path: string,
    body?: unknown,
    token: string | null = "alice",
    method = body === undefined ? "GET" : "POST",
  ) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text,
      headers: response.headers,
    };
  };
  return Object.assign(request, { url: `http://127.0.0.1:${port}` });
}

const scopes = [
  "agents:run",
  "agents:read",
  "approvals:read",
  "approvals:write",
  "checkpoints:read",
  "checkpoints:restore",
  "corrections:write",
  "schedules:read",
  "schedules:write",
];
function fixture(mode: "map" | "registry" = "map") {
  const owner = new Map<string, string>([
    ["owned", "a"],
    ["other", "b"],
    ["approval-a", "a"],
    ["approval-b", "b"],
    ["checkpoint-a", "a"],
    ["checkpoint-b", "b"],
    ["run-a", "a"],
    ["run-b", "b"],
  ]);
  const agent = {
    providerId: "test",
    run: vi.fn(async (_input, options) => ({ options })),
    stream: vi.fn(async function* (_input, options) {
      yield { options };
    }),
    approvalManager: {
      listPending: () => [
        { requestId: "approval-a", args: { secret: "a" } },
        { requestId: "approval-b", args: { secret: "b" } },
      ],
      approve: vi.fn(),
      deny: vi.fn(),
    },
    checkpointManager: {
      list: vi.fn(async () => [{ checkpointId: "checkpoint-a" }]),
      rollback: vi.fn(async (id) => ({ checkpointId: id })),
    },
    memory: { getCorrectionStore: () => ({}), recordCorrection: vi.fn(async (data) => data) },
  };
  const authorizeResource = vi.fn(async ({ identity, operation, resource }: HostedResourceRequest) => {
    if (operation === "session:create") {
      if (owner.has(resource.id!)) return false;
      owner.set(resource.id!, identity.tenantId!);
      return true;
    }
    if (operation === "correction:create") return true;
    return !!resource.id && owner.get(resource.id) === identity.tenantId;
  });
  const options: RouterOptions = {
    ...(mode === "map"
      ? { registry: false as const, agents: { bot: agent as any } }
      : {
          registry: {
            agents: new Map([["bot", agent]]),
            getAgent: (name: string) => (name === "bot" ? agent : undefined),
            describeAgents: () => [],
          } as any,
        }),
    middleware: [
      (req: any, _res: any, next: any) => {
        const token = req.headers.authorization;
        if (["alice", "bob", "admin", "empty"].includes(token))
          req.user = {
            sub: token,
            tenant: token === "bob" ? "b" : "a",
            scopes: token === "empty" ? [] : token === "admin" ? ["admin:*"] : scopes,
          };
        next();
      },
    ],
    rbac: {},
    security: {
      mode: "authenticated",
      resolveIdentity: (claims: any) => ({ userId: claims.sub, tenantId: claims.tenant }),
      authorizeResource,
    },
  };
  return { options, owner, agent, authorizeResource };
}

describe.each(["map", "registry"] as const)("hosted authorization (%s)", (mode) => {
  it("requires verified identity and scopes before any execution", async () => {
    const f = fixture(mode);
    const request = await serve(f.options);
    expect((await request("/agents/bot/run", { input: "hi" }, null)).status).toBe(401);
    expect((await request("/agents/bot/run", { input: "hi" }, "empty")).status).toBe(403);
    expect(f.agent.run).not.toHaveBeenCalled();
    expect(f.authorizeResource).not.toHaveBeenCalled();
  });
  it("rejects actor/tenant substitution, reused sessions and legacy ownerless sessions", async () => {
    const f = fixture(mode);
    const request = await serve(f.options);
    for (const body of [{ userId: "bob" }, { tenantId: "b" }, { sessionId: "other" }, { sessionId: "legacy" }]) {
      expect((await request("/agents/bot/run", { input: "hi", ...body })).status).toBe(403);
    }
    expect(f.agent.run).not.toHaveBeenCalled();
    expect((await request("/agents/bot/stream", { input: "hi", sessionId: "other" })).status).toBe(403);
    expect(f.agent.stream).not.toHaveBeenCalled();
  });
  it("binds opaque session ownership before execution and propagates verified identity", async () => {
    const f = fixture(mode);
    const request = await serve(f.options);
    const result = await request("/agents/bot/run", { input: "hi" });
    expect(result.status).toBe(200);
    const { sessionId, userId, tenantId } = result.body.options;
    expect(sessionId).toMatch(/^[a-f0-9-]{36}$/);
    expect(result.headers.get("x-agentium-session-id")).toBe(sessionId);
    expect({ userId, tenantId }).toEqual({ userId: "alice", tenantId: "a" });
    expect(f.owner.get(sessionId)).toBe("a");
    expect((await request("/agents/bot/run", { input: "hi", sessionId })).status).toBe(200);
    expect((await request("/agents/bot/run", { input: "hi", sessionId }, "bob")).status).toBe(403);
    f.authorizeResource.mockResolvedValue(false);
    expect((await request("/agents/bot/run", { input: "hi" })).status).toBe(403);
    expect(f.agent.run).toHaveBeenCalledTimes(2);
  });
  it("filters pending approval details and authorizes decisions individually", async () => {
    const f = fixture(mode);
    const request = await serve(f.options);
    expect((await request("/approvals/pending")).body).toEqual([{ requestId: "approval-a", args: { secret: "a" } }]);
    expect((await request("/approvals/approval-b/approve", {})).status).toBe(403);
    expect((await request("/approvals/approval-b/deny", {}, "admin")).status).toBe(403);
    expect(f.agent.approvalManager.approve).not.toHaveBeenCalled();
    expect(f.agent.approvalManager.deny).not.toHaveBeenCalled();
    expect((await request("/approvals/approval-a/approve", {})).status).toBe(200);
    expect(f.agent.approvalManager.approve).toHaveBeenCalledExactlyOnceWith("approval-a", undefined);
  });
  it("checks authoritative run/checkpoint ownership even for administrators", async () => {
    const f = fixture(mode);
    const request = await serve(f.options);
    expect((await request("/agents/bot/checkpoints?runId=run-b")).status).toBe(403);
    for (const checkpoint of ["checkpoint-b", "ownerless"]) {
      expect((await request(`/agents/bot/rollback/${checkpoint}`, {}, "admin")).status).toBe(403);
    }
    expect(f.agent.checkpointManager.list).not.toHaveBeenCalled();
    expect(f.agent.checkpointManager.rollback).not.toHaveBeenCalled();
    expect((await request("/agents/bot/checkpoints?runId=run-a")).status).toBe(200);
    expect((await request("/agents/bot/rollback/checkpoint-a", {})).status).toBe(200);
  });
  it("binds corrections to verified identity and authorizes referenced sessions/runs", async () => {
    const f = fixture(mode);
    const request = await serve(f.options);
    const correction = { originalValue: "a", correctedValue: "b" };
    expect((await request("/agents/bot/corrections", { ...correction, tenantId: "b" })).status).toBe(403);
    expect((await request("/agents/bot/corrections", { ...correction, runId: "run-b" })).status).toBe(403);
    expect((await request("/agents/bot/corrections", { ...correction, sessionId: "other" })).status).toBe(403);
    expect(f.agent.memory.recordCorrection).not.toHaveBeenCalled();
    const result = await request("/agents/bot/corrections", { ...correction, sessionId: "owned" });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ userId: "alice", tenantId: "a", sessionId: "owned" });
  });
});

it("rejects authenticated configurations without an ownership authorizer", () => {
  expect(() =>
    createAgentRouter({ registry: false, rbac: {}, security: { mode: "authenticated" } } as unknown as RouterOptions),
  ).toThrow("authorizeResource");
  expect(() => createAgentRouter({ registry: false, jwt: { secret: "test" }, security: { mode: "local" } })).toThrow(
    "authorizeResource",
  );
});

it("requires an explicit known security mode before discovery or setup", () => {
  const discover = vi.fn(() => []);
  for (const security of [undefined, null, { mode: "disabled" }, { mode: "local-compatibility" }]) {
    const options = {
      security,
      get serve() {
        return discover();
      },
    } as unknown as RouterOptions;
    expect(() => createAgentRouter(options)).toThrow(/explicit security/);
  }
  expect(() => createAgentRouter(undefined as unknown as RouterOptions)).toThrow(/explicit security/);
  expect(discover).not.toHaveBeenCalled();
});

it("retains explicit local mode and intentional public listings", async () => {
  const agent = { run: vi.fn(async (_input, options) => ({ options })) };
  const local = await serve({ registry: false, security: { mode: "local" }, agents: { bot: agent as any } });
  expect(
    (await local("/agents/bot/run", { input: "hi", userId: "local", sessionId: "local-session" }, null)).body.options
      .userId,
  ).toBe("local");
  const f = fixture("registry");
  f.options.rbac = { publicRoutes: ["GET /agents", "GET /approvals/pending"] };
  const request = await serve(f.options);
  expect((await request("/agents", undefined, null)).status).toBe(200);
  expect((await request("/approvals/pending", undefined, null)).status).toBe(401);
});

it("denies unmatched routes, nested admin and schedule controls before effects", async () => {
  const f = fixture();
  const scheduler = { listSchedules: vi.fn(async () => []), schedule: vi.fn(), unschedule: vi.fn() };
  const manager = { list: vi.fn(() => []) };
  f.options.scheduler = scheduler;
  f.options.admin = { mcpManager: manager as any };
  const request = await serve(f.options);
  expect((await request("/admin/mcp", undefined, "empty")).status).toBe(403);
  expect((await request("/admin/mcp", undefined, "admin")).status).toBe(403);
  expect((await request("/schedules")).status).toBe(403);
  expect((await request("/schedules", { id: "other", cron: "* * * * *" })).status).toBe(403);
  expect((await request("/schedules/other", undefined, "alice", "DELETE")).status).toBe(403);
  expect((await request("/new-unconfigured-route", undefined, "admin")).status).toBe(403);
  expect(manager.list).not.toHaveBeenCalled();
  expect(scheduler.listSchedules).not.toHaveBeenCalled();
  expect(scheduler.schedule).not.toHaveBeenCalled();
  expect(scheduler.unschedule).not.toHaveBeenCalled();
});

it("filters live approval events and removes listeners when disconnected", async () => {
  const f = fixture();
  const events = new EventEmitter();
  Object.assign(f.agent, { eventBus: events });
  let subscribed!: () => void;
  const ready = new Promise<void>((resolve) => {
    subscribed = resolve;
  });
  events.once("newListener", () => queueMicrotask(subscribed));
  const request = await serve(f.options);
  const responsePromise = fetch(`${request.url}/approvals/stream`, { headers: { authorization: "alice" } });
  await ready;
  events.emit("tool.approval.request", { requestId: "approval-b", secret: "other-tenant" });
  events.emit("tool.approval.request", { requestId: "approval-a", secret: "own-tenant" });
  const response = await responsePromise;
  const reader = response.body!.getReader();
  const chunk = await reader.read();
  const text = new TextDecoder().decode(chunk.value);
  expect(text).toContain("own-tenant");
  expect(text).not.toContain("other-tenant");
  await reader.cancel();
  await vi.waitFor(() => expect(events.listenerCount("tool.approval.request")).toBe(0));
});

it("checks identity and supplied session ownership after multipart parsing", async () => {
  const f = fixture();
  f.options.fileUpload = true;
  const request = await serve(f.options);
  for (const fields of [{ userId: "bob" }, { tenantId: "b" }, { sessionId: "other" }]) {
    const body = new FormData();
    body.set("input", "hello");
    for (const [key, value] of Object.entries(fields)) body.set(key, value);
    const response = await fetch(`${request.url}/agents/bot/run`, {
      method: "POST",
      body,
      headers: { authorization: "alice" },
    });
    expect(response.status).toBe(403);
    await response.text();
  }
  expect(f.agent.run).not.toHaveBeenCalled();
  const body = new FormData();
  body.set("input", "hello");
  body.set("sessionId", "owned");
  const response = await fetch(`${request.url}/agents/bot/run`, {
    method: "POST",
    body,
    headers: { authorization: "alice" },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ options: { sessionId: "owned", userId: "alice", tenantId: "a" } });
});

it("applies agent-specific scopes before route parameters are populated", async () => {
  const f = fixture();
  f.options.rbac = { agentScopes: { bot: ["special:run"] } };
  const request = await serve(f.options);
  expect((await request("/agents/bot/run", { input: "hi" })).status).toBe(403);
  expect(f.agent.run).not.toHaveBeenCalled();
  expect((await request("/agents/bot/run", { input: "hi" }, "admin")).status).toBe(200);
});

it("rejects empty scopes for every protected control family", async () => {
  const f = fixture();
  const request = await serve(f.options);
  for (const [path, method] of [
    ["/approvals/pending", "GET"],
    ["/approvals/stream", "GET"],
    ["/approvals/approval-a/approve", "POST"],
    ["/agents/bot/checkpoints?runId=run-a", "GET"],
    ["/agents/bot/rollback/checkpoint-a", "POST"],
    ["/agents/bot/corrections", "POST"],
    ["/schedules", "GET"],
    ["/schedules", "POST"],
    ["/admin/mcp/a/connect", "POST"],
  ]) {
    expect((await request(path, method === "GET" ? undefined : {}, "empty", method)).status).toBe(403);
  }
  expect(f.authorizeResource).not.toHaveBeenCalled();
});

it.each(["map", "registry"] as const)(
  "propagates verified identity to team and workflow execution (%s)",
  async (mode) => {
    const f = fixture(mode);
    const team = {
      run: vi.fn(async (_input, options) => ({ options })),
      stream: vi.fn(async function* (_input, options) {
        yield { options };
      }),
    };
    const workflow = { run: vi.fn(async (options) => ({ options })) };
    if (mode === "map") {
      f.options.teams = { team: team as any };
      f.options.workflows = { flow: workflow as any };
    } else {
      Object.assign(f.options.registry as object, { getTeam: () => team, getWorkflow: () => workflow });
    }
    const request = await serve(f.options);
    // Admin supplies route scopes but still passes through resource ownership checks.
    for (const path of ["/teams/team/run", "/teams/team/stream", "/workflows/flow/run"]) {
      expect((await request(path, { input: "hi", sessionId: "other" }, "admin")).status).toBe(403);
      expect((await request(path, { input: "hi", userId: "bob" }, "admin")).status).toBe(403);
    }
    expect(team.run).not.toHaveBeenCalled();
    expect(team.stream).not.toHaveBeenCalled();
    expect(workflow.run).not.toHaveBeenCalled();
    for (const path of ["/teams/team/run", "/workflows/flow/run"]) {
      const result = await request(path, { input: "hi", sessionId: "owned" }, "admin");
      expect(result.status).toBe(200);
      expect(result.body.options).toMatchObject({ userId: "admin", tenantId: "a", sessionId: "owned" });
    }
    const result = await request("/teams/team/stream", { input: "hi", sessionId: "owned" }, "admin");
    expect(result.status).toBe(200);
    expect(result.body).toContain('"tenantId":"a"');
  },
);

it("allows explicitly configured authenticated routes with empty scopes", async () => {
  const f = fixture("registry");
  f.options.rbac = { defaultScopes: { "GET /agents": [] } };
  const request = await serve(f.options);
  expect((await request("/agents", undefined, "empty")).status).toBe(200);
  expect((await request("/agents", undefined, null)).status).toBe(401);
});
