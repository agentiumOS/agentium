import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeSession, DEFAULT_TRANSCRIPTION_MODEL } from "../openai-session.js";
import { VoicePipeline } from "../pipeline.js";
import { OpenAIStreamingRecognizer } from "../providers/openai-stt.js";
import { OpenAIFileTranscriber } from "../providers/openai-transcription.js";
import type { AudioFrame } from "../speech-types.js";

class Socket extends EventEmitter {
  readyState = 1;
  sent: any[] = [];
  acknowledge = true;
  send(data: string) {
    const event = JSON.parse(data);
    this.sent.push(event);
    if (this.acknowledge && event.type === "session.update")
      queueMicrotask(() => this.message({ type: "session.updated" }));
  }
  message(event: unknown) {
    this.emit("message", JSON.stringify(event));
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
}
const format = { encoding: "pcm_s16le" as const, sampleRateHz: 24000, channels: 1 as const };
const config = { format, sessionId: "s", turnId: "t", generationId: "g" };
const frame = (sequence = 0): AudioFrame => ({
  ...format,
  sequence,
  turnId: "t",
  generationId: "g",
  bytes: new Uint8Array(4800),
});
const collect = async <T>(events: AsyncIterable<T>) => {
  const items: T[] = [];
  for await (const event of events) items.push(event);
  return items;
};
describe("OpenAI replacement transcription contracts", () => {
  it("uploads JSON transcription with plural hints, correct filename and no invented detected languages", async () => {
    let body: FormData | undefined;
    const request: typeof fetch = vi.fn(async (_url, init) => {
      body = init?.body as FormData;
      return Response.json({ text: "मेरा order", languages: [] });
    });
    const result = await new OpenAIFileTranscriber({
      apiKey: "test",
      fetch: request,
      languages: ["hi", "en"],
      keywords: ["AC-42"],
      prompt: "Support call",
    }).transcribe(new Uint8Array(20), "audio/webm");
    expect(body!.get("model")).toBe("gpt-transcribe");
    expect(body!.get("response_format")).toBe("json");
    expect(body!.getAll("languages[]")).toEqual(["hi", "en"]);
    expect(body!.getAll("keywords[]")).toEqual(["AC-42"]);
    expect(body!.has("language")).toBe(false);
    expect((body!.get("file") as File).name).toBe("audio.webm");
    expect(result).toEqual({ text: "मेरा order", languages: [] });
  });
  it("rejects unsupported contexts, malformed responses, cancellation and empty audio before network work", async () => {
    expect(() => new OpenAIFileTranscriber({ keywords: ["one\ntwo"] })).toThrow(/keywords/);
    expect(() => new OpenAIFileTranscriber({ model: "whisper-1", languages: ["en"] })).toThrow(/context/);
    const fetcher = vi.fn(async () => Response.json({}));
    const transcriber = new OpenAIFileTranscriber({ apiKey: "test", fetch: fetcher });
    await expect(transcriber.transcribe(new Uint8Array(0))).rejects.toThrow(/empty/);
    await expect(transcriber.transcribe(new Uint8Array(20), "audio/wav", AbortSignal.abort())).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(transcriber.transcribe(new Uint8Array(20))).rejects.toThrow(/lacks text/);
  });
  it("migrates buffered and native WebSocket defaults and forwards app-owned transcription context", async () => {
    const fetcher = vi.fn(async () => Response.json({ text: "hi" }));
    const pipeline = new VoicePipeline({ llm: {} as never, apiKey: "test", fetch: fetcher });
    expect(pipeline.migrationDiagnostics).toEqual([]);
    expect(await pipeline.transcribe(Buffer.alloc(20))).toBe("hi");
    expect(DEFAULT_TRANSCRIPTION_MODEL).toBe("gpt-transcribe");
    const session = buildOpenAIRealtimeSession("gpt-realtime-2.1", {
      transcriptionContext: { languages: ["hi", "en"] },
    });
    expect((session.audio as any).input.transcription).toEqual({ model: "gpt-transcribe", languages: ["hi", "en"] });
    expect(() => buildOpenAIRealtimeSession("gpt-realtime-2.1", { transcriptionModel: "gpt-live-transcribe" })).toThrow(
      /dedicated/,
    );
  });
  it("waits for configuration, accumulates deltas and emits finals in committed input order", async () => {
    const socket = new Socket();
    const connect = vi.fn(async () => socket);
    const session = await new OpenAIStreamingRecognizer({
      apiKey: "test",
      socketFactory: connect,
      languages: ["hi", "en"],
      delay: "low",
    }).open(config, new AbortController().signal);
    expect(socket.sent[0].session.audio.input).toMatchObject({
      turn_detection: null,
      transcription: { model: "gpt-live-transcribe", languages: ["hi", "en"], delay: "low" },
    });
    await session.sendAudio(frame());
    await session.flush();
    await session.sendAudio(frame(1));
    await session.flush();
    socket.message({ type: "input_audio_buffer.committed", item_id: "one" });
    socket.message({ type: "input_audio_buffer.committed", item_id: "two", previous_item_id: "one" });
    socket.message({ type: "conversation.item.input_audio_transcription.delta", item_id: "one", delta: "मेरा " });
    socket.message({ type: "conversation.item.input_audio_transcription.delta", item_id: "one", delta: "order" });
    socket.message({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "two",
      transcript: "later",
      languages: [],
    });
    socket.message({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "one",
      transcript: "मेरा order",
      languages: [{ code: "hi" }, { code: "en" }],
    });
    socket.message({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "one",
      transcript: "duplicate",
    });
    await session.close();
    const events = await collect(session.events);
    expect(events.map((event) => [event.kind, event.text])).toEqual([
      ["partial", "मेरा "],
      ["partial", "मेरा order"],
      ["final", "मेरा order"],
      ["final", "later"],
    ]);
    expect(events.at(-2)?.languages).toEqual(["hi", "en"]);
    expect(events.at(-1)?.languages).toEqual([]);
    expect(socket.listenerCount("message")).toBe(0);
  });
  it("requires supported format and uses bounded setup/turn deadlines", async () => {
    const socket = new Socket();
    socket.acknowledge = false;
    const recognizer = new OpenAIStreamingRecognizer({
      apiKey: "test",
      socketFactory: async () => socket,
      readyTimeoutMs: 10,
    });
    await expect(
      recognizer.open({ ...config, format: { ...format, sampleRateHz: 16000 } }, new AbortController().signal),
    ).rejects.toThrow(/format/);
    expect(socket.sent).toHaveLength(0);
    await expect(recognizer.open(config, new AbortController().signal)).rejects.toThrow(/timed out/);
    expect(socket.readyState).toBe(3);
    const next = new Socket();
    const session = await new OpenAIStreamingRecognizer({
      apiKey: "test",
      socketFactory: async () => next,
      turnTimeoutMs: 10,
    }).open(config, new AbortController().signal);
    const events = collect(session.events);
    void events.catch(() => {});
    await session.sendAudio(frame());
    await session.flush();
    await expect(events).rejects.toThrow(/timed out/);
    expect(next.readyState).toBe(3);
  });
  it("aborts initialization and active streams and rejects unsupported delay", async () => {
    expect(() => new OpenAIStreamingRecognizer({ model: "gpt-transcribe", delay: "low" })).toThrow(/delay/);
    const socket = new Socket();
    const controller = new AbortController();
    const session = await new OpenAIStreamingRecognizer({ apiKey: "test", socketFactory: async () => socket }).open(
      config,
      controller.signal,
    );
    controller.abort();
    await expect(collect(session.events)).rejects.toThrow(/cancelled/);
    await expect(session.sendAudio(frame())).rejects.toThrow();
    expect(socket.readyState).toBe(3);
  });
});
