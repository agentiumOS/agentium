import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import {
  A2AV1Client,
  DurableActionLedger,
  type DurableReader,
  type DurableTaskStore,
  DurableTaskSupervisor,
  EventBus,
  InMemoryDurableTaskStore,
  MCPV2ToolProvider,
  RunContext,
} from "@agentium/core";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDurableA2AV1Server } from "../a2a/durable-v1-server.js";
import type { DurableProtocolHost } from "../durable/protocol-host.js";
import { createDurableMCPTaskHandler, type DurableMCPTaskHandler } from "../mcp/durable-task-handler.js";

const opened: Server[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  for (const server of opened.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
const owner = { tenantId: "tenant-a", actorId: "actor-a" };
function identity(token: string | undefined | null): DurableReader | null {
  return token === "Bearer a"
    ? owner
    : token === "Bearer b"
      ? { tenantId: "tenant-b", actorId: "actor-b" }
      : token === "Bearer sibling"
        ? { ...owner, actorId: "sibling" }
        : null;
}
function fixture(store: DurableTaskStore = new InMemoryDurableTaskStore()) {
  const supervisor = new DurableTaskSupervisor(store, { leaseMs: 3000, pollMs: 10 });
  const admit = vi.fn<DurableProtocolHost["admit"]>(async (who, input) => {
    const id = randomUUID();
    await supervisor.create({
      id,
      identity: { ...who, sessionId: `s:${id}`, runId: id, rootRunId: id },
      manifestHash: "fixture-manifest",
      inputRef: "fixture-input",
      policyRevision: 1,
      grantRefs: ["fixture-grant"],
      input: { normalized: input as never },
    });
    return { tenantId: who.tenantId, taskId: id };
  });
  const host: DurableProtocolHost = {
    supervisor,
    admit,
    authorize: vi.fn(async () => true),
    wake: vi.fn(async () => {}),
    respond: vi.fn(async (who, task, response) => {
      await DurableActionLedger.decide(
        store,
        { tenantId: who.tenantId, taskId: task.id },
        { ...response, actorId: who.actorId },
      );
    }),
    output: vi.fn(async () => ({ text: "public answer", data: { count: 7 } })),
  };
  return { store, host, admit, supervisor };
}
async function startA2A(host: DurableProtocolHost) {
  const app = express();
  const server = createServer(app);
  opened.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  app.use(
    await createDurableA2AV1Server({
      ...host,
      name: "fixture",
      url: `${origin}/rpc`,
      audience: "fixture",
      authenticate: async (request, audience) =>
        audience === "fixture" ? identity(request.headers.authorization) : null,
      waitTimeoutMs: 120,
      pollIntervalMs: 5,
    }),
  );
  const client = (token = "a") => new A2AV1Client({ url: origin, headers: { Authorization: `Bearer ${token}` } });
  const rpc = async (method: string, params: unknown, token = "a") =>
    (
      await fetch(`${origin}/rpc`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "A2A-Version": "1.0" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
    ).json() as Promise<any>;
  return { origin, client, rpc };
}
async function startMCP(host: DurableProtocolHost) {
  const options = {
    ...host,
    name: "fixture",
    audience: "fixture",
    authenticate: async (request: Request, audience: string) =>
      audience === "fixture" ? identity(request.headers.get("authorization")) : null,
    tools: [
      {
        name: "work",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      },
    ],
    pollIntervalMs: 10,
  };
  let handler: DurableMCPTaskHandler = await createDurableMCPTaskHandler(options);
  cleanups.push(() => handler.close());
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const web = new Request(`http://127.0.0.1${request.url}`, {
      method: request.method,
      headers: request.headers as Record<string, string>,
      ...(body.length ? { body } : {}),
    });
    const result = await handler.fetch(web);
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  opened.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  const provider = new MCPV2ToolProvider({
    name: "fixture",
    transport: "http",
    url,
    audience: url,
    headers: { Authorization: "Bearer a" },
    tasks: true,
  });
  cleanups.push(() => provider.close());
  const rpc = async (
    method: string,
    params: Record<string, unknown>,
    token = "a",
    extra?: { capabilities?: object; version?: string; nameHeader?: string },
  ) => {
    const version = extra?.version ?? "2026-07-28";
    return (
      await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "MCP-Protocol-Version": version,
          "Mcp-Method": method,
          "Mcp-Name": extra?.nameHeader ?? encodeURIComponent(String(params.taskId ?? params.name ?? "")),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": version,
              "io.modelcontextprotocol/clientInfo": { name: "fixture", version: "1" },
              "io.modelcontextprotocol/clientCapabilities": extra?.capabilities ?? {
                extensions: { "io.modelcontextprotocol/tasks": {} },
              },
            },
          },
        }),
      })
    ).json() as Promise<any>;
  };
  return {
    provider,
    rpc,
    restart: async () => {
      await handler.close();
      handler = await createDurableMCPTaskHandler(options);
    },
  };
}
async function approval(f: ReturnType<typeof fixture>, id: string) {
  const key = { tenantId: owner.tenantId, taskId: id };
  const task = await f.supervisor.run(key, "worker", async (ctx) => {
    await ctx.actions.execute(
      {
        id: "effect",
        connectorVersion: "fixture@1",
        destination: "fixture",
        args: {},
        approval: { actorId: owner.actorId, expiresAt: Date.now() + 60_000 },
      },
      { version: "fixture@1", dispatch: async () => ({ resultRef: "result" }) },
    );
  });
  return Object.values(task!.approvals)[0];
}

async function completeApproval(f: ReturnType<typeof fixture>, id: string) {
  await f.supervisor.run({ tenantId: owner.tenantId, taskId: id }, "worker-2", async (ctx) => {
    await ctx.actions.execute(
      { id: "effect", connectorVersion: "fixture@1", destination: "fixture", args: {} },
      { version: "fixture@1", dispatch: async () => ({ resultRef: "private-secret-reference" }) },
    );
    return { resultRef: "private-secret-reference" };
  });
}

describe("durable protocol bridges, actual optional SDK HTTP framing", () => {
  it("separates completed tool errors from internal failures without exposing stored failure details", async () => {
    const f = fixture();
    f.host.output = async () => ({ text: "The supplied input could not be processed", isError: true });
    const endpoint = await startMCP(f.host);
    const toolError = await endpoint.rpc("tools/call", { name: "work", arguments: { query: "domain error" } });
    await f.supervisor.run({ tenantId: owner.tenantId, taskId: toolError.result.taskId }, "worker", async () => {});
    expect((await endpoint.rpc("tasks/get", { taskId: toolError.result.taskId })).result).toMatchObject({
      status: "completed",
      result: { isError: true },
    });
    const failed = await endpoint.rpc("tools/call", { name: "work", arguments: { query: "internal failure" } });
    await expect(
      f.supervisor.run({ tenantId: owner.tenantId, taskId: failed.result.taskId }, "worker", async () => {
        throw new Error("private connector credential detail");
      }),
    ).rejects.toThrow();
    const response = await endpoint.rpc("tasks/get", { taskId: failed.result.taskId });
    expect(response.result).toMatchObject({ status: "failed", error: { code: -32603, message: "Task failed" } });
    expect(JSON.stringify(response)).not.toContain("credential");
  });

  it("uses A2A SDK1.3 discovery/task mapping, scoped identity and explicit unsupported methods", async () => {
    const f = fixture();
    const endpoint = await startA2A(f.host);
    expect((await endpoint.client().discover()).capabilities?.streaming).toBe(false);
    const sent = await endpoint.rpc("SendMessage", {
      message: {
        messageId: "m1",
        role: "ROLE_USER",
        parts: [{ text: "hello" }, { data: { value: 1 } }],
        metadata: { tenantId: "forged" },
      },
      configuration: { returnImmediately: true },
    });
    expect(sent.result.task.status.state).toBe("TASK_STATE_SUBMITTED");
    const id = sent.result.task.id;
    expect(f.admit.mock.calls[0]).toEqual([
      owner,
      { protocol: "a2a-1.0", name: "fixture", messageId: "m1", parts: [{ text: "hello" }, { data: { value: 1 } }] },
    ]);
    expect((await endpoint.client().getTask(id)).id).toBe(id);
    await expect(endpoint.client("b").getTask(id)).rejects.toThrow();
    await expect(endpoint.client("sibling").cancelTask(id)).rejects.toThrow();
    expect((await endpoint.rpc("ListTasks", {})).error).toBeDefined();
    expect((await endpoint.rpc("message/send", {})).error).toBeDefined();
    expect(
      (
        await endpoint.rpc("SendMessage", {
          message: { messageId: "bad", role: "ROLE_USER", parts: [{ url: "file:///private" }] },
        })
      ).error,
    ).toBeDefined();
    expect(f.admit).toHaveBeenCalledTimes(1);
    await f.supervisor.run({ tenantId: owner.tenantId, taskId: id }, "worker", async () => ({
      resultRef: "private:blob",
    }));
    const result = await endpoint.client().getTask(id);
    expect(result.status.state).toBe("TASK_STATE_COMPLETED");
    expect(result.artifacts).toEqual([
      expect.objectContaining({ parts: [{ text: "public answer" }, { data: { count: 7 } }] }),
    ]);
    expect(JSON.stringify(result)).not.toContain("private:blob");
  });
  it("blocks SendMessage until interrupted and binds approval input to the prepared digest", async () => {
    const f = fixture();
    f.host.wake = async (key) => {
      const task = await f.supervisor.get(key);
      if (task?.state === "queued") await approval(f, key.taskId);
      else if (
        task?.state === "awaiting_approval" &&
        Object.values(task.approvals).every((a) => a.decision !== "pending")
      )
        await completeApproval(f, key.taskId);
    };
    const endpoint = await startA2A(f.host);
    const first = await endpoint.client().send("needs approval");
    if (!("id" in first)) throw new Error("Expected task");
    expect(first.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
    const a = Object.values((await f.supervisor.get({ tenantId: owner.tenantId, taskId: first.id }))!.approvals)[0];
    const followup = (preparedHash: string) => ({
      messageId: "followup",
      taskId: first.id,
      contextId: first.contextId,
      role: "ROLE_USER" as const,
      parts: [{ data: { approvalId: a.id, preparedHash, approved: true } }],
    });
    await expect(endpoint.client().send(followup("wrong"))).rejects.toThrow();
    expect(f.host.respond).not.toHaveBeenCalled();
    await endpoint.client().send(followup(a.preparedHash));
    expect((await f.supervisor.get({ tenantId: owner.tenantId, taskId: first.id }))!.approvals[a.id].decision).toBe(
      "approved",
    );
    await expect(endpoint.client().send(followup(a.preparedHash))).rejects.toThrow();
  });
  it("never reports A2A cancellation/completion before cancellation quiesces, then survives a new server", async () => {
    const f = fixture();
    const endpoint = await startA2A(f.host);
    const sent = await endpoint.rpc("SendMessage", {
      message: { messageId: "m", role: "ROLE_USER", parts: [{ text: "slow" }] },
      configuration: { returnImmediately: true },
    });
    const key = { tenantId: owner.tenantId, taskId: sent.result.task.id };
    let finish!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const run = f.supervisor.run(key, "worker", async () => {
      started();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { resultRef: "late-success" };
    });
    await ready;
    await expect(endpoint.client().cancelTask(key.taskId)).rejects.toThrow(/Cancellation requested/);
    expect((await endpoint.client().getTask(key.taskId)).status.state).toBe("TASK_STATE_WORKING");
    finish();
    await run;
    const restarted = await startA2A(f.host);
    expect((await restarted.client().getTask(key.taskId)).status.state).toBe("TASK_STATE_CANCELED");
    expect(f.host.output).not.toHaveBeenCalled();
  });
  it("rejects MCP unnegotiated, malformed, mismatched or unsupported tasks before admission", async () => {
    const f = fixture();
    const endpoint = await startMCP(f.host);
    expect(
      (await endpoint.rpc("tools/call", { name: "work", arguments: { query: "x" } }, "a", { capabilities: {} })).error
        .code,
    ).toBe(-32021);
    expect((await endpoint.rpc("tools/call", { name: "work", arguments: { query: 3 } })).error).toBeDefined();
    expect(
      (await endpoint.rpc("tools/call", { name: "work", arguments: { query: "x" } }, "a", { nameHeader: "different" }))
        .error.code,
    ).toBe(-32020);
    expect(
      (await endpoint.rpc("tools/call", { name: "work", arguments: { query: "x" } }, "a", { version: "2025-11-25" }))
        .error,
    ).toBeDefined();
    expect((await endpoint.rpc("tasks/list", {})).error.code).toBe(-32601);
    expect(f.admit).not.toHaveBeenCalled();
  });
  it("uses the modern client SDK over HTTP, persists cancellation intent, and reconnects to task state", async () => {
    const f = fixture();
    const endpoint = await startMCP(f.host);
    const [tool] = await endpoint.provider.getTools();
    const ctx = new RunContext({
      tenantId: owner.tenantId,
      userId: owner.actorId,
      sessionId: "s",
      eventBus: new EventBus(),
    });
    const result = await tool.execute({ query: "work" }, ctx);
    const { handle } = JSON.parse(typeof result === "string" ? result : result.content);
    const id = (await f.admit.mock.results[0].value).taskId;
    expect(await endpoint.provider.getTask(handle, ctx)).toMatchObject({ status: "running" });
    expect((await endpoint.rpc("tasks/get", { taskId: id }, "b")).error).toBeDefined();
    expect((await endpoint.rpc("tasks/cancel", { taskId: id }, "sibling")).error).toBeDefined();
    await endpoint.provider.cancelTask(handle, ctx);
    expect((await endpoint.rpc("tasks/get", { taskId: id })).result.status).toBe("working");
    await endpoint.restart();
    expect((await endpoint.rpc("tasks/get", { taskId: id })).result.status).toBe("working");
    await f.supervisor.run({ tenantId: owner.tenantId, taskId: id }, "replacement", async () => {
      throw new Error("must not execute after cancel");
    });
    expect((await endpoint.rpc("tasks/get", { taskId: id })).result.status).toBe("cancelled");
    expect(await endpoint.provider.getTask(handle, ctx)).toMatchObject({ status: "cancelled" });
  });
  it("maps MCP human inputs, ignores replayed answers, and returns bounded authorized output", async () => {
    const f = fixture();
    const endpoint = await startMCP(f.host);
    const created = await endpoint.rpc("tools/call", { name: "work", arguments: { query: "x" } });
    const id = created.result.taskId;
    const a = await approval(f, id);
    const pending = await endpoint.rpc("tasks/get", { taskId: id });
    expect(pending.result).toMatchObject({
      resultType: "complete",
      status: "input_required",
      inputRequests: { [a.id]: { method: "elicitation/create" } },
    });
    const answer = { [a.id]: { action: "accept", content: { preparedHash: a.preparedHash, approved: true } } };
    expect((await endpoint.rpc("tasks/update", { taskId: id, inputResponses: answer }, "sibling")).error).toBeDefined();
    expect((await endpoint.rpc("tasks/update", { taskId: id, inputResponses: answer })).result.resultType).toBe(
      "complete",
    );
    await endpoint.rpc("tasks/update", { taskId: id, inputResponses: answer });
    expect(f.host.respond).toHaveBeenCalledTimes(1);
    await completeApproval(f, id);
    expect((await endpoint.rpc("tasks/get", { taskId: id })).result).toMatchObject({
      status: "completed",
      result: { content: [{ type: "text", text: "public answer" }], structuredContent: { value: { count: 7 } } },
    });
    f.host.output = async () => ({ text: "x".repeat(100_000) });
    // Restart binds the changed trusted projection. Oversized output never reaches a client.
    const bounded = await startMCP(f.host);
    const denied = await bounded.rpc("tasks/get", { taskId: id });
    expect(denied.error).toBeDefined();
    expect(JSON.stringify(denied)).not.toContain("private-secret-reference");
  });
});

it.skipIf(process.env.AGENTIUM_DURABLE_MONGO_TEST !== "1")(
  "reads approved/completed and canceled protocol tasks after independent Mongo store/server restart",
  async () => {
    const { MongoDBDurableTaskStore } = await import("@agentium/core");
    const { MongoClient } = await import("mongodb");
    const uri = process.env.AGENTIUM_DURABLE_MONGO_URI ?? "mongodb://127.0.0.1:27319/?directConnection=true";
    const database = `agentium_protocol_fixture_${randomUUID().replaceAll("-", "")}`;
    const client = new MongoClient(uri);
    await client.connect();
    const firstStore = new MongoDBDurableTaskStore(uri, { database });
    await firstStore.initialize();
    let secondStore: InstanceType<typeof MongoDBDurableTaskStore> | undefined;
    try {
      const first = fixture(firstStore);
      const mcp = await startMCP(first.host);
      const created = await mcp.rpc("tools/call", { name: "work", arguments: { query: "persistent" } });
      const id = created.result.taskId;
      const a = await approval(first, id);
      // Dispose the original store; the replacement has no task/approval state in memory.
      await firstStore.close();
      secondStore = new MongoDBDurableTaskStore(uri, { database });
      await secondStore.initialize();
      const recovered = fixture(secondStore);
      const nextMcp = await startMCP(recovered.host);
      const a2a = await startA2A(recovered.host);
      expect((await nextMcp.rpc("tasks/get", { taskId: id })).result.status).toBe("input_required");
      expect((await a2a.client().getTask(id)).status.state).toBe("TASK_STATE_INPUT_REQUIRED");
      expect((await nextMcp.rpc("tasks/get", { taskId: id }, "sibling")).error).toBeDefined();
      await nextMcp.rpc("tasks/update", {
        taskId: id,
        inputResponses: { [a.id]: { action: "accept", content: { preparedHash: a.preparedHash, approved: true } } },
      });
      await completeApproval(recovered, id);
      expect((await a2a.client().getTask(id)).status.state).toBe("TASK_STATE_COMPLETED");
      expect((await nextMcp.rpc("tasks/get", { taskId: id })).result.result.content[0].text).toBe("public answer");
      const another = await nextMcp.rpc("tools/call", { name: "work", arguments: { query: "cancel" } });
      const cancelId = another.result.taskId;
      await nextMcp.rpc("tasks/cancel", { taskId: cancelId });
      expect((await nextMcp.rpc("tasks/get", { taskId: cancelId })).result.status).toBe("working");
      await recovered.supervisor.run({ tenantId: owner.tenantId, taskId: cancelId }, "recovery", async () => {
        throw new Error("Cancellation must prevent admission to driver");
      });
      const finalA2a = await startA2A(fixture(secondStore).host);
      expect((await finalA2a.client().getTask(cancelId)).status.state).toBe("TASK_STATE_CANCELED");
      recovered.host.authorize = async () => false;
      const revoked = await startMCP(recovered.host);
      expect((await revoked.rpc("tasks/get", { taskId: id })).error).toBeDefined();
    } finally {
      await secondStore?.close();
      await firstStore.close();
      await client.db(database).dropDatabase();
      await client.close();
    }
  },
  20_000,
);
