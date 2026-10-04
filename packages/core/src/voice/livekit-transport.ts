import { VoiceBackpressureError } from "./bounded-queue.js";
import { type AudioFrame, type SpeechFormat, type VoiceTransport, validateAudioFrame } from "./speech-types.js";
/** Structural surface implemented by @livekit/rtc-node AudioFrame. */
export interface LiveKitAudioFrame {
  data: Int16Array;
  sampleRate: number;
  channels: number;
  samplesPerChannel: number;
}
/** Queue duration is milliseconds in the Node RTC SDK (not seconds). */
export interface LiveKitAudioSource<T extends LiveKitAudioFrame> {
  sampleRate: number;
  numChannels: number;
  queuedDuration: number;
  captureFrame(frame: T): Promise<void>;
  clearQueue(): void;
  close(): Promise<void>;
}
export interface LiveKitVoiceTransportOptions<T extends LiveKitAudioFrame> {
  source: LiveKitAudioSource<T>;
  AudioFrame: new (data: Int16Array, sampleRate: number, channels: number, samplesPerChannel: number) => T;
  inputFormat: SpeechFormat;
  maxQueuedMs?: number;
  maxPendingFrames?: number;
  /** A stuck native capture poisons this transport; recreate it instead of overlapping capture. */
  captureTimeoutMs?: number;
  /** Default false: the host owns track publication, source and room cleanup. */
  ownsSource?: boolean;
}
/** Media-only adapter. Publish its host-owned source as a local audio track separately. */
export class LiveKitVoiceTransport<T extends LiveKitAudioFrame = LiveKitAudioFrame> implements VoiceTransport {
  readonly playbackAcknowledgements = false;
  readonly inputFormat: SpeechFormat;
  readonly outputFormat: SpeechFormat;
  highWaterQueuedMs = 0;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private current?: { id: string; signal: AbortSignal; lastSequence: number };
  private closed = false;
  private closePromise?: Promise<void>;
  private sourceClosed = false;
  private revoked = new Set<string>();
  constructor(private options: LiveKitVoiceTransportOptions<T>) {
    this.inputFormat = { ...options.inputFormat };
    this.outputFormat = { encoding: "pcm_s16le", sampleRateHz: options.source.sampleRate, channels: 1 };
    if (options.source.numChannels !== 1 || options.inputFormat.encoding !== "pcm_s16le")
      throw new Error("LiveKit voice transport requires mono PCM16; convert explicitly");
    for (const format of [this.inputFormat, this.outputFormat])
      validateAudioFrame({
        ...format,
        bytes: new Uint8Array(2),
        sequence: 0,
        generationId: "validate",
        turnId: "validate",
      });
    for (const value of [options.maxQueuedMs, options.maxPendingFrames, options.captureTimeoutMs])
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
        throw new Error("Invalid LiveKit queue bound");
  }
  async play(frame: AudioFrame, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.closed) throw new Error("LiveKit voice transport is closed");
    validateAudioFrame(frame, this.outputFormat);
    if (this.revoked.has(frame.generationId)) throw new Error("Stale LiveKit generation");
    if (this.pending >= (this.options.maxPendingFrames ?? 32))
      throw new VoiceBackpressureError("LiveKit pending frame bound exceeded");
    // Copy before queueing: callers may recycle their source buffers after this call.
    frame = { ...frame, bytes: new Uint8Array(frame.bytes) };
    const bytes = frame.bytes;
    this.pending++;
    const work = this.tail.then(async () => {
      signal.throwIfAborted();
      if (this.closed || this.revoked.has(frame.generationId)) throw new Error("Stale LiveKit generation");
      if (this.current?.id !== frame.generationId) {
        if (this.current) this.revoke(this.current.id);
        // One source cannot safely mix queued output from two generations.
        this.options.source.clearQueue();
        this.current = { id: frame.generationId, signal, lastSequence: -1 };
      }
      if (this.current.signal !== signal || frame.sequence <= this.current.lastSequence)
        throw new Error("Out-of-order or conflicting LiveKit generation frame");
      const duration = (bytes.length / 2 / frame.sampleRateHz) * 1000;
      const queued = this.options.source.queuedDuration;
      if (!Number.isFinite(queued) || queued < 0 || queued + duration > (this.options.maxQueuedMs ?? 1000))
        throw new VoiceBackpressureError("LiveKit queued duration bound exceeded");
      this.highWaterQueuedMs = Math.max(this.highWaterQueuedMs, queued + duration);
      const data = new Int16Array(bytes.length / 2);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < data.length; i++) data[i] = view.getInt16(i * 2, true);
      const abort = () => {
        this.revoke(frame.generationId);
        this.options.source.clearQueue();
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        signal.throwIfAborted();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const capture = this.options.source.captureFrame(
          new this.options.AudioFrame(data, frame.sampleRateHz, 1, data.length),
        );
        // A late native completion may enqueue after a timeout. No new generations use a poisoned transport.
        void capture.then(
          () => {
            if (this.closed && !this.sourceClosed) this.options.source.clearQueue();
          },
          () => {},
        );
        try {
          await Promise.race([
            capture,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                this.closed = true;
                reject(new Error("LiveKit native capture timed out; recreate the transport"));
              }, this.options.captureTimeoutMs ?? 10_000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        this.current.lastSequence = frame.sequence;
        signal.throwIfAborted();
      } finally {
        signal.removeEventListener("abort", abort);
        // A native capture may settle after clear/abort. Fence it before the next queued capture.
        if (signal.aborted || this.closed || this.revoked.has(frame.generationId)) this.options.source.clearQueue();
      }
    });
    this.tail = work.catch(() => {});
    try {
      await work;
    } finally {
      this.pending--;
    }
  }
  private revoke(id: string): void {
    if (this.revoked.has(id) || this.closed) return;
    // Reconnect instead of forgetting old generation tombstones or growing them without bound.
    if (this.revoked.size >= 4096) {
      this.closed = true;
      return;
    }
    this.revoked.add(id);
  }
  async clear(generationId: string): Promise<void> {
    this.revoke(generationId);
    if (!this.sourceClosed && this.current?.id === generationId) this.options.source.clearQueue();
  }
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.options.source.clearQueue();
    this.closePromise = this.tail.then(async () => {
      this.options.source.clearQueue();
      if (this.options.ownsSource) {
        this.sourceClosed = true;
        await this.options.source.close();
      }
    });
    return this.closePromise;
  }
}
/** Copy an incoming RTC frame to portable PCM16LE without retaining native/shared storage. */
export function fromLiveKitAudioFrame(
  frame: LiveKitAudioFrame,
  identity: Pick<AudioFrame, "sequence" | "turnId" | "generationId">,
): AudioFrame {
  if (
    !(frame.data instanceof Int16Array) ||
    frame.channels !== 1 ||
    !Number.isSafeInteger(frame.samplesPerChannel) ||
    frame.samplesPerChannel <= 0 ||
    frame.samplesPerChannel !== frame.data.length ||
    frame.data.byteLength > 256 * 1024
  )
    throw new Error("Invalid or oversized LiveKit input frame");
  const bytes = new Uint8Array(frame.data.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < frame.data.length; i++) view.setInt16(i * 2, frame.data[i], true);
  const result: AudioFrame = { ...identity, bytes, encoding: "pcm_s16le", sampleRateHz: frame.sampleRate, channels: 1 };
  validateAudioFrame(result);
  return result;
}
