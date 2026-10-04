import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { InMemoryStorage } from "../../storage/in-memory.js";
import type { RealtimeConnection } from "../types.js";
import { VoiceAgent } from "../voice-agent.js";

function fixture(tenantId?: string) {
  const connect = vi.fn(
    async () =>
      Object.assign(new EventEmitter(), {
        sendAudio: vi.fn(),
        sendText: vi.fn(),
        sendImage: vi.fn(),
        commitAudio: vi.fn(),
        interrupt: vi.fn(),
        close: vi.fn(async () => {}),
        sendToolResult: vi.fn(),
        createResponse: vi.fn(),
      }) as RealtimeConnection,
  );
  const agent = new VoiceAgent({
    name: "scoped-memory",
    provider: { providerId: "fixture", modelId: "fixture", connect },
    memory: { storage: new InMemoryStorage(), summaries: false, tenantId },
  });
  const ready = vi.spyOn(agent.memory!, "ensureReady").mockResolvedValue(undefined);
  const context = vi.spyOn(agent.memory!, "buildContext").mockResolvedValue("");
  return { agent, connect, ready, context };
}

it("reserves memory ownership before asynchronous setup and rejects concurrent or later identity changes", async () => {
  const f = fixture();
  let release!: () => void;
  f.ready.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const owner = { tenantId: "tenant-a", userId: "actor-a", sessionId: "session" };
  const first = f.agent.connect(owner);
  await vi.waitFor(() => expect(f.ready).toHaveBeenCalledOnce());
  await expect(f.agent.connect({ ...owner, tenantId: "tenant-b" })).rejects.toThrow(/bound to another/);
  await expect(f.agent.connect({ ...owner, userId: "actor-b" })).rejects.toThrow(/bound to another/);
  expect(f.ready).toHaveBeenCalledOnce();
  expect(f.context).not.toHaveBeenCalled();
  expect(f.connect).not.toHaveBeenCalled();
  release();
  await (await first).close();
  f.ready.mockClear();
  f.context.mockClear();
  f.connect.mockClear();
  for (const identity of [{ ...owner, tenantId: "tenant-b" }, { ...owner, userId: "actor-b" }, {}]) {
    await expect(f.agent.connect(identity)).rejects.toThrow(/bound to another/);
  }
  expect(f.ready).not.toHaveBeenCalled();
  expect(f.context).not.toHaveBeenCalled();
  expect(f.connect).not.toHaveBeenCalled();
  await (await f.agent.connect(owner)).close();
  expect(f.ready).toHaveBeenCalledOnce();
  expect(f.context).toHaveBeenCalledOnce();
  expect(f.connect).toHaveBeenCalledOnce();
});

it("rejects an explicit memory tenant mismatch even on the first connection", async () => {
  const f = fixture("tenant-a");
  await expect(f.agent.connect({ tenantId: "tenant-b", userId: "actor" })).rejects.toThrow(/configured tenant/);
  expect(f.ready).not.toHaveBeenCalled();
  expect(f.context).not.toHaveBeenCalled();
  expect(f.connect).not.toHaveBeenCalled();
  // Omitting the tenant uses the explicitly configured tenant and does not poison ownership.
  await (await f.agent.connect({ userId: "actor" })).close();
  await (await f.agent.connect({ tenantId: "tenant-a", userId: "actor" })).close();
  expect(f.connect).toHaveBeenCalledTimes(2);
});
