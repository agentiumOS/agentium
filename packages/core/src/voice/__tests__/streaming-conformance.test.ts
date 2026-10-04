import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { BoundedVoiceQueue, VoiceBackpressureError } from "../bounded-queue.js";
import { createElevenLabsSpeechEngineHandler } from "../providers/elevenlabs-speech-engine.js";
import { ElevenLabsRecognizer } from "../providers/elevenlabs-stt.js";
import { ElevenLabsSynthesizer } from "../providers/elevenlabs-tts.js";
import { SarvamRecognizer } from "../providers/sarvam-stt.js";
import { SarvamSynthesizer } from "../providers/sarvam-tts.js";
import type { AudioFrame, SpeechFormat, TranscriptEvent, VoiceBrain } from "../speech-types.js";
import { AgentVoiceBrain, StreamingVoicePipeline } from "../streaming-pipeline.js";
import { TurnCoordinator } from "../turn-coordinator.js";

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: any[] = [];
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
  message(value: unknown) {
    this.emit("message", JSON.stringify(value));
  }
}
const format: SpeechFormat = { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 };
const config = { format, sessionId: "session", turnId: "turn", generationId: "generation" };
const frame = (sequence = 0): AudioFrame => ({
  ...format,
  bytes: new Uint8Array([1, 0]),
  sequence,
  turnId: "turn",
  generationId: "generation",
});
const final = (text = "Hello", segmentId = "segment"): TranscriptEvent => ({
  role: "user",
  text,
  kind: "final",
  segmentId,
});
const collect = async <T>(stream: AsyncIterable<T>): Promise<T[]> => {
  const result: T[] = [];
  for await (const item of stream) result.push(item);
  return result;
};

it("bounds queues and fails the consumer on overflow", async () => {
  const queue = new BoundedVoiceQueue<string>(2, 4);
  queue.push("abc", 3);
  expect(() => queue.push("de", 2)).toThrow(VoiceBackpressureError);
  await expect(queue[Symbol.asyncIterator]().next()).rejects.toThrow(VoiceBackpressureError);
});
it("replaces partials, commits once, and retains only played text after interruption", () => {
  const owner = new TurnCoordinator("voice");
  expect(owner.transcript({ ...final("Hel"), kind: "partial" })).toBe(false);
  expect(owner.transcript(final())).toBe(true);
  expect(owner.transcript(final())).toBe(false);
  const first = owner.begin();
  owner.appendText(first.generationId, "Hello world");
  owner.acknowledge({ generationId: first.generationId, playedCharacters: 5 });
  expect(owner.finish(true)).toMatchObject({ generatedText: "Hello world", heardText: "Hello", delivery: "partial" });
  expect(first.signal.aborted).toBe(true);
  expect(JSON.stringify(owner.getHistory())).not.toContain("world");
  expect(owner.accepts(first.generationId)).toBe(false);
  const second = owner.begin();
  owner.appendText(second.generationId, "Unheard");
  owner.generated(second.generationId);
  owner.finish(true);
  expect(JSON.stringify(owner.getHistory())).not.toContain("Unheard");
});
it("does not treat no-ack generation as heard and validates impossible acknowledgements", () => {
  const owner = new TurnCoordinator();
  const turn = owner.begin();
  owner.appendText(turn.generationId, "yes");
  expect(() => owner.acknowledge({ generationId: turn.generationId, complete: true })).toThrow(/before generation/);
  expect(() => owner.acknowledge({ generationId: turn.generationId, playedCharacters: 10 })).toThrow();
  owner.generated(turn.generationId);
  owner.acknowledge({ generationId: turn.generationId, complete: true });
  expect(owner.finish(false)).toMatchObject({ heardText: "yes", delivery: "confirmed" });
});

describe("documented optional wire adapters", () => {
  it("ElevenLabs uses Scribe replacement events and ignores timestamp companion commits", async () => {
    const socket = new Socket();
    const factory = vi.fn(async () => socket);
    const session = await new ElevenLabsRecognizer({ apiKey: "key", socketFactory: factory }).open(
      config,
      new AbortController().signal,
    );
    await session.sendAudio(frame());
    await session.flush();
    expect(factory.mock.calls[0]).toBeDefined();
    expect(socket.sent[1]).toMatchObject({ message_type: "input_audio_chunk", commit: true });
    socket.message({ message_type: "partial_transcript", text: "Hi" });
    socket.message({ message_type: "committed_transcript", text: "Hi there" });
    socket.message({ message_type: "committed_transcript_with_timestamps", text: "Hi there" });
    await session.close();
    const events = await collect(session.events);
    expect(events.map((e) => e.kind)).toEqual(["partial", "final"]);
    expect(events[0].segmentId).toBe(events[1].segmentId);
  });
  it.each(["hi-IN", "ta-IN", "en-IN"])("Sarvam retains %s language and code-switched finals", async (language) => {
    const socket = new Socket();
    const usage = vi.fn();
    const session = await new SarvamRecognizer({
      apiKey: "key",
      socketFactory: async () => socket,
      onUsage: usage,
    }).open({ ...config, language }, new AbortController().signal);
    await session.sendAudio(frame());
    await session.flush();
    expect(socket.sent.map((e) => e.event)).toEqual(["speech_start", "audio_input", "flush"]);
    socket.message({ event: "transcript.partial", text: "मेरा", language });
    socket.message({ event: "transcript.final", text: "मेरा order कहाँ है?", language, start_s: 0, end_s: 2 });
    socket.message({ event: "session.end", audio_duration_s: 2 });
    const events = await collect(session.events);
    expect(events.at(-1)).toMatchObject({ kind: "final", language, endMs: 2000 });
    expect(usage).toHaveBeenCalledWith({ provider: "sarvam", unit: "seconds", quantity: 2 });
    await session.close();
  });
  it.each(["elevenlabs", "sarvam"])(
    "%s flushes short final text and preserves generation identity",
    async (provider) => {
      const socket = new Socket();
      const factory = async () => socket;
      const synth =
        provider === "elevenlabs"
          ? new ElevenLabsSynthesizer({ voiceId: "voice", apiKey: "key", socketFactory: factory })
          : new SarvamSynthesizer({ speaker: "shubh", apiKey: "key", socketFactory: factory });
      const session = await synth.open(config, new AbortController().signal);
      await session.sendText("हाँ");
      await session.flush();
      expect(socket.sent.some((e) => e.flush || e.type === "flush")).toBe(true);
      socket.message(
        provider === "elevenlabs" ? { audio: "AQA=", isFinal: true } : { type: "audio", data: { audio: "AQA=" } },
      );
      if (provider === "sarvam") socket.message({ type: "event", data: { event_type: "final" } });
      const frames = await collect(session.frames);
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ generationId: "generation", turnId: "turn", sampleRateHz: 16000 });
      await session.close();
    },
  );
  it("closes cancelled Sarvam output and never exposes old socket frames", async () => {
    const socket = new Socket();
    const controller = new AbortController();
    const session = await new SarvamSynthesizer({
      speaker: "shubh",
      apiKey: "key",
      socketFactory: async () => socket,
    }).open(config, controller.signal);
    controller.abort();
    socket.message({ type: "audio", data: { audio: "AQA=" } });
    await expect(collect(session.frames)).rejects.toThrow(/cancelled/);
    expect(socket.readyState).toBe(3);
  });
  it("rejects unsupported codecs/models before connecting", async () => {
    const factory = vi.fn();
    const recognition = new SarvamRecognizer({ socketFactory: factory });
    await expect(
      recognition.open({ ...config, format: { ...format, sampleRateHz: 48000 } }, new AbortController().signal),
    ).rejects.toThrow(/format/);
    expect(factory).not.toHaveBeenCalled();
    expect(() => new ElevenLabsSynthesizer({ voiceId: "v", model: "eleven_v3" as never })).toThrow(/Unsupported/);
  });
});

it("Agent brain forwards scope and signal and emits only public text", async () => {
  const stream = vi.fn(async function* (_input: string, _opts: unknown) {
    yield { type: "thinking" as const, text: "private" };
    yield { type: "text" as const, text: "public" };
    yield { type: "tool_result" as const, toolName: "secret", result: "secret" } as any;
  });
  const brain = new AgentVoiceBrain({ stream }, { tenantId: "tenant", userId: "user" });
  const signal = new AbortController().signal;
  expect(
    await collect(
      brain.respond(
        { text: "hi", history: [{ role: "user", content: "hi" }], sessionId: "s", turnId: "t", generationId: "g" },
        signal,
      ),
    ),
  ).toEqual([{ type: "text", text: "public" }]);
  expect(stream.mock.calls[0]).toEqual([
    "hi",
    expect.objectContaining({
      tenantId: "tenant",
      userId: "user",
      sessionId: "s",
      history: [],
      ephemeral: true,
      signal,
    }),
  ]);
  expect(() => new AgentVoiceBrain({ memory: {}, stream })).toThrow(/without memory/);
});
it("Speech Engine uses authoritative transcript history once and forwards service cancellation", async () => {
  const respond = vi.fn(async function* (_input, _signal) {
    yield { type: "text" as const, text: "reply" };
  });
  const handler = createElevenLabsSpeechEngineHandler({ respond });
  const sendResponse = vi.fn(async (stream) => collect(stream));
  const session = { conversationId: "call", sendResponse };
  const signal = new AbortController().signal;
  const history = [
    { role: "agent" as const, content: "hello" },
    { role: "user" as const, content: "hi" },
  ];
  await handler(history, signal, session);
  await handler(history, signal, session);
  expect(respond).toHaveBeenCalledTimes(1);
  expect(respond.mock.calls[0][1]).toBe(signal);
  expect(await sendResponse.mock.results[0].value).toEqual([{ type: "response.output_text.delta", delta: "reply" }]);
});
it("pipeline starts only committed speech, flushes short text, and confirms playback explicitly", async () => {
  const input = new BoundedVoiceQueue<TranscriptEvent>();
  const spoken: string[] = [];
  const played: AudioFrame[] = [];
  const brain: VoiceBrain = {
    async *respond() {
      yield { type: "text", text: "Hello" };
    },
  };
  const pipeline = new StreamingVoicePipeline({
    recognizer: {
      capabilities: { provider: "fake", formats: [format], partials: true, manualCommit: true, maturity: "stable" },
      async open() {
        return { events: input, sendAudio: async () => {}, flush: async () => {}, close: async () => input.close() };
      },
    },
    synthesizer: {
      capabilities: { provider: "fake", formats: [format], cancellation: "close-connection", streamingText: true },
      async open(open) {
        const output = new BoundedVoiceQueue<AudioFrame>();
        return {
          frames: output,
          sendText: async (text) => {
            spoken.push(text);
          },
          flush: async () => {
            output.push({ ...frame(), generationId: open.generationId, turnId: open.turnId }, 2);
            output.close();
          },
          close: async () => output.close(),
        };
      },
    },
    brain,
    transport: {
      inputFormat: format,
      outputFormat: format,
      playbackAcknowledgements: true,
      play: async (audio) => {
        played.push(audio);
      },
      clear: async () => {},
    },
  });
  await pipeline.open();
  await pipeline.submitTranscript({ ...final(), kind: "partial" });
  expect(spoken).toEqual([]);
  await pipeline.submitTranscript(final());
  await pipeline.submitTranscript(final());
  expect(spoken).toEqual(["Hello"]);
  expect(played).toHaveLength(1);
  pipeline.acknowledgePlayback({ generationId: played[0].generationId, complete: true });
  expect(pipeline.coordinator.records[0]).toMatchObject({ delivery: "confirmed", heardText: "Hello" });
  expect(pipeline.timings[0].firstAudioMs).toBeTypeOf("number");
  await pipeline.close();
});
