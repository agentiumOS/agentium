import {
  type AudioFrame,
  requireSpeechFormat,
  type SpeechFormat,
  type SpeechOpenConfig,
  type SpeechRecognizer,
  type TranscriptEvent,
  validateAudioFrame,
} from "../speech-types.js";
import {
  DEFAULT_LIVE_TRANSCRIPTION_MODEL,
  detectedLanguages,
  type OpenAITranscriptionContext,
  transcriptionContext,
} from "./openai-transcription.js";
import { defaultSpeechSocketFactory, SpeechWire, type SpeechWireOptions, speechKey } from "./speech-socket.js";
export interface OpenAIStreamingRecognizerOptions extends SpeechWireOptions, OpenAITranscriptionContext {
  model?: "gpt-live-transcribe" | "gpt-transcribe";
  delay?: "minimal" | "low" | "medium" | "high" | "xhigh";
  readyTimeoutMs?: number;
  /** Deadline for a committed turn to complete; also bounds out-of-order waiting. */
  turnTimeoutMs?: number;
  maxPendingTurns?: number;
}
/** Dedicated transcription over WebSocket. The host owns VAD and calls flush at turn end. */
export class OpenAIStreamingRecognizer implements SpeechRecognizer {
  readonly capabilities = {
    provider: "openai",
    formats: [{ encoding: "pcm_s16le", sampleRateHz: 24000, channels: 1 }] as readonly SpeechFormat[],
    partials: true,
    manualCommit: true,
    maturity: "stable" as const,
  };
  private options: OpenAIStreamingRecognizerOptions;
  constructor(options: OpenAIStreamingRecognizerOptions = {}) {
    this.options = { ...options, ...transcriptionContext(options) };
    if (options.model && !["gpt-live-transcribe", "gpt-transcribe"].includes(options.model))
      throw new Error("Unsupported streaming transcription model");
    if (
      options.delay &&
      (options.model === "gpt-transcribe" || !["minimal", "low", "medium", "high", "xhigh"].includes(options.delay))
    )
      throw new Error("Transcription delay requires gpt-live-transcribe");
    for (const value of [options.readyTimeoutMs, options.turnTimeoutMs, options.maxPendingTurns])
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
        throw new Error("Invalid transcription bound");
  }
  async open(config: SpeechOpenConfig, signal: AbortSignal) {
    signal.throwIfAborted();
    requireSpeechFormat(config.format, this.capabilities.formats);
    const context = transcriptionContext({
      ...this.options,
      languages: this.options.languages ?? (config.language ? [config.language] : undefined),
    });
    const socket = await (this.options.socketFactory ?? defaultSpeechSocketFactory)(
      "wss://api.openai.com/v1/realtime?intent=transcription",
      { Authorization: `Bearer ${speechKey(this.options, "OPENAI_API_KEY")}` },
      signal,
    );
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Observe rejection even if an injected socket aborts synchronously in the wire constructor.
    void ready.catch(() => {});
    let lastSequence = -1;
    let uncommittedBytes = 0;
    const pending: Array<{ id?: string; deadline: number }> = [];
    const items = new Map<string, { text: string; final?: TranscriptEvent }>();
    const completed = new Set<string>();
    const maxBytes = this.options.maxQueueBytes ?? 1024 * 1024;
    const maxPending = this.options.maxPendingTurns ?? 32;
    let retainedBytes = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const wire = new SpeechWire<TranscriptEvent>(
      socket,
      signal,
      (event, wire) => {
        if (event.type === "session.updated") {
          resolveReady();
          return;
        }
        if (event.type === "error" || event.type === "conversation.item.input_audio_transcription.failed")
          throw new Error(`OpenAI transcription failed: ${event.error?.message ?? event.type}`);
        if (event.type === "input_audio_buffer.committed") {
          if (typeof event.item_id !== "string" || !event.item_id)
            throw new Error("Invalid committed transcription item");
          if (completed.has(event.item_id) || pending.some((item) => item.id === event.item_id)) return;
          const slot = pending.find((item) => !item.id);
          if (!slot) throw new Error("Unexpected transcription commit; host must own turn detection");
          slot.id = event.item_id;
          drain();
          return;
        }
        if (
          ![
            "conversation.item.input_audio_transcription.delta",
            "conversation.item.input_audio_transcription.completed",
          ].includes(event.type)
        )
          return;
        const id = event.item_id;
        if (typeof id !== "string" || !id) throw new Error("Transcription event lacks item_id");
        if (completed.has(id)) return;
        let item = items.get(id);
        if (item?.final) return;
        if (!item) {
          if (items.size >= maxPending) throw new Error("Pending transcription items exceed bound");
          item = { text: "" };
          items.set(id, item);
        }
        const isFinal = event.type.endsWith(".completed");
        const value = isFinal ? event.transcript : event.delta;
        if (typeof value !== "string") throw new Error("Invalid transcription text");
        const text = isFinal ? value : item.text + value;
        retainedBytes += Buffer.byteLength(text) - Buffer.byteLength(item.text);
        if (retainedBytes > maxBytes) throw new Error("Pending transcription text exceeds bound");
        item.text = text;
        const output: TranscriptEvent = { segmentId: id, kind: isFinal ? "final" : "partial", role: "user", text };
        if (isFinal) {
          const languages = detectedLanguages(event.languages);
          if (languages !== undefined) output.languages = languages;
          item.final = output;
          drain();
        } else wire.push(output, Buffer.byteLength(text));
      },
      maxBytes,
      (error) => {
        clearInterval(timer);
        rejectReady(error);
      },
    );
    function drain() {
      // Completions may arrive out of order. Only committed input order can start Agent turns.
      while (pending[0]?.id) {
        const id = pending[0].id;
        const item = items.get(id);
        if (!item?.final) break;
        wire.push(item.final, Buffer.byteLength(item.text));
        retainedBytes -= Buffer.byteLength(item.text);
        items.delete(id);
        pending.shift();
        completed.add(id);
        if (completed.size > 1024) completed.delete(completed.values().next().value!);
      }
    }
    timer = setInterval(
      () => {
        if (pending.some((item) => item.deadline <= Date.now())) wire.fail(new Error("Transcription turn timed out"));
      },
      Math.min(1000, this.options.turnTimeoutMs ?? 60_000),
    );
    timer.unref?.();
    const timeout = setTimeout(
      () => wire.fail(new Error("Transcription session configuration timed out")),
      this.options.readyTimeoutMs ?? 10_000,
    );
    try {
      wire.send({
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              turn_detection: null,
              transcription: {
                model: this.options.model ?? DEFAULT_LIVE_TRANSCRIPTION_MODEL,
                ...context,
                ...(this.options.delay ? { delay: this.options.delay } : {}),
              },
            },
          },
        },
      });
      await ready;
      signal.throwIfAborted();
    } catch (error) {
      clearInterval(timer);
      wire.close();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    return {
      events: wire.queue,
      sendAudio: async (frame: AudioFrame) => {
        validateAudioFrame(frame, config.format);
        if (frame.sequence <= lastSequence) throw new Error("Out-of-order recognition frame");
        if (uncommittedBytes + frame.bytes.byteLength > 24_000 * 2 * 60)
          throw new Error("Commit transcription audio at least once per minute");
        wire.send({ type: "input_audio_buffer.append", audio: Buffer.from(frame.bytes).toString("base64") });
        uncommittedBytes += frame.bytes.byteLength;
        lastSequence = frame.sequence;
      },
      flush: async () => {
        if (uncommittedBytes === 0) return;
        if (pending.length >= maxPending) throw new Error("Pending transcription turns exceed bound");
        pending.push({ deadline: Date.now() + (this.options.turnTimeoutMs ?? 60_000) });
        try {
          wire.send({ type: "input_audio_buffer.commit" });
          uncommittedBytes = 0;
        } catch (error) {
          pending.pop();
          throw error;
        }
      },
      close: async () => {
        clearInterval(timer);
        wire.close();
        items.clear();
        pending.length = 0;
        completed.clear();
      },
    };
  }
}
