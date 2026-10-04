import { expect, it, vi } from "vitest";
import { fromLiveKitAudioFrame, LiveKitVoiceTransport } from "../livekit-transport.js";
import type { AudioFrame } from "../speech-types.js";

class RTCFrame {
  constructor(
    public data: Int16Array,
    public sampleRate: number,
    public channels: number,
    public samplesPerChannel: number,
  ) {}
}
const format = { encoding: "pcm_s16le" as const, sampleRateHz: 24000, channels: 1 as const };
const audio = (id = "g", sequence = 0): AudioFrame => ({
  ...format,
  bytes: new Uint8Array([0, 128, 255, 127]),
  sequence,
  generationId: id,
  turnId: "t",
});
const source = () => ({
  sampleRate: 24000,
  numChannels: 1,
  queuedDuration: 0,
  captureFrame: vi.fn(async (_frame: RTCFrame) => {}),
  clearQueue: vi.fn(),
  close: vi.fn(async () => {}),
});
it("copies little-endian input/output into exact native RTC constructors, without claiming audible playback", async () => {
  const sink = source();
  const transport = new LiveKitVoiceTransport({ source: sink, AudioFrame: RTCFrame, inputFormat: format });
  await transport.play(audio(), new AbortController().signal);
  expect([...sink.captureFrame.mock.calls[0][0].data]).toEqual([-32768, 32767]);
  const input = fromLiveKitAudioFrame(new RTCFrame(new Int16Array([-32768, 32767]), 24000, 1, 2), {
    sequence: 0,
    generationId: "g",
    turnId: "t",
  });
  expect(input.bytes).toEqual(audio().bytes);
  expect(transport.playbackAcknowledgements).toBe(false);
  await transport.close();
  expect(sink.close).not.toHaveBeenCalled();
});
it("serializes native capture and clears late cancelled frames before a new generation", async () => {
  let release!: () => void;
  const sink = source();
  sink.captureFrame.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const transport = new LiveKitVoiceTransport({
    source: sink,
    AudioFrame: RTCFrame,
    inputFormat: format,
    ownsSource: true,
  });
  const first = new AbortController();
  const second = new AbortController();
  const p1 = transport.play(audio("old"), first.signal);
  void p1.catch(() => {});
  await vi.waitFor(() => expect(sink.captureFrame).toHaveBeenCalledTimes(1));
  first.abort();
  await transport.clear("old");
  const p2 = transport.play(audio("new"), second.signal);
  expect(sink.captureFrame).toHaveBeenCalledTimes(1);
  release();
  await expect(p1).rejects.toThrow();
  await p2;
  const clearedBeforeNext = sink.clearQueue.mock.invocationCallOrder.some(
    (value) =>
      value > sink.captureFrame.mock.invocationCallOrder[0] && value < sink.captureFrame.mock.invocationCallOrder[1],
  );
  expect(clearedBeforeNext).toBe(true);
  const calls = sink.clearQueue.mock.calls.length;
  await transport.clear("old");
  expect(sink.clearQueue).toHaveBeenCalledTimes(calls);
  await expect(transport.play(audio("old", 1), second.signal)).rejects.toThrow(/Stale/);
  await transport.close();
  await transport.close();
  expect(sink.close).toHaveBeenCalledTimes(1);
});
it("bounds queued milliseconds and rejects invalid formats and sequences", async () => {
  const sink = source();
  sink.queuedDuration = 1000;
  const transport = new LiveKitVoiceTransport({
    source: sink,
    AudioFrame: RTCFrame,
    inputFormat: format,
    maxQueuedMs: 1000,
  });
  const signal = new AbortController().signal;
  await expect(transport.play(audio(), signal)).rejects.toThrow(/duration/);
  sink.queuedDuration = 0;
  await transport.play(audio(), signal);
  await expect(transport.play(audio(), signal)).rejects.toThrow(/Out-of-order/);
  expect(() =>
    fromLiveKitAudioFrame(new RTCFrame(new Int16Array(2), 24000, 2, 1), {
      sequence: 0,
      generationId: "g",
      turnId: "t",
    }),
  ).toThrow(/Invalid/);
  await transport.close();
});
it("bounds a stuck native capture and closes without permitting overlapping generations", async () => {
  const sink = source();
  sink.captureFrame.mockImplementation(async () => {
    await new Promise<void>(() => {});
  });
  const transport = new LiveKitVoiceTransport({
    source: sink,
    AudioFrame: RTCFrame,
    inputFormat: format,
    captureTimeoutMs: 10,
    ownsSource: true,
  });
  await expect(transport.play(audio(), new AbortController().signal)).rejects.toThrow(/timed out/);
  await expect(transport.play(audio("new"), new AbortController().signal)).rejects.toThrow(/closed/);
  await transport.close();
  expect(sink.close).toHaveBeenCalledTimes(1);
});
