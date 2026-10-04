import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { A2AV1Client, type Agent, type RunOutput } from "@agentium/core";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createA2AServer } from "../a2a/a2a-server.js";
import { createA2AV1Server } from "../a2a/v1-server.js";

const opened: Server[] = [];
afterEach(async () => {
  for (const server of opened.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
const output = (): RunOutput => ({
  text: "answer",
  structured: { value: 42 },
  toolCalls: [],
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  status: "completed",
});
async function setup(run: Agent["run"] = vi.fn(async () => output()), interrupted = false, limits = {}) {
  const app = express();
  const server = createServer(app);
  opened.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const authenticate = vi.fn(async (request, audience) => {
    if (audience !== "fixture-audience") return null;
    const token = request.headers.authorization?.replace("Bearer ", "");
    return token === "a"
      ? { tenantId: "tenant-a", userId: "actor-a" }
      : token === "b"
        ? { tenantId: "tenant-b", userId: "actor-b" }
        : null;
  });
  await createA2AV1Server(app, {
    agents: { fixture: { name: "fixture", run } },
    url: `${origin}/rpc`,
    audience: "fixture-audience",
    authenticate,
    ...limits,
    ...(interrupted ? { completionState: () => "TASK_STATE_INPUT_REQUIRED" as const } : {}),
  });
  return {
    origin,
    run,
    authenticate,
    client: new A2AV1Client({ url: origin, headers: { Authorization: "Bearer a" } }),
    other: new A2AV1Client({ url: origin, headers: { Authorization: "Bearer b" } }),
  };
}

describe("A2A 1.0 official SDK conformance", () => {
  it("bounds task allocation before SDK error paths and rejects unsupported media", async () => {
    const fixture = await setup(undefined, false, { maxTasks: 1 });
    for (const part of [
      { raw: "PHN2Zy8+", mediaType: "image/svg+xml" },
      { url: "file:///private/image.png", mediaType: "image/png" },
      { url: "data:image/png;base64,eA==", mediaType: "image/png" },
    ]) {
      await expect(fixture.client.send({ messageId: "invalid", role: "ROLE_USER", parts: [part] })).rejects.toThrow();
    }
    expect(fixture.run).not.toHaveBeenCalled();
    const first = await fixture.client.send("first");
    if (!("id" in first)) throw new Error("Expected task");
    await Promise.all(Array.from({ length: 8 }, () => expect(fixture.client.send("over limit")).rejects.toThrow()));
    expect(fixture.run).toHaveBeenCalledTimes(1);
    const response = await fetch(`${fixture.origin}/rpc`, {
      method: "POST",
      headers: { Authorization: "Bearer a", "Content-Type": "application/json", "A2A-Version": "1.0" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ListTasks", params: {} }),
    });
    const body = (await response.json()) as { result: { tasks: { id: string }[] } };
    expect(body.result.tasks.map((task) => task.id)).toEqual([first.id]);
  });

  it("bounds interrupted task history before accepting more input", async () => {
    const fixture = await setup(undefined, true, { maxHistoryMessages: 2 });
    const first = await fixture.client.send("first");
    if (!("id" in first)) throw new Error("Expected task");
    const followup = {
      messageId: "follow-up",
      role: "ROLE_USER" as const,
      taskId: first.id,
      contextId: first.contextId,
      parts: [{ text: "next" }],
    };
    // The user input and interruption response consume this history bound.
    await expect(fixture.client.send(followup)).rejects.toThrow();
    expect((await fixture.client.getTask(first.id)).history).toHaveLength(2);
    expect(fixture.run).toHaveBeenCalledTimes(1);
  });

  it("discovers current wire version, preserves typed data/media and scopes task ownership", async () => {
    const fixture = await setup();
    expect((await fixture.client.discover()).supportedInterfaces[0]).toMatchObject({
      protocolVersion: "1.0",
      protocolBinding: "JSONRPC",
    });
    const result = await fixture.client.send({
      messageId: "message-a",
      role: "ROLE_USER",
      parts: [
        { text: "hello" },
        { data: { input: 7 }, mediaType: "application/json" },
        { raw: Buffer.from("fixture-image").toString("base64"), mediaType: "image/png" },
      ],
    });
    expect(result).toMatchObject({
      status: { state: "TASK_STATE_COMPLETED" },
      artifacts: [{ parts: [{ data: { value: 42 } }] }],
    });
    expect(fixture.run).toHaveBeenCalledWith(
      expect.arrayContaining([
        { type: "image", data: Buffer.from("fixture-image").toString("base64"), mimeType: "image/png" },
      ]),
      expect.objectContaining({ tenantId: "tenant-a", userId: "actor-a" }),
    );
    if (!("id" in result)) throw new Error("Expected task");
    expect((await fixture.client.getTask(result.id)).id).toBe(result.id);
    await expect(fixture.other.getTask(result.id)).rejects.toThrow();
    await expect(fixture.other.cancelTask(result.id)).rejects.toThrow();
    await expect(fixture.client.getTask(result.id, { tenant: "tenant-b" })).rejects.toThrow();
    await expect(new A2AV1Client({ url: fixture.origin }).send("unauthenticated")).rejects.toThrow();
  });

  it("reports input-required distinctly and allows an explicit follow-up on the same task", async () => {
    const fixture = await setup(undefined, true);
    const first = await fixture.client.send("need input");
    if (!("id" in first)) throw new Error("Expected task");
    expect(first.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
    const second = await fixture.client.send({
      messageId: "follow-up",
      taskId: first.id,
      contextId: first.contextId,
      role: "ROLE_USER",
      parts: [{ text: "more input" }],
    });
    expect(second).toMatchObject({ id: first.id, status: { state: "TASK_STATE_INPUT_REQUIRED" } });
  });

  it("acknowledges cancellation after work finishes and prevents late success", async () => {
    const run = vi.fn(async (_input, opts) => {
      if (!opts.signal.aborted)
        await new Promise<void>((resolve) => opts.signal.addEventListener("abort", () => resolve(), { once: true }));
      return output();
    });
    const fixture = await setup(run);
    const stream = fixture.client.stream("slow work");
    const first = await stream.next();
    if (first.done || !("task" in first.value)) throw new Error("Expected initial task");
    const id = first.value.task.id;
    const before = await fixture.client.getTask(id);
    await expect(
      fixture.client.send({
        messageId: "concurrent",
        role: "ROLE_USER",
        taskId: id,
        contextId: first.value.task.contextId,
        parts: [{ text: "must not enter history" }],
      }),
    ).rejects.toThrow();
    expect((await fixture.client.getTask(id)).history).toEqual(before.history);
    const consume = (async () => {
      const events = [];
      for await (const event of stream) events.push(event);
      return events;
    })();
    const canceled = await fixture.client.cancelTask(id);
    expect(canceled.status.state).toBe("TASK_STATE_CANCELED");
    const events = await consume;
    expect(events.filter((event) => "statusUpdate" in event).at(-1)).toMatchObject({
      statusUpdate: { status: { state: "TASK_STATE_CANCELED" } },
    });
    expect((await fixture.client.getTask(id)).status.state).toBe("TASK_STATE_CANCELED");
  });

  it("does not forward credentials to another origin advertised by discovery", async () => {
    const requests: string[] = [];
    const fakeFetch: typeof fetch = async (url) => {
      requests.push(String(url));
      return Response.json({
        name: "fixture",
        description: "fixture",
        version: "1",
        supportedInterfaces: [
          { url: "https://untrusted.example/rpc", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
        ],
        capabilities: {},
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["text/plain"],
        skills: [],
      });
    };
    const client = new A2AV1Client({
      url: "https://trusted.example",
      headers: { Authorization: "Bearer fixture-secret" },
      fetch: fakeFetch,
    });
    await expect(client.send("hello")).rejects.toThrow(/unapproved origin/);
    expect(requests).toHaveLength(1);
  });
});

it("preserves the legacy message/send wire contract and rejects canceling a completed task", async () => {
  const app = express();
  createA2AServer(app, {
    agents: { fixture: { name: "fixture", instructions: "fixture", tools: [], run: async () => output() } as never },
    basePath: "/legacy",
  });
  const server = createServer(app);
  opened.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/legacy`;
  const rpc = async (method: string, params: unknown) =>
    (
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
    ).json() as Promise<{ result: { id: string; status: { state: string } }; error?: unknown }>;
  const response = await rpc("message/send", { message: { role: "user", parts: [{ kind: "text", text: "hello" }] } });
  expect(response.result.status.state).toBe("completed");
  expect((await rpc("tasks/cancel", { id: response.result.id })).error).toBeDefined();
  expect((await rpc("tasks/get", { id: response.result.id })).result.status.state).toBe("completed");
});
