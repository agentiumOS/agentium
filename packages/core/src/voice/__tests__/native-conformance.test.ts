import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";
import { GoogleLiveConnection, GoogleLiveProvider } from "../providers/google-live.js";
import { OpenAIRealtimeConnection } from "../providers/openai-realtime.js";
import { VoiceAgent } from "../voice-agent.js";

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: any[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  event(event: unknown) {
    this.emit("message", JSON.stringify(event));
  }
}
function openai() {
  const socket = new Socket();
  const connection = new OpenAIRealtimeConnection(socket);
  connection._bindServerEvents();
  return { socket, connection };
}

it("OpenAI GA fixtures preserve authoritative args and don't continue inside result submission", () => {
  const { socket, connection } = openai();
  const tool = vi.fn();
  connection.on("tool_call", tool);
  socket.event({ type: "response.output_item.added", item: { type: "function_call", id: "item", name: "lookup" } });
  socket.event({ type: "response.function_call_arguments.delta", item_id: "item", delta: '{"x":' });
  socket.event({
    type: "response.output_item.done",
    item: { type: "function_call", id: "item", call_id: "call", name: "lookup", arguments: '{"x":1}' },
  });
  expect(tool).toHaveBeenCalledWith({ id: "call", name: "lookup", arguments: '{"x":1}' });
  connection.sendToolResult("call", "ok");
  expect(socket.sent.map((e) => e.type)).toEqual(["conversation.item.create"]);
});
it("OpenAI suppresses delayed cancelled audio and emits replacement transcript partials", () => {
  const { socket, connection } = openai();
  const audio = vi.fn();
  const transcript = vi.fn();
  connection.on("audio", audio);
  connection.on("transcript", transcript);
  socket.event({ type: "response.created", response: { id: "r1" } });
  socket.event({ type: "response.output_audio_transcript.delta", response_id: "r1", item_id: "i", delta: "Hel" });
  socket.event({ type: "response.output_audio_transcript.delta", response_id: "r1", item_id: "i", delta: "lo" });
  socket.event({ type: "response.output_audio_transcript.done", response_id: "r1", item_id: "i", transcript: "Hello" });
  expect(transcript.mock.calls.map(([event]) => [event.text, event.kind])).toEqual([
    ["Hel", "partial"],
    ["Hello", "partial"],
    ["Hello", "final"],
  ]);
  connection.interrupt();
  socket.event({ type: "response.output_audio.delta", response_id: "r1", delta: "AQA=" });
  expect(audio).not.toHaveBeenCalled();
});
it("Gemini 3.8 fixture processes mixed content and preserves tool name separately from call ID", () => {
  const sdk = { sendToolResponse: vi.fn(), sendRealtimeInput: vi.fn(), close: vi.fn() };
  const connection = new GoogleLiveConnection(sdk);
  const tools = vi.fn();
  const audio = vi.fn();
  const transcript = vi.fn();
  const usage = vi.fn();
  const goAway = vi.fn();
  const resume = vi.fn();
  connection.on("tool_call", tools);
  connection.on("audio", audio);
  connection.on("transcript", transcript);
  connection.on("usage", usage);
  connection.on("go_away", goAway);
  connection.on("session_resume", resume);
  connection._handleMessage({
    toolCall: { functionCalls: [{ id: "call-123", name: "lookup", args: { city: "Pune" } }] },
    serverContent: {
      modelTurn: {
        parts: [{ inlineData: { data: "AQA=", mimeType: "audio/pcm;rate=24000" } }, { text: "private", thought: true }],
      },
      inputTranscription: { text: "नमस्ते" },
      outputTranscription: { text: "Hello" },
      turnComplete: true,
    },
    usageMetadata: { promptTokenCount: 3, responseTokenCount: 4, totalTokenCount: 7 },
    goAway: { timeLeft: "10s" },
    sessionResumptionUpdate: { newHandle: "handle", resumable: true },
  });
  expect(new GoogleLiveProvider().modelId).toBe("gemini-3.8-live");
  expect(tools).toHaveBeenCalledTimes(1);
  expect(audio).toHaveBeenCalledTimes(1);
  expect(transcript.mock.calls.filter(([e]) => e.kind === "final").map(([e]) => e.text)).toEqual(["नमस्ते", "Hello"]);
  expect(usage).toHaveBeenCalledWith(
    expect.objectContaining({
      promptTokens: 3,
      completionTokens: 4,
      totalTokens: 7,
      accounting: expect.objectContaining({
        rawUsage: { promptTokenCount: 3, responseTokenCount: 4, totalTokenCount: 7 },
      }),
    }),
  );
  expect(goAway).toHaveBeenCalled();
  expect(resume).toHaveBeenCalled();
  connection.sendToolResult("call-123", '{"ok":true}');
  expect(sdk.sendToolResponse).toHaveBeenCalledWith({
    functionResponses: [{ id: "call-123", name: "lookup", response: { ok: true } }],
  });
  expect(() => connection.sendToolResult("call-123", "again")).toThrow(/Unknown/);
  expect(() => connection.createResponse()).toThrow(/owns continuation/);
  connection.commitAudio();
  expect(sdk.sendRealtimeInput).toHaveBeenCalledWith({ audioStreamEnd: true });
});
it("Gemini manual interruption suppresses local output until the next turn boundary", () => {
  const connection = new GoogleLiveConnection({});
  const audio = vi.fn();
  connection.on("audio", audio);
  connection.interrupt();
  connection._handleMessage({
    serverContent: { modelTurn: { parts: [{ inlineData: { data: "AQA=" } }] }, turnComplete: true },
  });
  expect(audio).not.toHaveBeenCalled();
  connection._handleMessage({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "AQA=" } }] } } });
  expect(audio).toHaveBeenCalledTimes(1);
});
describe("VoiceAgent continuation and projection", () => {
  it("waits for all concurrent tool replies and response completion, then continues exactly once", async () => {
    const { socket, connection } = openai();
    const resolvers: Array<() => void> = [];
    const execute = vi.fn(() => new Promise<string>((resolve) => resolvers.push(() => resolve("ok"))));
    const agent = new VoiceAgent({
      name: "voice",
      provider: { providerId: "openai-realtime", modelId: "fixture", connect: async () => connection },
      tools: [{ name: "lookup", description: "lookup", parameters: z.object({}), execute }],
    });
    const session = await agent.connect();
    socket.event({ type: "response.created", response: { id: "r" } });
    for (const id of ["a", "b", "b"])
      socket.event({
        type: "response.output_item.done",
        item: { id, call_id: id, type: "function_call", name: "lookup", arguments: "{}" },
      });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    resolvers[1]();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.event({ type: "response.done", response: { id: "r" } });
    expect(socket.sent.some((e) => e.type === "response.create")).toBe(false);
    resolvers[0]();
    await vi.waitFor(() => expect(socket.sent.filter((e) => e.type === "response.create")).toHaveLength(1));
    await session.close();
  });
  it("does not persist duplicate finals or unheard assistant text", async () => {
    const { connection } = openai();
    const agent = new VoiceAgent({
      name: "voice",
      provider: { providerId: "test", modelId: "fixture", connect: async () => connection },
    });
    const session = await agent.connect();
    for (const text of ["hel", "hello"])
      connection.emit("transcript", { role: "user", kind: "partial", segmentId: "u", text });
    for (let n = 0; n < 2; n++)
      connection.emit("transcript", { role: "user", kind: "final", segmentId: "u", text: "hello" });
    connection.emit("transcript", {
      role: "assistant",
      kind: "final",
      segmentId: "a",
      generationId: "g",
      text: "Generated response",
    });
    expect(session.getTranscript()).toBe("user: hello\nassistant: [Speech delivery unconfirmed]");
    session.acknowledgePlayback?.({ generationId: "g", playedCharacters: 9 });
    expect(session.getTranscript()).toContain("assistant: Generated [Speech delivery unconfirmed");
    expect(session.getTranscript()).not.toContain("Generated response");
    await session.close();
  });
});

it("does not promote interrupted speech to heard on a late playback completion", async () => {
  const { connection } = openai();
  const session = await new VoiceAgent({
    name: "voice",
    provider: {
      providerId: "fixture",
      modelId: "fixture",
      connect: async () => connection,
    },
  }).connect();
  connection.emit("transcript", {
    role: "assistant",
    kind: "final",
    segmentId: "a",
    generationId: "g",
    text: "heard unheard",
  });
  session.acknowledgePlayback?.({ generationId: "g", playedCharacters: 5 });
  session.interrupt();
  session.acknowledgePlayback?.({ generationId: "g", complete: true });
  expect(session.getTranscript()).not.toContain("unheard");
  expect(session.getTranscript()).toContain("heard [Speech delivery unconfirmed");
  await session.close();
});
it("closes a native connection arriving after cancellation without announcing it as connected", async () => {
  const { connection } = openai();
  const close = vi.spyOn(connection, "close");
  let resolve!: (value: typeof connection) => void;
  const controller = new AbortController();
  const agent = new VoiceAgent({
    name: "voice",
    provider: {
      providerId: "fixture",
      modelId: "fixture",
      connect: () =>
        new Promise((done) => {
          resolve = done;
        }),
    },
  });
  const pending = agent.connect({ signal: controller.signal });
  await vi.waitFor(() => expect(resolve).toBeDefined());
  const reason = new Error("caller cancelled");
  controller.abort(reason);
  resolve(connection);
  await expect(pending).rejects.toBe(reason);
  expect(close).toHaveBeenCalledOnce();
});
