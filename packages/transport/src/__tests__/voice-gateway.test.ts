import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createVoiceGateway } from "../socketio/voice-gateway.js";

function fixture(options: Record<string, unknown> = {}, deferred = false) {
  const listeners = new Map<string, Function>();
  const socket = {
    id: "socket",
    data: { auth: { userId: "trusted", tenantId: "tenant", sessionId: "safe" } },
    on: (event: string, handler: Function) => listeners.set(event, handler),
    emit: vi.fn(),
  };
  const session = Object.assign(new EventEmitter(), {
    close: vi.fn(async () => {}),
    sendAudio: vi.fn(),
    sendText: vi.fn(),
    interrupt: vi.fn(),
    commitAudio: vi.fn(),
    acknowledgePlayback: vi.fn(),
  });
  let resolve!: (value: any) => void;
  const connect = vi.fn(async (_options: unknown) =>
    deferred
      ? new Promise((r) => {
          resolve = r;
        })
      : session,
  );
  const namespace = { use: vi.fn(), on: (_event: string, handler: Function) => handler(socket) };
  createVoiceGateway({
    agents: { voice: { connect, audioFormats: { input: {}, output: {} } } as any },
    io: { of: () => namespace },
    ...options,
  });
  return {
    socket,
    session,
    connect,
    invoke: (event: string, data?: unknown) => listeners.get(event)!(data),
    resolve: () => resolve(session),
  };
}
describe("voice transport lifecycle", () => {
  it("reserves pending setup and closes late connects after disconnect", async () => {
    const f = fixture({}, true);
    const start = f.invoke("voice.start", { agentName: "voice" });
    await f.invoke("voice.start", { agentName: "voice" });
    expect(f.connect).toHaveBeenCalledTimes(1);
    f.invoke("disconnect");
    f.resolve();
    await start;
    expect(f.session.close).toHaveBeenCalledTimes(1);
    expect(f.socket.emit).not.toHaveBeenCalledWith("voice.started", expect.anything());
  });
  it("ignores client identity/key overrides in authenticated mode", async () => {
    const f = fixture({ authMiddleware: () => {} });
    await f.invoke("voice.start", { agentName: "voice", userId: "attacker", sessionId: "other", apiKey: "secret" });
    expect(f.connect).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "trusted", tenantId: "tenant", sessionId: "safe" }),
    );
    expect(f.connect.mock.calls[0][0]).not.toHaveProperty("apiKey");
    await f.invoke("voice.stop");
  });
  it("bounds pending output until acknowledged and clears it on interruption", async () => {
    const f = fixture({ maxPendingAudioBytes: 4 });
    await f.invoke("voice.start", { agentName: "voice" });
    f.session.emit("audio", { data: Buffer.alloc(4), generationId: "g" });
    f.invoke("voice.playback.ack", { sequence: 0 });
    f.session.emit("audio", { data: Buffer.alloc(4), generationId: "g" });
    f.session.emit("interrupted");
    f.session.emit("audio", { data: Buffer.alloc(4), generationId: "g2" });
    expect(f.session.close).not.toHaveBeenCalled();
    f.session.emit("audio", { data: Buffer.alloc(2), generationId: "g2" });
    await vi.waitFor(() => expect(f.session.close).toHaveBeenCalledOnce());
  });
  it("times out stalled playback and rejects malformed base64", async () => {
    vi.useFakeTimers();
    const f = fixture({ playbackAckTimeoutMs: 10 });
    await f.invoke("voice.start", { agentName: "voice" });
    f.session.emit("audio", { data: Buffer.alloc(4) });
    await vi.advanceTimersByTimeAsync(11);
    expect(f.session.close).toHaveBeenCalled();
    vi.useRealTimers();
    const bad = fixture();
    await bad.invoke("voice.start", { agentName: "voice" });
    bad.invoke("voice.audio", { data: "%%%" });
    expect(bad.session.sendAudio).not.toHaveBeenCalled();
    expect(bad.session.close).toHaveBeenCalled();
  });
});

it("does not accept a generation belonging to another audio frame", async () => {
  const f = fixture();
  await f.invoke("voice.start", { agentName: "voice" });
  f.session.emit("audio", { data: Buffer.alloc(4), generationId: "current" });
  f.invoke("voice.playback.ack", { sequence: 0, generationId: "other", complete: true });
  expect(f.session.acknowledgePlayback).not.toHaveBeenCalled();
  expect(f.session.close).toHaveBeenCalled();
});
it("ignores stale session events and acknowledgements after interruption or replacement", async () => {
  const f = fixture();
  await f.invoke("voice.start", { agentName: "voice" });
  f.session.emit("audio", { data: Buffer.alloc(4), generationId: "old" });
  f.invoke("voice.interrupt");
  f.invoke("voice.playback.complete", { generationId: "old" });
  expect(f.session.acknowledgePlayback).not.toHaveBeenCalled();
  await f.invoke("voice.stop");
  const next = Object.assign(new EventEmitter(), { close: vi.fn(async () => {}) });
  f.connect.mockResolvedValueOnce(next as any);
  await f.invoke("voice.start", { agentName: "voice" });
  f.socket.emit.mockClear();
  f.session.emit("tool_call_start", { tool: "old" });
  f.session.emit("tool_result", { result: "old" });
  f.session.emit("interrupted");
  f.session.emit("error", { error: new Error("old") });
  expect(f.socket.emit).not.toHaveBeenCalled();
  await f.invoke("voice.stop");
});

it("forwards recovery state, discards capture during reconnect, and resumes without replay or closure", async () => {
  const f = fixture();
  await f.invoke("voice.start", { agentName: "voice" });
  f.session.emit("audio", { data: Buffer.alloc(4), generationId: "old" });
  f.session.emit("interrupted");
  const recovering = {
    status: "recovering",
    attempt: 1,
    continuity: "session-resumption",
    reason: "disconnected",
    requiresInput: true,
  };
  f.session.emit("recovery", recovering);
  f.invoke("voice.audio", { data: "AQA=" });
  f.invoke("voice.audio", { data: "%%%" });
  f.invoke("voice.commit");
  f.invoke("voice.text", { text: "not queued" });
  f.invoke("voice.playback.complete", { generationId: "old" });
  expect(f.socket.emit).toHaveBeenCalledWith("voice.recovery", recovering);
  expect(f.socket.emit).toHaveBeenCalledWith("voice.clear");
  expect(f.session.sendAudio).not.toHaveBeenCalled();
  expect(f.session.sendText).not.toHaveBeenCalled();
  expect(f.session.commitAudio).not.toHaveBeenCalled();
  expect(f.session.acknowledgePlayback).not.toHaveBeenCalled();
  expect(f.session.close).not.toHaveBeenCalled();
  f.session.emit("recovery", { ...recovering, status: "recovered" });
  expect(f.session.sendAudio).not.toHaveBeenCalled();
  f.invoke("voice.audio", { data: "AQA=" });
  f.invoke("voice.text", { text: "new input" });
  f.invoke("voice.commit");
  expect(f.session.sendAudio).toHaveBeenCalledOnce();
  expect(f.session.sendText).toHaveBeenCalledExactlyOnceWith("new input");
  expect(f.session.commitAudio).toHaveBeenCalledOnce();
  await f.invoke("voice.stop");
});

it("ignores retired recovery notifications after a replacement session starts", async () => {
  const f = fixture();
  await f.invoke("voice.start", { agentName: "voice" });
  await f.invoke("voice.stop");
  const next = Object.assign(new EventEmitter(), { close: vi.fn(async () => {}), sendAudio: vi.fn() });
  f.connect.mockResolvedValueOnce(next);
  await f.invoke("voice.start", { agentName: "voice" });
  f.socket.emit.mockClear();
  f.session.emit("recovery", { status: "recovering", attempt: 1, reason: "disconnected", requiresInput: true });
  f.invoke("voice.audio", { data: "AQA=" });
  expect(next.sendAudio).toHaveBeenCalledOnce();
  expect(f.socket.emit).not.toHaveBeenCalledWith("voice.recovery", expect.anything());
  await f.invoke("voice.stop");
});
