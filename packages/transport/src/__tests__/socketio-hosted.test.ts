import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { io as connect, type Socket } from "socket.io-client";
import { describe, expect, it, vi } from "vitest";
import { createAgentGateway } from "../socketio/gateway.js";
import type { GatewayOptions } from "../socketio/types.js";

async function fixture(overrides: Partial<GatewayOptions> = {}) {
  const http = createServer();
  const server = new Server(http, { maxHttpBufferSize: 32 * 1024 });
  const actors = new Map([
    ["a", { userId: "alice", tenantId: "alpha" }],
    ["b", { userId: "bob", tenantId: "beta" }],
  ]);
  const sessions = new Map<string, string>();
  const calls: any[] = [];
  const sockets: any[] = [];
  const clients: Socket[] = [];
  let denied = false;
  server.of("/agentium").on("connection", (socket) => sockets.push(socket));
  createAgentGateway({
    io: server,
    registry: false,
    agents: {
      bot: {
        async *stream(input: string, opts: any) {
          calls.push({ input, opts });
          yield { type: "text", text: input };
        },
      } as any,
      secret: { stream: vi.fn() } as any,
    },
    teams: {
      squad: {
        run: vi.fn(async (input, opts) => {
          calls.push({ input, opts });
          return { text: input };
        }),
      } as any,
    },
    authMiddleware(socket, next) {
      const token = socket.handshake.auth.token;
      if (!actors.has(token)) return next(new Error("Unauthorized"));
      socket.data.token = token;
      next();
    },
    security: {
      mode: "authenticated",
      resolveIdentity: (data: any) => actors.get(data.token) ?? null,
      authorizeResource: ({ identity, operation, resource }) => {
        if (denied || resource.id === "secret") return false;
        const owner = `${identity.tenantId}:${identity.userId}`;
        if (operation === "session:create") {
          if (sessions.has(resource.id)) return false;
          sessions.set(resource.id, owner);
          return true;
        }
        if (operation === "session:use") return sessions.get(resource.id) === owner;
        return true;
      },
    },
    ...overrides,
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/agentium`;
  return {
    actors,
    sessions,
    calls,
    sockets,
    deny: () => {
      denied = true;
    },
    async connect(token: string, transports = ["websocket"]) {
      const client = connect(url, {
        auth: { token, userId: "forged", apiKey: "untrusted-fixture-key" },
        transports,
        forceNew: true,
        reconnection: false,
      });
      clients.push(client);
      await new Promise<void>((resolve, reject) => {
        client.once("connect", resolve);
        client.once("connect_error", reject);
      });
      return client;
    },
    async close() {
      for (const client of clients) client.disconnect();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function event(socket: Socket, name: string, trigger: () => void): Promise<any> {
  return new Promise((resolve, reject) => {
    const handler = (data: unknown) => {
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(() => {
      socket.off(name, handler);
      reject(new Error(`Missing ${name}`));
    }, 2000);
    socket.once(name, handler);
    trigger();
  });
}

it("requires explicit complete security before namespace setup", () => {
  const io = { of: vi.fn() };
  for (const security of [undefined, { mode: "bad" }, { mode: "authenticated" }]) {
    expect(() => createAgentGateway({ io, security } as any)).toThrow(/security|hooks/);
  }
  expect(() => createAgentGateway({ io, security: { mode: "local" }, authMiddleware() {} })).toThrow(/authenticated/);
  expect(io.of).not.toHaveBeenCalled();
});

describe("real Socket.IO hosted boundary", () => {
  it("binds generated sessions and rejects another tenant, unknown owners, and client claims before effects", async () => {
    const f = await fixture();
    try {
      const a = await f.connect("a");
      const b = await f.connect("b");
      const done = await event(a, "agent.done", () => a.emit("agent.run", { name: "bot", input: "hello" }));
      expect(f.sessions.get(done.sessionId)).toBe("alpha:alice");
      expect(f.calls[0].opts).toMatchObject({
        userId: "alice",
        tenantId: "alpha",
        runId: done.runId,
        sessionId: done.sessionId,
      });
      expect(f.calls[0].opts.apiKey).toBeUndefined();
      for (const data of [
        { sessionId: done.sessionId },
        { sessionId: "ownerless" },
        { userId: "alice" },
        { tenantId: "alpha" },
        { apiKey: "untrusted-fixture" },
        { room: done.sessionId },
        { runId: done.runId },
      ]) {
        const denied = await event(b, "agent.error", () =>
          b.emit("agent.run", { name: "bot", input: "denied", ...data }),
        );
        expect(denied.runId).toBeTypeOf("string");
      }
      expect(f.calls).toHaveLength(1);
      await event(a, "agent.done", () =>
        a.emit("agent.run", { name: "bot", input: "again", sessionId: done.sessionId }),
      );
      expect(f.calls).toHaveLength(2);
    } finally {
      await f.close();
    }
  });

  it("filters discovery and checks fresh host policy for every operation", async () => {
    const f = await fixture();
    try {
      const a = await f.connect("a");
      expect(await a.emitWithAck("agents.list", {})).toEqual([{ name: "bot" }]);
      expect(await a.emitWithAck("registry.list", {})).toMatchObject({ agents: ["bot"], teams: ["squad"] });
      f.deny();
      expect(await a.emitWithAck("agents.list", {})).toEqual([]);
      await event(a, "agent.error", () => a.emit("team.run", { name: "squad", input: "denied" }));
      expect(f.calls).toHaveLength(0);
      f.actors.delete("a");
      expect(await a.emitWithAck("teams.list", {})).toEqual({ error: "Request denied" });
    } finally {
      await f.close();
    }
  });

  it("correlates concurrent runs and observes binary malformed events on polling and WebSocket", async () => {
    const f = await fixture();
    try {
      for (const transports of [["websocket"], ["polling"]]) {
        const a = await f.connect("a", transports);
        const chunks: any[] = [];
        const done: any[] = [];
        a.on("agent.chunk", (value) => chunks.push(value));
        a.on("agent.done", (value) => done.push(value));
        await event(a, "agent.error", () => a.emit("agent.run", { name: "bot", input: Buffer.from("invalid") }));
        a.emit("agent.run", { name: "bot", input: "one" });
        a.emit("agent.run", { name: "bot", input: "two" });
        await vi.waitFor(() => expect(done).toHaveLength(2));
        expect(new Set(done.map((v) => v.runId)).size).toBe(2);
        for (const result of done)
          expect(chunks.find((v) => v.runId === result.runId)).toMatchObject({
            sessionId: result.sessionId,
            chunk: result.output.text,
          });
        a.disconnect();
      }
    } finally {
      await f.close();
    }
  });

  it("disconnect aborts the owned iterator, observes rejecting cleanup, and emits no late terminal", async () => {
    let signal: AbortSignal | undefined;
    let returns = 0;
    let settle: (() => void) | undefined;
    const f = await fixture({
      agents: {
        bot: {
          stream(_input: string, opts: any) {
            signal = opts.signal;
            return {
              [Symbol.asyncIterator]() {
                return this;
              },
              next: () =>
                new Promise((resolve) => {
                  settle = () => resolve({ done: true, value: undefined });
                }),
              return: async () => {
                returns++;
                settle!();
                throw new Error("fixture cleanup rejection");
              },
            };
          },
        } as any,
      },
    });
    try {
      const a = await f.connect("a");
      a.emit("agent.run", { name: "bot", input: "wait" });
      await vi.waitFor(() => expect(signal).toBeDefined());
      const serverSocket = f.sockets[0];
      const emits = vi.spyOn(serverSocket, "emit");
      a.disconnect();
      await vi.waitFor(() => expect(returns).toBe(1));
      expect(signal?.aborted).toBe(true);
      expect(serverSocket.listenerCount("agent.run")).toBe(0);
      expect(serverSocket.listenerCount("run.cancel")).toBe(0);
      expect(emits.mock.calls.some((v) => ["agent.done", "agent.error"].includes(v[0] as string))).toBe(false);
    } finally {
      await f.close();
    }
  });

  it("cancel is owned and terminal publication waits for effect settlement", async () => {
    let settle: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    const f = await fixture({
      teams: {
        squad: {
          async run(_input: string, opts: any) {
            signal = opts.signal;
            await new Promise<void>((resolve) => {
              settle = resolve;
            });
            return { text: "settled" };
          },
        } as any,
      },
    });
    try {
      const a = await f.connect("a");
      const b = await f.connect("b");
      const start = await event(a, "agent.started", () => a.emit("team.run", { name: "squad", input: "wait" }));
      await vi.waitFor(() => expect(signal).toBeDefined());
      expect(await b.emitWithAck("run.cancel", { runId: start.runId })).toEqual({ error: "Request denied" });
      expect(signal?.aborted).toBe(false);
      const terminals: unknown[] = [];
      a.on("agent.done", (v) => terminals.push(v));
      a.on("agent.error", (v) => terminals.push(v));
      expect(await a.emitWithAck("run.cancel", { runId: start.runId })).toMatchObject({
        status: "cancellation_requested",
      });
      expect(signal?.aborted).toBe(true);
      expect(terminals).toHaveLength(0);
      settle!();
      await vi.waitFor(() => expect(terminals).toHaveLength(1));
      expect(terminals[0]).toMatchObject({ runId: start.runId, error: "Run failed or denied" });
    } finally {
      settle?.();
      await f.close();
    }
  });

  it("reserves pending admissions and rejects concurrency before invoking another host hook", async () => {
    let release: (() => void) | undefined;
    const authorization = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return true;
    });
    const run = vi.fn();
    const f = await fixture({
      maxConcurrentRuns: 1,
      agents: { bot: { stream: run } as any },
      security: {
        mode: "authenticated",
        resolveIdentity: () => ({ userId: "host" }),
        authorizeResource: authorization,
      },
    });
    try {
      const a = await f.connect("a");
      a.emit("agent.run", { name: "bot", input: "pending" });
      await vi.waitFor(() => expect(authorization).toHaveBeenCalledTimes(1));
      expect(await event(a, "agent.error", () => a.emit("agent.run", { name: "bot", input: "excess" }))).toMatchObject({
        error: "Concurrent run limit exceeded",
      });
      a.disconnect();
      await vi.waitFor(() => expect(f.sockets[0].connected).toBe(false));
      release!();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(run).not.toHaveBeenCalled();
      expect(authorization).toHaveBeenCalledTimes(1);
    } finally {
      release?.();
      await f.close();
    }
  });
});

it("bounds a stalled socket transport, stops production and releases drain listeners", async () => {
  let closed = false;
  let generated = 0;
  let producerSignal: AbortSignal | undefined;
  const f = await fixture({
    textStream: { maxFrameBytes: 512, maxBufferedBytes: 768, writeTimeoutMs: 30 },
    agents: {
      bot: {
        async *stream(_input: string, opts: any) {
          producerSignal = opts.signal;
          try {
            while (true) {
              generated++;
              yield { type: "text", text: "x".repeat(128) };
            }
          } finally {
            closed = true;
          }
        },
      } as any,
    },
  });
  try {
    const a = await f.connect("a");
    const serverSocket = f.sockets[0];
    const transport = serverSocket.conn.transport;
    const baselineReady = transport.listenerCount("ready");
    const baselineDrain = transport.listenerCount("drain");
    const originalEmit = serverSocket.emit.bind(serverSocket);
    vi.spyOn(serverSocket, "emit").mockImplementation((...args: any[]) => {
      // Deterministically emulate a transport that stops becoming writable after the first text frame.
      if (args[0] === "agent.chunk") {
        transport.writable = false;
        return true;
      }
      return originalEmit(...args);
    });
    a.emit("agent.run", { name: "bot", input: "slow" });
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(generated).toBe(1);
    expect(producerSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(serverSocket.connected).toBe(false));
    expect(transport.listenerCount("ready")).toBeLessThanOrEqual(baselineReady);
    expect(transport.listenerCount("drain")).toBeLessThanOrEqual(baselineDrain);
    expect(serverSocket.conn.listenerCount("upgrade")).toBe(0);
  } finally {
    await f.close();
  }
});

it("limits individual frames and collected output before sending an oversized result", async () => {
  for (const text of ["x".repeat(1024), "x".repeat(40)]) {
    let cleaned = 0;
    const f = await fixture({
      textStream: { maxFrameBytes: 512 },
      maxOutputBytes: 64,
      agents: {
        bot: {
          async *stream() {
            try {
              yield { type: "text", text };
              yield { type: "text", text };
            } finally {
              cleaned++;
            }
          },
        } as any,
      },
    });
    try {
      const a = await f.connect("a");
      const result = await event(a, "agent.error", () => a.emit("agent.run", { name: "bot", input: "bounded" }));
      expect(result.runId).toBeTypeOf("string");
      expect(cleaned).toBe(1);
    } finally {
      await f.close();
    }
  }
});

it("passes verified identity and cancellation through Workflow runs and denies tool discovery", async () => {
  const run = vi.fn(async (opts) => ({ userId: opts.userId, tenantId: opts.tenantId }));
  const f = await fixture({ serve: [{ kind: "workflow", name: "flow", run } as any] });
  try {
    const a = await f.connect("a");
    const done = await event(a, "agent.done", () => a.emit("workflow.run", { name: "flow" }));
    expect(done.output).toEqual({ userId: "alice", tenantId: "alpha" });
    expect(run.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
    f.deny();
    expect(await a.emitWithAck("tools.get", { name: "secret" })).toEqual({ error: "Request denied" });
    expect(await a.emitWithAck("tools.list", {})).toEqual([]);
  } finally {
    await f.close();
  }
});

it("cancellation during started-frame backpressure prevents runtime admission", async () => {
  const run = vi.fn();
  let start: any;
  let canceled = false;
  const f = await fixture({
    agents: { bot: { stream: run } as any },
    security: {
      mode: "authenticated",
      resolveIdentity: () => ({ userId: "host" }),
      authorizeResource: ({ operation }) => {
        if (operation === "run:cancel") canceled = true;
        return true;
      },
    },
  });
  try {
    const a = await f.connect("a");
    const serverSocket = f.sockets[0];
    const transport = serverSocket.conn.transport;
    const originalEmit = serverSocket.emit.bind(serverSocket);
    vi.spyOn(serverSocket, "emit").mockImplementation((...args: any[]) => {
      if (args[0] === "agent.started") {
        start = args[1];
        transport.writable = false;
        return true;
      }
      return originalEmit(...args);
    });
    a.emit("agent.run", { name: "bot", input: "cancel before work" });
    await vi.waitFor(() => expect(start).toBeDefined());
    a.emit("run.cancel", { runId: start.runId });
    await vi.waitFor(() => expect(canceled).toBe(true));
    const terminal = event(a, "agent.error", () => {
      transport.writable = true;
      transport.emit("ready");
    });
    await terminal;
    expect(run).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it.each(["throw", "reject", "next-then-throw", "next-then-reject"])(
  "denies %s authentication without admitting runtime work or exposing error details",
  async (mode) => {
    const run = vi.fn();
    const f = await fixture({
      agents: { bot: { stream: run } as any },
      authMiddleware(_socket, next) {
        if (mode.startsWith("next-")) next();
        const error = new Error("private credential verification detail");
        if (mode.endsWith("reject")) return Promise.reject(error);
        throw error;
      },
    });
    try {
      await expect(f.connect("a")).rejects.toThrow(/^Authentication failed$/);
      expect(f.sockets).toHaveLength(0);
      expect(run).not.toHaveBeenCalled();
      expect(f.sessions.size).toBe(0);
    } finally {
      await f.close();
    }
  },
);

it("waits for authentication promise settlement and admits only once when next is repeated", async () => {
  let settled = false;
  const f = await fixture({
    async authMiddleware(socket, next) {
      socket.data.token = "a";
      next();
      next(new Error("duplicate callback"));
      await Promise.resolve();
      settled = true;
      next();
    },
  });
  try {
    const a = await f.connect("a");
    expect(settled).toBe(true);
    expect(f.sockets).toHaveLength(1);
    await event(a, "agent.done", () => a.emit("agent.run", { name: "bot", input: "once" }));
    expect(f.calls).toHaveLength(1);
    expect(f.sessions.size).toBe(1);
  } finally {
    await f.close();
  }
});
