import { registry } from "@agentium/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentGateway } from "../socketio/gateway.js";

function mockSocket() {
  const handlers: Record<string, Function> = {};
  return {
    id: "sock-1",
    handshake: { auth: {} },
    on: vi.fn((event: string, handler: Function) => {
      handlers[event] = handler;
    }),
    emit: vi.fn(),
    _trigger: (event: string, data: any) => handlers[event]?.(data),
    _triggerWithAck: (event: string, data: any): Promise<any> =>
      new Promise((resolve) => handlers[event]?.(data, resolve)),
  };
}

function mockIO() {
  let connectionHandler: Function;
  const nsUse = vi.fn();
  return {
    of: vi.fn(() => ({
      use: nsUse,
      on: vi.fn((event: string, handler: Function) => {
        if (event === "connection") connectionHandler = handler;
      }),
    })),
    _connectSocket: (socket: any) => connectionHandler(socket),
    _nsUse: nsUse,
  };
}

beforeEach(() => {
  registry.clear();
});

describe("createAgentGateway", () => {
  it("creates namespace with default /agentium", () => {
    const io = mockIO();
    createAgentGateway({ io: io as any, agents: {}, registry: false });
    expect(io.of).toHaveBeenCalledWith("/agentium");
  });

  it("creates namespace with custom name", () => {
    const io = mockIO();
    createAgentGateway({ io: io as any, agents: {}, namespace: "/custom", registry: false });
    expect(io.of).toHaveBeenCalledWith("/custom");
  });

  it("applies auth middleware when provided", () => {
    const io = mockIO();
    const authFn = vi.fn();
    createAgentGateway({ io: io as any, agents: {}, authMiddleware: authFn, registry: false });
    expect(io._nsUse).toHaveBeenCalledWith(authFn);
  });

  it("emits error when agent not found", async () => {
    const io = mockIO();
    createAgentGateway({ io: io as any, agents: {}, registry: false });

    const socket = mockSocket();
    io._connectSocket(socket);

    await socket._trigger("agent.run", { name: "unknown", input: "hi" });

    expect(socket.emit).toHaveBeenCalledWith("agent.error", {
      error: expect.stringContaining("unknown"),
    });
  });

  it("streams agent response and emits done", async () => {
    const io = mockIO();

    async function* fakeStream() {
      yield { type: "text", text: "Hello" };
      yield { type: "text", text: " world" };
    }

    const fakeAgent = {
      stream: vi.fn(() => fakeStream()),
    };

    createAgentGateway({
      io: io as any,
      agents: { bot: fakeAgent as any },
      registry: false,
    });

    const socket = mockSocket();
    io._connectSocket(socket);

    await socket._trigger("agent.run", { name: "bot", input: "hi" });

    const emittedEvents = socket.emit.mock.calls.map(([e]: any) => e);
    expect(emittedEvents).toContain("agent.chunk");
    expect(emittedEvents).toContain("agent.done");
  });

  it("auto-discovers agents from serve array", async () => {
    const io = mockIO();

    async function* fakeStream() {
      yield { type: "text", text: "discovered" };
    }

    const fakeAgent = {
      kind: "agent",
      name: "auto-bot",
      stream: vi.fn(() => fakeStream()),
    };

    createAgentGateway({
      io: io as any,
      serve: [fakeAgent as any],
      registry: false,
    });

    const socket = mockSocket();
    io._connectSocket(socket);

    await socket._trigger("agent.run", { name: "auto-bot", input: "hello" });

    const emittedEvents = socket.emit.mock.calls.map(([e]: any) => e);
    expect(emittedEvents).toContain("agent.done");
  });

  it("auto-discovers teams from serve array", async () => {
    const io = mockIO();

    const fakeTeam = {
      kind: "team",
      name: "auto-squad",
      run: vi.fn().mockResolvedValue({ text: "team result" }),
    };

    createAgentGateway({
      io: io as any,
      serve: [fakeTeam as any],
      registry: false,
    });

    const socket = mockSocket();
    io._connectSocket(socket);

    await socket._trigger("team.run", { name: "auto-squad", input: "go" });

    expect(socket.emit).toHaveBeenCalledWith("agent.done", {
      output: { text: "team result" },
    });
  });
});

describe("createAgentGateway — live registry", () => {
  it("resolves agents added to registry AFTER gateway creation", async () => {
    const io = mockIO();

    createAgentGateway({ io: io as any, registry });

    async function* fakeStream() {
      yield { type: "text", text: "live" };
    }
    const lateAgent = {
      kind: "agent",
      name: "late-bot",
      stream: vi.fn(() => fakeStream()),
    };
    registry.add(lateAgent as any);

    const socket = mockSocket();
    io._connectSocket(socket);

    await socket._trigger("agent.run", { name: "late-bot", input: "hello" });

    const emittedEvents = socket.emit.mock.calls.map(([e]: any) => e);
    expect(emittedEvents).toContain("agent.done");
  });

  it("resolves teams added to registry AFTER gateway creation", async () => {
    const io = mockIO();

    createAgentGateway({ io: io as any, registry });

    const lateTeam = {
      kind: "team",
      name: "late-squad",
      run: vi.fn().mockResolvedValue({ text: "dynamic team" }),
    };
    registry.add(lateTeam as any);

    const socket = mockSocket();
    io._connectSocket(socket);

    await socket._trigger("team.run", { name: "late-squad", input: "go" });

    expect(socket.emit).toHaveBeenCalledWith("agent.done", {
      output: { text: "dynamic team" },
    });
  });

  it("returns error for agents not in registry", async () => {
    const io = mockIO();

    createAgentGateway({ io: io as any, registry });

    const socket = mockSocket();
    io._connectSocket(socket);

    await socket._trigger("agent.run", { name: "ghost", input: "hello" });

    expect(socket.emit).toHaveBeenCalledWith("agent.error", {
      error: expect.stringContaining("ghost"),
    });
  });

  it("uses global registry by default", async () => {
    const io = mockIO();

    createAgentGateway({ io: io as any });

    async function* fakeStream() {
      yield { type: "text", text: "global" };
    }
    registry.add({ kind: "agent", name: "global-agent", stream: vi.fn(() => fakeStream()) } as any);

    const socket = mockSocket();
    io._connectSocket(socket);

    await socket._trigger("agent.run", { name: "global-agent", input: "hi" });

    const emittedEvents = socket.emit.mock.calls.map(([e]: any) => e);
    expect(emittedEvents).toContain("agent.done");
  });
});

describe("createAgentGateway — list events", () => {
  it("agents.list returns agent metadata from registry", async () => {
    const io = mockIO();

    registry.add({
      kind: "agent",
      name: "bot",
      modelId: "gpt-4o",
      providerId: "openai",
      tools: [{ name: "search" }],
      hasStructuredOutput: false,
    } as any);

    createAgentGateway({ io: io as any, registry });

    const socket = mockSocket();
    io._connectSocket(socket);

    const result = await socket._triggerWithAck("agents.list", {});
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "bot",
      model: "gpt-4o",
      provider: "openai",
      tools: ["search"],
      hasStructuredOutput: false,
    });
  });

  it("teams.list returns team metadata from registry", async () => {
    const io = mockIO();

    registry.add({ kind: "team", name: "squad" } as any);

    createAgentGateway({ io: io as any, registry });

    const socket = mockSocket();
    io._connectSocket(socket);

    const result = await socket._triggerWithAck("teams.list", {});
    expect(result).toEqual([{ name: "squad" }]);
  });

  it("workflows.list returns workflow metadata from registry", async () => {
    const io = mockIO();

    registry.add({ kind: "workflow", name: "pipe" } as any);

    createAgentGateway({ io: io as any, registry });

    const socket = mockSocket();
    io._connectSocket(socket);

    const result = await socket._triggerWithAck("workflows.list", {});
    expect(result).toEqual([{ name: "pipe" }]);
  });

  it("registry.list returns all registered names", async () => {
    const io = mockIO();

    registry.add({ kind: "agent", name: "bot" } as any);
    registry.add({ kind: "team", name: "squad" } as any);

    createAgentGateway({ io: io as any, registry });

    const socket = mockSocket();
    io._connectSocket(socket);

    const result = await socket._triggerWithAck("registry.list", {});
    expect(result.agents).toContain("bot");
    expect(result.teams).toContain("squad");
    expect(result.workflows).toEqual([]);
  });

  it("agents.list falls back to opts.agents when registry is disabled", async () => {
    const io = mockIO();

    const fakeAgent = { stream: vi.fn() };
    createAgentGateway({ io: io as any, agents: { myBot: fakeAgent as any }, registry: false });

    const socket = mockSocket();
    io._connectSocket(socket);

    const result = await socket._triggerWithAck("agents.list", {});
    expect(result).toEqual([{ name: "myBot" }]);
  });
});
