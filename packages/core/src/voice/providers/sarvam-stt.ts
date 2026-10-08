import {
  requireSpeechFormat,
  type SpeechFormat,
  type SpeechOpenConfig,
  type SpeechRecognizer,
  type TranscriptEvent,
  validateAudioFrame,
} from "../speech-types.js";
import { beginSpeechAccounting } from "./speech-accounting.js";
import { defaultSpeechSocketFactory, SpeechWire, type SpeechWireOptions, speechKey } from "./speech-socket.js";
export const SARVAM_LANGUAGES = [
  "auto",
  "en-IN",
  "hi-IN",
  "bn-IN",
  "kn-IN",
  "ml-IN",
  "mr-IN",
  "or-IN",
  "pa-IN",
  "ta-IN",
  "te-IN",
  "gu-IN",
  "ur-IN",
  "ne-IN",
  "kok-IN",
  "ks-IN",
  "sd-IN",
  "sa-IN",
  "sat-IN",
  "mni-IN",
  "brx-IN",
  "mai-IN",
  "doi-IN",
  "as-IN",
] as const;
export interface SarvamRecognizerOptions extends SpeechWireOptions {
  model?: "saaras:v3-realtime" | "saaras:v4";
  mode?: "transcribe" | "translate" | "verbatim" | "translit" | "codemix";
}
export class SarvamRecognizer implements SpeechRecognizer {
  readonly capabilities = {
    provider: "sarvam",
    formats: [8000, 16000].flatMap((sampleRateHz) =>
      ["pcm_s16le", "mulaw", "alaw"].map(
        (encoding): SpeechFormat => ({ encoding: encoding as SpeechFormat["encoding"], sampleRateHz, channels: 1 }),
      ),
    ),
    partials: true,
    manualCommit: true,
    maturity: "preview" as const,
  };
  constructor(private options: SarvamRecognizerOptions = {}) {
    if (!["transcribe", "translate", "verbatim", "translit", "codemix"].includes(options.mode ?? "transcribe"))
      throw new Error("Unsupported Sarvam recognition mode");
    if (!["saaras:v3-realtime", "saaras:v4"].includes(options.model ?? "saaras:v3-realtime"))
      throw new Error("Unsupported Sarvam realtime STT model");
  }
  async open(config: SpeechOpenConfig, signal: AbortSignal) {
    requireSpeechFormat(config.format, this.capabilities.formats);
    if (!(SARVAM_LANGUAGES as readonly string[]).includes(config.language ?? "auto"))
      throw new Error("Unsupported Sarvam recognition language");
    const query = new URLSearchParams({
      model: this.options.model ?? "saaras:v3-realtime",
      mode: this.options.mode ?? "transcribe",
      language_code: config.language ?? "auto",
      encoding: config.format.encoding === "pcm_s16le" ? "linear16" : config.format.encoding,
      sample_rate: String(config.format.sampleRateHz),
      endpointing: "manual",
      stream_type: "balanced",
    });
    const accounting = await beginSpeechAccounting(
      this.options,
      "sarvam",
      this.options.model ?? "saaras:v3",
      "speech.transcription",
      signal,
    );
    const socket = await (this.options.socketFactory ?? defaultSpeechSocketFactory)(
      `wss://api.sarvam.ai/speech-to-text-realtime/ws?${query}`,
      { "Api-Subscription-Key": speechKey(this.options, "SARVAM_API_KEY") },
      signal,
    ).catch(async (error) => {
      await accounting.fail();
      throw error;
    });
    let segment = 0;
    let started = false;
    let lastSequence = -1;
    const wire = new SpeechWire<TranscriptEvent>(
      socket,
      signal,
      (event, wire) => {
        if (event.event === "transcript.partial" || event.event === "transcript.final") {
          if (typeof event.text !== "string") throw new Error("Invalid Sarvam transcript");
          const final = event.event === "transcript.final";
          wire.push(
            {
              segmentId: `${config.sessionId}:${segment}`,
              kind: final ? "final" : "partial",
              role: "user",
              text: event.text,
              language: event.language ?? config.language,
              ...(typeof event.start_s === "number" ? { startMs: event.start_s * 1000 } : {}),
              ...(typeof event.end_s === "number" ? { endMs: event.end_s * 1000 } : {}),
            },
            Buffer.byteLength(event.text),
          );
          if (final) segment++;
        }
        if (event.event === "session.end") {
          if (typeof event.audio_duration_s === "number")
            accounting.record({ provider: "sarvam", unit: "seconds", quantity: event.audio_duration_s });
          wire.finish();
        }
        if (event.event === "error") throw new Error(`Sarvam STT service error: ${event.code ?? "unknown"}`);
      },
      this.options.maxQueueBytes,
    );
    return {
      events: wire.queue,
      sendAudio: async (frame: import("../speech-types.js").AudioFrame) => {
        validateAudioFrame(frame, config.format);
        if (frame.sequence <= lastSequence) throw new Error("Out-of-order recognition frame");
        lastSequence = frame.sequence;
        if (!started) {
          wire.send({ event: "speech_start" });
          started = true;
        }
        wire.send({ event: "audio_input", audio: Buffer.from(frame.bytes).toString("base64") });
      },
      flush: async () => {
        wire.send({ event: "flush" });
        started = false;
      },
      close: async () => {
        try {
          wire.close();
        } finally {
          await accounting.close();
        }
      },
    };
  }
}
