import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod/v3";
import { InMemoryStorage } from "../../storage/in-memory.js";
import { GoogleLiveConnection, GoogleLiveProvider } from "../providers/google-live.js";
import { OpenAIRealtimeConnection, OpenAIRealtimeProvider } from "../providers/openai-realtime.js";
import { RecoveringRealtimeConnection } from "../recovery.js";
import type { RealtimeConnection, RealtimeRecoveryState, RealtimeSessionConfig } from "../types.js";
import { VoiceAgent } from "../voice-agent.js";

const policy = { initialDelayMs: 0, maxDelayMs: 0 };
const sessions: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  vi.useRealTimers();
});
function google() {
  const connections: GoogleLiveConnection[] = [];
  const sdks: Array<ReturnType<typeof sdk>> = [];
  const connect = vi.fn(async (_config: RealtimeSessionConfig) => {
    const transport = sdk();
    const connection = new GoogleLiveConnection(transport);
    sdks.push(transport);
    connections.push(connection);
    return connection;
  });
  return {
    connections,
    sdks,
    provider: {
      providerId: "google-live",
      modelId: "fixture",
      capabilities: new GoogleLiveProvider().capabilities,
      connect,
    },
  };
}
function sdk() {
  return { close: vi.fn(), sendToolResponse: vi.fn(), sendClientContent: vi.fn(), sendRealtimeInput: vi.fn() };
}
function checkpoint(connection: GoogleLiveConnection, handle = "scoped-handle") {
  connection._handleMessage({ sessionResumptionUpdate: { resumable: true, newHandle: handle } });
}
function speech(connection: GoogleLiveConnection, text = "hello") {
  connection._handleMessage({
    serverContent: {
      modelTurn: { parts: [{ inlineData: { data: "AQA=", mimeType: "audio/pcm;rate=24000" } }] },
      outputTranscription: { text },
      turnComplete: true,
    },
  });
}

it("resumes Gemini from an idle checkpoint, fences stale events, and never replays speech or inputs", async () => {
  const fixture = google();
  const session = await new VoiceAgent({ name: "voice", provider: fixture.provider, recovery: policy }).connect({
    tenantId: "a",
    userId: "u",
  });
  sessions.push(session);
  const states: RealtimeRecoveryState[] = [];
  const audio = vi.fn();
  const handles = vi.fn();
  session.on("recovery", (state) => states.push(state));
  session.on("audio", audio);
  session.on("session_resume", handles);
  speech(fixture.connections[0]);
  checkpoint(fixture.connections[0]);
  fixture.connections[0].emit("go_away", {});
  expect(() => session.sendText("not queued")).toThrow(/unavailable/);
  await vi.waitFor(() => expect(states.at(-1)?.status).toBe("recovered"));
  expect(fixture.provider.connect.mock.calls[1][0].sessionResumption).toEqual({ handle: "scoped-handle" });
  expect(states.at(-1)).toMatchObject({ continuity: "session-resumption", requiresInput: true });
  expect(handles).not.toHaveBeenCalled();
  expect(fixture.sdks[1].sendClientContent).not.toHaveBeenCalled();
  expect(fixture.sdks[1].sendRealtimeInput).not.toHaveBeenCalled();
  // Even a misbehaving retired source cannot cross the new epoch.
  fixture.connections[0].emit("audio", { data: Buffer.from([1, 2]), generationId: "old" });
  speech(fixture.connections[1], "replayed");
  expect(audio).toHaveBeenCalledTimes(1);
  session.sendText("new user input");
  speech(fixture.connections[1], "new reply");
  expect(audio).toHaveBeenCalledTimes(2);
  expect(audio.mock.calls[0][0].generationId).not.toBe(audio.mock.calls[1][0].generationId);
  expect(session.getTranscript()).not.toContain("replayed");
  expect(fixture.sdks[0].close).toHaveBeenCalledOnce();
});

it.each(["input", "generation", "nonresumable", "expired"] as const)(
  "rejects a stale Gemini checkpoint after %s",
  async (trigger) => {
    const fixture = google();
    const connection = await RecoveringRealtimeConnection.connect(fixture.provider, {}, policy);
    sessions.push(connection);
    const state = vi.fn();
    connection.on("recovery", state);
    checkpoint(fixture.connections[0]);
    if (trigger === "input") connection.sendAudio(Buffer.from([0, 0]));
    if (trigger === "generation")
      fixture.connections[0]._handleMessage({ serverContent: { modelTurn: { parts: [] } } });
    if (trigger === "nonresumable")
      fixture.connections[0]._handleMessage({ sessionResumptionUpdate: { resumable: false } });
    if (trigger === "expired") {
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000 + 1);
    }
    fixture.connections[0]._disconnected();
    expect(state).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", reason: "unsafe-checkpoint" }));
    expect(fixture.provider.connect).toHaveBeenCalledOnce();
  },
);

it("disconnect during a running tool cancels dispatch without replaying effects or submitting a late result", async () => {
  const fixture = google();
  let finish!: () => void;
  const execute = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = () => resolve("done");
      }),
  );
  const session = await new VoiceAgent({
    name: "voice",
    provider: fixture.provider,
    recovery: { ...policy, fallback: "fresh" },
    tools: [{ name: "charge", description: "effect", parameters: z.object({}), execute }],
  }).connect();
  sessions.push(session);
  const state = vi.fn();
  session.on("recovery", state);
  checkpoint(fixture.connections[0]);
  fixture.connections[0]._handleMessage({ toolCall: { functionCalls: [{ id: "charge-1", name: "charge" }] } });
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
  fixture.connections[0]._disconnected();
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(state).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", reason: "uncertain-tools" }));
  expect(fixture.provider.connect).toHaveBeenCalledOnce();
  expect(fixture.sdks[0].sendToolResponse).not.toHaveBeenCalled();
});

it("retains tool-call deduplication across safe resumed connections", async () => {
  const fixture = google();
  const connection = await RecoveringRealtimeConnection.connect(fixture.provider, {}, policy);
  sessions.push(connection);
  const calls = vi.fn();
  connection.on("tool_call", calls);
  fixture.connections[0]._handleMessage({ toolCall: { functionCalls: [{ id: "once", name: "charge" }] } });
  connection.sendToolResult("once", "done");
  fixture.connections[0]._handleMessage({ serverContent: { turnComplete: true } });
  checkpoint(fixture.connections[0]);
  fixture.connections[0]._disconnected();
  await vi.waitFor(() => expect(fixture.connections).toHaveLength(2));
  connection.sendText("continue");
  fixture.connections[1]._handleMessage({ toolCall: { functionCalls: [{ id: "once", name: "charge" }] } });
  expect(calls).toHaveBeenCalledOnce();
});

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: unknown[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
  event(data: unknown) {
    this.emit("message", JSON.stringify(data));
  }
}
it("OpenAI explicitly reconnects fresh without historical items, tool results, or response.create", async () => {
  const sockets: Socket[] = [];
  const provider = {
    providerId: "openai-realtime",
    modelId: "fixture",
    capabilities: new OpenAIRealtimeProvider().capabilities,
    connect: vi.fn(async (_config: RealtimeSessionConfig) => {
      const socket = new Socket();
      sockets.push(socket);
      const connection = new OpenAIRealtimeConnection(socket);
      connection._bindServerEvents();
      return connection;
    }),
  };
  const session = await new VoiceAgent({
    name: "voice",
    provider,
    recovery: { ...policy, fallback: "fresh" },
  }).connect();
  sessions.push(session);
  const state = vi.fn();
  const audio = vi.fn();
  session.on("recovery", state);
  session.on("audio", audio);
  session.sendText("earlier");
  sockets[0].event({ type: "response.created", response: { id: "r" } });
  sockets[0].close();
  await vi.waitFor(() =>
    expect(state).toHaveBeenCalledWith(expect.objectContaining({ status: "recovered", continuity: "fresh" })),
  );
  expect(sockets[1].sent).toEqual([]);
  expect(provider.connect.mock.calls[1][0].sessionResumption).toBeUndefined();
  sockets[1].event({ type: "response.created", response: { id: "replay" } });
  sockets[1].event({ type: "response.output_audio.delta", response_id: "replay", delta: "AQA=" });
  expect(audio).not.toHaveBeenCalled();
});

it("bounds total attempts and closes late connections after timeout", async () => {
  vi.useFakeTimers();
  const fixture = google();
  const late = new GoogleLiveConnection(sdk());
  const close = vi.spyOn(late, "close");
  let resolve!: (connection: GoogleLiveConnection) => void;
  const wrapper = await RecoveringRealtimeConnection.connect(
    fixture.provider,
    {},
    { ...policy, maxAttempts: 2, connectTimeoutMs: 10 },
  );
  sessions.push(wrapper);
  const state = vi.fn();
  wrapper.on("recovery", state);
  fixture.provider.connect.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  checkpoint(fixture.connections[0]);
  fixture.connections[0]._disconnected();
  await vi.advanceTimersByTimeAsync(11);
  const firstResolve = resolve;
  await vi.advanceTimersByTimeAsync(20);
  expect(state).toHaveBeenLastCalledWith(
    expect.objectContaining({ status: "failed", reason: "exhausted", attempt: 2 }),
  );
  firstResolve(late);
  await Promise.resolve();
  await Promise.resolve();
  expect(close).toHaveBeenCalledOnce();
  expect(fixture.provider.connect).toHaveBeenCalledTimes(3);
});

it("cancels reconnect backoff immediately and prevents further provider IO", async () => {
  vi.useFakeTimers();
  const fixture = google();
  const signal = new AbortController();
  const wrapper = await RecoveringRealtimeConnection.connect(
    fixture.provider,
    { signal: signal.signal },
    { initialDelayMs: 1000 },
  );
  sessions.push(wrapper);
  checkpoint(fixture.connections[0]);
  fixture.connections[0]._disconnected();
  signal.abort();
  await vi.advanceTimersByTimeAsync(2000);
  expect(fixture.provider.connect).toHaveBeenCalledOnce();
  expect(() => wrapper.sendText("late")).toThrow(/unavailable/);
});

it("keeps independent owner checkpoints isolated even on the same provider object", async () => {
  const fixture = google();
  const agent = new VoiceAgent({ name: "voice", provider: fixture.provider, recovery: policy });
  const first = await agent.connect({ tenantId: "tenant-a", userId: "actor-a" });
  const second = await agent.connect({ tenantId: "tenant-b", userId: "actor-b" });
  sessions.push(first, second);
  checkpoint(fixture.connections[0], "a-only");
  checkpoint(fixture.connections[1], "b-only");
  fixture.connections[1]._disconnected();
  await vi.waitFor(() => expect(fixture.connections).toHaveLength(3));
  expect(fixture.provider.connect.mock.calls[2][0].sessionResumption).toEqual({ handle: "b-only" });
  fixture.connections[0]._disconnected();
  await vi.waitFor(() => expect(fixture.connections).toHaveLength(4));
  expect(fixture.provider.connect.mock.calls[3][0].sessionResumption).toEqual({ handle: "a-only" });
});

it("rejects unsupported recovery before connecting and preserves disabled recovery behavior", async () => {
  const connect = vi.fn<() => Promise<RealtimeConnection>>();
  const provider = { providerId: "custom", modelId: "model", connect };
  await expect(new VoiceAgent({ name: "voice", provider, recovery: {} }).connect()).rejects.toThrow(/does not support/);
  expect(connect).not.toHaveBeenCalled();
  const connection = new GoogleLiveConnection(sdk());
  connect.mockResolvedValue(connection);
  const session = await new VoiceAgent({ name: "voice", provider }).connect();
  sessions.push(session);
  const disconnected = vi.fn();
  session.on("disconnected", disconnected);
  connection._disconnected();
  expect(disconnected).toHaveBeenCalledOnce();
  expect(connect).toHaveBeenCalledOnce();
});

it("does not reuse a checkpoint after a tool result until the provider certifies a new idle state", async () => {
  const fixture = google();
  const connection = await RecoveringRealtimeConnection.connect(fixture.provider, {}, { ...policy, fallback: "fresh" });
  sessions.push(connection);
  const state = vi.fn();
  connection.on("recovery", state);
  checkpoint(fixture.connections[0]);
  fixture.connections[0]._handleMessage({ toolCall: { functionCalls: [{ id: "effect", name: "charge" }] } });
  connection.sendToolResult("effect", "done");
  fixture.connections[0]._disconnected();
  expect(state).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", reason: "uncertain-tools" }));
  expect(fixture.provider.connect).toHaveBeenCalledOnce();
});

it("does not let an old generation completion acknowledge newer user input", async () => {
  const fixture = google();
  const connection = await RecoveringRealtimeConnection.connect(fixture.provider, {}, policy);
  sessions.push(connection);
  const state = vi.fn();
  connection.on("recovery", state);
  connection.sendText("first input");
  fixture.connections[0]._handleMessage({ serverContent: { modelTurn: { parts: [] } } });
  connection.sendText("second input during old generation");
  fixture.connections[0]._handleMessage({ serverContent: { turnComplete: true } });
  checkpoint(fixture.connections[0]);
  fixture.connections[0]._disconnected();
  expect(state).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", reason: "unsafe-checkpoint" }));
  expect(fixture.provider.connect).toHaveBeenCalledOnce();
});

it("persists once at terminal close and retains the memory owner boundary during recovery", async () => {
  const fixture = google();
  const agent = new VoiceAgent({
    name: "voice",
    provider: fixture.provider,
    recovery: policy,
    memory: { storage: new InMemoryStorage(), summaries: false },
  });
  if (!agent.memory) throw new Error("Expected configured memory");
  const append = vi.spyOn(agent.memory, "appendMessages").mockResolvedValue({ overflow: [] });
  const session = await agent.connect({ tenantId: "owner", userId: "actor", sessionId: "call" });
  sessions.push(session);
  speech(fixture.connections[0]);
  checkpoint(fixture.connections[0]);
  fixture.connections[0]._disconnected();
  await vi.waitFor(() => expect(fixture.connections).toHaveLength(2));
  expect(append).not.toHaveBeenCalled();
  await expect(agent.connect({ tenantId: "other", userId: "actor" })).rejects.toThrow(/bound to another/);
  expect(fixture.provider.connect).toHaveBeenCalledTimes(2);
  await session.close();
  await session.close();
  expect(append).toHaveBeenCalledOnce();
});

it("requires reconciliation after OpenAI tool work because fresh sessions have no resumable effect checkpoint", async () => {
  const socket = new Socket();
  const native = new OpenAIRealtimeConnection(socket);
  native._bindServerEvents();
  const provider = {
    providerId: "openai-realtime",
    modelId: "fixture",
    capabilities: new OpenAIRealtimeProvider().capabilities,
    connect: vi.fn(async () => native),
  };
  const connection = await RecoveringRealtimeConnection.connect(provider, {}, { ...policy, fallback: "fresh" });
  sessions.push(connection);
  const state = vi.fn();
  connection.on("recovery", state);
  socket.event({ type: "response.created", response: { id: "r" } });
  socket.event({
    type: "response.output_item.done",
    item: { type: "function_call", id: "item", call_id: "effect", name: "charge", arguments: "{}" },
  });
  connection.sendToolResult("effect", "done");
  socket.event({ type: "response.done", response: { id: "r" } });
  socket.close();
  expect(state).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", reason: "uncertain-tools" }));
  expect(provider.connect).toHaveBeenCalledOnce();
});

it("rejects automatic recovery with unobservable provider-executed MCP tools before connecting", async () => {
  const fixture = google();
  await expect(
    RecoveringRealtimeConnection.connect(
      fixture.provider,
      {
        mcpServers: [{ serverLabel: "effects", serverUrl: "https://mcp.example.com" }],
      },
      policy,
    ),
  ).rejects.toThrow(/cannot observe native remote MCP effects/);
  expect(fixture.provider.connect).not.toHaveBeenCalled();
});
