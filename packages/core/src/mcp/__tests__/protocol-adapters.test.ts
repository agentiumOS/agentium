import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunContext } from "../../agent/run-context.js";
import { EventBus } from "../../events/event-bus.js";
import { MCPToolProvider } from "../mcp-client.js";
import { MCPToolError, MCPV2ToolProvider } from "../mcp-v2.js";

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of close.splice(0)) await fn();
  vi.unstubAllGlobals();
});
function context(tenantId = "tenant-a") {
  return new RunContext({ sessionId: "session", userId: "user", tenantId, eventBus: new EventBus() });
}
function fixture(tasks = false) {
  let names = ["echo", "fail"];
  const handler = createMcpHandler(() => {
    const server = new McpServer(
      { name: "fixture", version: "1" },
      { capabilities: tasks ? { extensions: { "io.modelcontextprotocol/tasks": {} } } : {} },
    );
    for (const name of names)
      server.registerTool(
        name,
        { inputSchema: fromJsonSchema({ type: "object", properties: { q: { type: "string" } }, required: ["q"] }) },
        async (args: unknown) => {
          const { q } = args as { q: string };
          return {
            content: [
              { type: "text", text: String(q) },
              { type: "resource", resource: { uri: "file:///report.txt", text: "report", mimeType: "text/plain" } },
            ],
            structuredContent: { answer: q },
            isError: name === "fail",
          };
        },
      );
    return server;
  });
  const fetcher = vi.fn((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    handler.fetch(new Request(input, init)),
  );
  vi.stubGlobal("fetch", fetcher);
  const provider = new MCPV2ToolProvider({
    name: "fixture",
    transport: "http",
    url: "https://fixture.test/mcp",
    tasks,
  });
  close.push(() => provider.close());
  return {
    provider,
    fetcher,
    handler,
    setNames: (value: string[]) => {
      names = value;
    },
  };
}

describe("explicit MCP adapters", () => {
  it("restores HTTP task references after client restart only for the same endpoint and owned session", async () => {
    const { provider, handler } = fixture(true);
    let reads = 0;
    const remote = {
      taskId: "persisted-task",
      status: "working",
      createdAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      ttlMs: null,
    };
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      const body = (await request.clone().json()) as { id: unknown; method: string };
      if (body.method === "tools/call")
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { resultType: "task", ...remote } });
      if (body.method === "tasks/get") {
        reads++;
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { resultType: "complete", ...remote } });
      }
      return handler.fetch(request);
    });
    const firstContext = context();
    const [tool] = await provider.getTools();
    const result = await tool.execute({ q: "persist" }, firstContext);
    const { handle } = JSON.parse(typeof result === "string" ? result : result.content);
    const reference = provider.exportTaskReference(handle, firstContext);
    expect(reference).toEqual({
      version: 1,
      providerName: "fixture",
      endpoint: "https://fixture.test/mcp",
      taskId: "persisted-task",
      identity: { tenantId: "tenant-a", userId: "user", sessionId: "session" },
    });
    await provider.close();
    const next = new MCPV2ToolProvider({
      name: "fixture",
      transport: "http",
      url: "https://fixture.test/mcp",
      tasks: true,
    });
    close.push(() => next.close());
    await expect(next.resumeTask(reference, context("other-tenant"))).rejects.toThrow(/unauthorized/);
    await expect(next.resumeTask({ ...reference, endpoint: "https://other.test/mcp" }, context())).rejects.toThrow(
      /unauthorized/,
    );
    expect(reads).toBe(0);
    const nextContext = context();
    const resumed = await next.resumeTask(JSON.parse(JSON.stringify(reference)), nextContext);
    expect(reads).toBe(1);
    expect(resumed).toMatchObject({ status: "running", handle: expect.stringMatching(/^mcp:/) });
    expect(resumed.handle).not.toBe(handle);
    await expect(next.getTask(resumed.handle, firstContext)).rejects.toThrow(/unauthorized/);
    expect(await next.getTask(resumed.handle, nextContext)).toMatchObject({ status: "running" });
  });

  it("uses actual SDK v2 HTTP framing, retains resources/structured output, refreshes and preserves tool errors", async () => {
    const { provider, setNames } = fixture();
    const [echo, fail] = await provider.getTools();
    expect(provider.protocolVersion).toBe("2026-07-28");
    expect(echo.rawJsonSchema?.required).toEqual(["q"]);
    const result = await echo.execute({ q: "hello" }, context());
    expect(result).toMatchObject({
      content: "hello",
      artifacts: [
        {
          type: "mcp-result",
          data: {
            structuredContent: { answer: "hello" },
            content: [
              expect.anything(),
              { type: "resource", resource: { uri: "file:///report.txt", text: "report", mimeType: "text/plain" } },
            ],
          },
        },
      ],
    });
    await expect(fail.execute({ q: "failure" }, context())).rejects.toBeInstanceOf(MCPToolError);
    setNames(["changed"]);
    await provider.refresh();
    expect((await provider.getTools()).map((tool) => tool.name)).toEqual(["fixture__changed"]);
  });

  it("fails before network on audience mismatch and forwards cancellation", async () => {
    expect(
      () =>
        new MCPV2ToolProvider({
          name: "p",
          transport: "http",
          url: "https://a.test/mcp",
          headers: { authorization: "Bearer test" },
          audience: "https://b.test/mcp",
        }),
    ).toThrow(/audience/);
    const { provider, fetcher } = fixture();
    const [tool] = await provider.getTools();
    const before = fetcher.mock.calls.length;
    const controller = new AbortController();
    controller.abort();
    const ctx = new RunContext({ sessionId: "s", eventBus: new EventBus(), signal: controller.signal });
    await expect(tool.execute({ q: "x" }, ctx)).rejects.toThrow();
    expect(fetcher.mock.calls).toHaveLength(before);
  });

  it("negotiates Tasks, maps owned handles, input updates, routing headers and cooperative cancellation", async () => {
    const { provider, handler } = fixture(true);
    const base = {
      taskId: "server-task",
      createdAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      ttlMs: 60000,
      pollIntervalMs: 50,
    };
    let status = "working";
    const requests: Array<{ method: string; params: any; headers: Headers }> = [];
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      const body = (await request.clone().json()) as { id?: number; method: string; params: Record<string, unknown> };
      requests.push({ ...body, headers: request.headers });
      let result: unknown;
      if (body.method === "tools/call") result = { resultType: "task", ...base, status };
      else if (body.method === "tasks/get")
        result = {
          resultType: "complete",
          ...base,
          status,
          ...(status === "input_required"
            ? { inputRequests: { answer: { method: "elicitation/create", params: { message: "Approve?" } } } }
            : {}),
          ...(status === "completed" ? { result: { content: [{ type: "text", text: "done" }] } } : {}),
        };
      else if (body.method === "tasks/update" || body.method === "tasks/cancel") result = { resultType: "complete" };
      else return handler.fetch(request);
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    });
    const ctx = context();
    const [tool] = await provider.getTools();
    const initial = (await tool.execute({ q: "work" }, ctx)) as { content: string };
    const { handle } = JSON.parse(initial.content);
    expect(handle).toMatch(/^mcp:/);
    const count = requests.length;
    await expect(provider.getTask(handle, context("tenant-b"))).rejects.toThrow(/unauthorized/);
    expect(requests).toHaveLength(count);
    status = "input_required";
    expect(await provider.getTask(handle, ctx)).toMatchObject({
      status: "input-required",
      inputRequests: { answer: expect.anything() },
    });
    await provider.respondToTask(handle, { answer: { action: "decline" } }, ctx);
    await expect(provider.respondToTask(handle, { answer: { action: "accept" } }, ctx)).rejects.toThrow(
      /already answered/,
    );
    expect(await provider.cancelTask(handle, ctx)).toMatchObject({
      status: "input-required",
      cancellationRequested: true,
    });
    status = "completed";
    expect(await provider.getTask(handle, ctx)).toMatchObject({ status: "completed", result: { content: "done" } });
    const controller = new AbortController();
    const cancelledContext = new RunContext({
      sessionId: "cancel-session",
      eventBus: new EventBus(),
      signal: controller.signal,
    });
    status = "working";
    const cancellable = (await tool.execute({ q: "cancel this" }, cancelledContext)) as { content: string };
    controller.abort();
    expect(await provider.cancelTask(JSON.parse(cancellable.content).handle, cancelledContext)).toMatchObject({
      cancellationRequested: true,
    });
    for (const request of requests.filter((item) => item.method.startsWith("tasks/"))) {
      expect(request.headers.get("mcp-name")).toBe("server-task");
      expect(request.params._meta["io.modelcontextprotocol/clientCapabilities"].extensions).toHaveProperty(
        "io.modelcontextprotocol/tasks",
      );
    }
  });

  it("rejects unnegotiated Tasks and retains actual legacy SDK interoperability", async () => {
    const { handler } = fixture(false);
    vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      handler.fetch(new Request(input, init)),
    );
    const denied = new MCPV2ToolProvider({
      name: "legacy",
      transport: "http",
      url: "https://fixture.test/mcp",
      tasks: true,
    });
    await expect(denied.connect()).rejects.toThrow(/did not negotiate/);
    const { McpServer: LegacyServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { z } = await import("zod/v3");
    const server = new LegacyServer({ name: "legacy", version: "1" });
    server.tool("echo", { q: z.string() }, async ({ q }) => ({ content: [{ type: "text", text: q }] }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const legacy = new MCPToolProvider({
      name: "legacy",
      transport: "custom",
      transportFactory: () => clientTransport,
    });
    close.push(
      () => legacy.close(),
      () => server.close(),
    );
    const [tool] = await legacy.getTools();
    expect(await tool.execute({ q: "old works" }, context())).toMatchObject({ content: "old works" });
  });
});
