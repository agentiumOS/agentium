import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { afterEach, expect, it, vi } from "vitest";
import { MCPToolProvider } from "../mcp-client.js";
import { MCPV2ToolProvider } from "../mcp-v2.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.unstubAllGlobals();
});

it.each(["legacy", "modern"] as const)(
  "%s closes a transport acquired after close without reopening",
  async (version) => {
    const ready = deferred();
    const factory = deferred<any>();
    const transport = { start: vi.fn(), send: vi.fn(), close: vi.fn(async () => {}) };
    const config = {
      name: "late",
      transport: "custom" as const,
      transportFactory: () => {
        ready.resolve();
        return factory.promise;
      },
    };
    const provider = version === "legacy" ? new MCPToolProvider(config) : new MCPV2ToolProvider(config);
    const connect = provider.connect();
    const rejection = expect(connect).rejects.toThrow(/closed/);
    await ready.promise;
    await provider.close();
    factory.resolve(transport);
    await rejection;
    expect(transport.start).not.toHaveBeenCalled();
    expect(transport.close).toHaveBeenCalledTimes(1);
  },
);

it("legacy initialization waits for discovery and recovers after discovery failure", async () => {
  const entered = deferred();
  const release = deferred();
  let attempts = 0;
  const provider = new MCPToolProvider({
    name: "legacy",
    transport: "custom",
    transportFactory: async () => {
      const [client, transport] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {} } });
      const attempt = ++attempts;
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        if (attempt === 1) {
          entered.resolve();
          await release.promise;
          throw new Error("discovery failed");
        }
        return { tools: [{ name: "ready", inputSchema: { type: "object" as const } }] };
      });
      cleanup.push(() => server.close());
      await server.connect(transport);
      return client;
    },
  });
  cleanup.push(() => provider.close());
  const first = provider.getTools();
  const firstFailure = expect(first).rejects.toThrow(/discovery failed/);
  await entered.promise;
  let settled = false;
  const second = provider.getTools().finally(() => {
    settled = true;
  });
  const secondFailure = expect(second).rejects.toThrow(/discovery failed/);
  await Promise.resolve();
  expect(settled).toBe(false);
  release.resolve();
  await Promise.all([firstFailure, secondFailure]);
  expect((await provider.getTools()).map((tool) => tool.name)).toEqual(["legacy__ready"]);
  expect(attempts).toBe(2);
});

it("modern discovery is shared until the full tool list is ready and endpoint configuration is captured", async () => {
  const entered = deferred();
  const release = deferred();
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "fixture", version: "1" });
    server.registerTool("ready", {}, async () => ({ content: [] }));
    return server;
  });
  const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.method === "POST" && ((await req.clone().json()) as { method?: string }).method === "tools/list") {
      entered.resolve();
      await release.promise;
    }
    return handler.fetch(req);
  });
  vi.stubGlobal("fetch", fetcher);
  const config = {
    name: "modern",
    transport: "http" as const,
    url: "https://trusted.test/mcp",
    headers: { Authorization: "Bearer original" },
    audience: "https://trusted.test/mcp",
  };
  const provider = new MCPV2ToolProvider(config);
  cleanup.push(() => provider.close());
  config.url = "https://other.test/mcp";
  config.headers.Authorization = "Bearer modified";
  const first = provider.getTools();
  await entered.promise;
  let settled = false;
  const second = provider.getTools().finally(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  release.resolve();
  for (const tools of await Promise.all([first, second]))
    expect(tools.map((tool) => tool.name)).toEqual(["modern__ready"]);
  for (const [input, init] of fetcher.mock.calls) {
    const request = new Request(input, init);
    expect(request.url).toBe("https://trusted.test/mcp");
    expect(request.headers.get("authorization")).toBe("Bearer original");
    expect(request.redirect).toBe("error");
  }
});

it("legacy SSE uses complete endpoint events and SDK framing for asynchronous POST responses", async () => {
  const encoder = new TextEncoder();
  let events!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    expect(request.redirect).toBe("error");
    expect(request.headers.get("authorization")).toBe("Bearer fixture");
    if (request.method === "GET")
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            events = controller;
            // Split the endpoint across chunks; do not accept a partial URL.
            controller.enqueue(encoder.encode("event: endpoint\r\ndata: /mess"));
            queueMicrotask(() => controller.enqueue(encoder.encode("ages?session=one\r\n\r\n")));
          },
          cancel,
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    expect(request.url).toBe("https://legacy.test/messages?session=one");
    const body = (await request.json()) as { id?: number; method: string };
    if (body.id !== undefined) {
      const result =
        body.method === "initialize"
          ? {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            }
          : { tools: [{ name: "ready", inputSchema: { type: "object" } }] };
      events.enqueue(
        encoder.encode(`event: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\r\n\r\n`),
      );
    }
    return new Response(null, { status: 202 });
  });
  vi.stubGlobal("fetch", fetcher);
  const provider = new MCPToolProvider({
    name: "sse",
    transport: "sse",
    url: "https://legacy.test/sse",
    headers: { Authorization: "Bearer fixture" },
  });
  cleanup.push(() => provider.close());
  expect((await provider.getTools()).map((tool) => tool.name)).toEqual(["sse__ready"]);
  await provider.close();
  // Native fetch reacts to the abort by cancelling the stream; this injected fixture closes its stream explicitly.
  events.close();
});
