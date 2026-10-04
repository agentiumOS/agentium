import { expect, it, vi } from "vitest";
import { BoundedVoiceQueue } from "../bounded-queue.js";
import type {
  AudioFrame,
  SpeechFormat,
  SpeechRecognizer,
  SpeechRecognizerSession,
  SpeechSynthesizer,
  SpeechSynthesizerSession,
} from "../speech-types.js";
import { StreamingVoicePipeline } from "../streaming-pipeline.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const format: SpeechFormat = { encoding: "pcm_s16le", channels: 1, sampleRateHz: 16000 };
const recognitionCapabilities: SpeechRecognizer["capabilities"] = {
  provider: "fixture",
  formats: [format],
  partials: true,
  manualCommit: true,
  maturity: "stable",
};
const synthesisCapabilities: SpeechSynthesizer["capabilities"] = {
  provider: "fixture",
  formats: [format],
  cancellation: "close-connection",
  streamingText: true,
};
const input = (): SpeechRecognizerSession => ({
  events: new BoundedVoiceQueue(),
  sendAudio: async () => {},
  flush: async () => {},
  close: vi.fn(async () => {}),
});
const transport = () => ({
  inputFormat: format,
  outputFormat: format,
  playbackAcknowledgements: false,
  play: vi.fn(async () => {}),
  clear: vi.fn(async () => {}),
});
const event = { role: "user" as const, kind: "final" as const, text: "hello", segmentId: "one" };

it("closes a recognizer returned after pipeline closure", async () => {
  const pending = deferred<SpeechRecognizerSession>();
  const session = input();
  const pipeline = new StreamingVoicePipeline({
    recognizer: { capabilities: recognitionCapabilities, open: () => pending.promise },
    synthesizer: { capabilities: synthesisCapabilities, open: vi.fn() },
    brain: { async *respond() {} },
    transport: transport(),
  });
  const opening = pipeline.open();
  const rejection = expect(opening).rejects.toThrow(/closed/);
  await pipeline.close();
  pending.resolve(session);
  await rejection;
  expect(session.close).toHaveBeenCalledTimes(1);
});

it("closes a late synthesis session exactly once without starting the brain", async () => {
  const pending = deferred<SpeechSynthesizerSession>();
  const session = {
    frames: new BoundedVoiceQueue<AudioFrame>(),
    sendText: vi.fn(),
    flush: vi.fn(),
    close: vi.fn(async () => {}),
  };
  const brain = { respond: vi.fn(async function* () {}) };
  const pipeline = new StreamingVoicePipeline({
    recognizer: { capabilities: recognitionCapabilities, open: async () => input() },
    synthesizer: { capabilities: synthesisCapabilities, open: () => pending.promise },
    brain,
    transport: transport(),
  });
  const work = pipeline.submitTranscript(event);
  await pipeline.close();
  pending.resolve(session);
  await work;
  expect(session.close).toHaveBeenCalledTimes(1);
  expect(brain.respond).not.toHaveBeenCalled();
});

it("clears playback and closes input even when synthesis cleanup fails", async () => {
  const sent = deferred();
  const release = deferred();
  const frames = new BoundedVoiceQueue<AudioFrame>();
  const session = {
    frames,
    sendText: async () => sent.resolve(),
    flush: vi.fn(),
    close: vi.fn(async () => {
      frames.close();
      throw new Error("synthesis close failed");
    }),
  };
  const recognition = input();
  const playback = transport();
  const pipeline = new StreamingVoicePipeline({
    recognizer: { capabilities: recognitionCapabilities, open: async () => recognition },
    synthesizer: { capabilities: synthesisCapabilities, open: async () => session },
    transport: playback,
    brain: {
      async *respond() {
        yield { type: "text" as const, text: "hello" };
        await release.promise;
      },
    },
  });
  await pipeline.open();
  const work = pipeline.submitTranscript(event);
  const rejectedWork = expect(work).rejects.toThrow(/synthesis close failed/);
  await sent.promise;
  await expect(pipeline.close()).rejects.toThrow(/cleanup failed/);
  expect(playback.clear).toHaveBeenCalledTimes(1);
  expect(recognition.close).toHaveBeenCalledTimes(1);
  release.resolve();
  await rejectedWork;
  expect(session.close).toHaveBeenCalledTimes(1);
});
