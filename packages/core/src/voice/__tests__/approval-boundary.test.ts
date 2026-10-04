import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";
import { EventBus } from "../../events/event-bus.js";
import type { RealtimeConnection, RealtimeProvider } from "../types.js";
import { VoiceAgent } from "../voice-agent.js";

function fixture(options: Record<string, unknown> = {}) {
  const emitter = new EventEmitter();
  const connection = Object.assign(emitter, {
    sendAudio: vi.fn(),
    sendText: vi.fn(),
    sendImage: vi.fn(),
    sendToolResult: vi.fn(),
    createResponse: vi.fn(),
    commitAudio: vi.fn(),
    interrupt: vi.fn(),
    close: vi.fn(async () => {}),
  });
  const provider: RealtimeProvider = {
    providerId: "test",
    modelId: "test",
    connect: vi.fn(async () => connection as unknown as RealtimeConnection),
  };
  const execute = vi.fn(async (_args, ctx) => `${ctx.userId}/${ctx.tenantId}`);
  const eventBus = new EventBus();
  const agent = new VoiceAgent({
    name: "voice-policy",
    provider,
    eventBus,
    toolCallBehavior: "silent",
    tools: [
      {
        name: "write",
        description: "Write",
        parameters: z.object({ value: z.string() }),
        execute,
        requiresApproval: true,
      },
    ],
    ...options,
  });
  let callIndex = 0;
  const call = (args = '{"value":"x"}') =>
    emitter.emit("tool_call", { id: `call-${++callIndex}`, name: "write", arguments: args });
  return { agent, eventBus, execute, connection, call };
}

describe("voice execution boundary", () => {
  it("fails closed when a tool asks without an approver", async () => {
    const f = fixture();
    const session = await f.agent.connect();
    f.call();
    await vi.waitFor(() => expect(f.connection.sendToolResult).toHaveBeenCalled());
    expect(f.execute).not.toHaveBeenCalled();
    await session.close();
  });

  it("uses the shared public approval service and scoped identity", async () => {
    const f = fixture({ approval: { policy: "none" } });
    f.eventBus.on("tool.approval.request", (request) => f.agent.approvalManager!.approve(request.requestId));
    const session = await f.agent.connect({ userId: "user", tenantId: "tenant" });
    f.call();
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
    expect(f.execute.mock.calls[0][1].tenantId).toBe("tenant");
    expect(f.connection.sendToolResult).toHaveBeenCalledWith("call-1", "user/tenant");
    await session.close();
  });

  it.each(["interrupt", "close"] as const)("revokes pending approval on %s", async (operation) => {
    const f = fixture({ approval: { policy: "all" } });
    const session = await f.agent.connect();
    f.call();
    await vi.waitFor(() => expect(f.agent.approvalManager!.listPending()).toHaveLength(1));
    const request = f.agent.approvalManager!.listPending()[0];
    await session[operation]();
    f.agent.approvalManager!.approve(request.requestId);
    await vi.waitFor(() => expect(f.agent.approvalManager!.listPending()).toHaveLength(0));
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.connection.sendToolResult).not.toHaveBeenCalled();
    if (operation === "interrupt") await session.close();
  });

  it("rejects invalid JSON/schema arguments before approval", async () => {
    const f = fixture({ approval: { policy: "all" } });
    const session = await f.agent.connect();
    f.call("not-json");
    f.call('{"value":4}');
    await vi.waitFor(() => expect(f.connection.sendToolResult).toHaveBeenCalledTimes(2));
    expect(f.agent.approvalManager!.listPending()).toHaveLength(0);
    expect(f.execute).not.toHaveBeenCalled();
    await session.close();
  });

  it("host denial overrides the configured approver", async () => {
    const approve = vi.fn(async () => ({ approved: true }));
    const f = fixture({
      approval: { policy: "all", onApproval: approve },
      executionPolicy: { decide: () => ({ action: "deny", reason: "blocked" }) },
    });
    const session = await f.agent.connect();
    f.call();
    await vi.waitFor(() => expect(f.connection.sendToolResult).toHaveBeenCalled());
    expect(f.execute).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
    await session.close();
  });
});
