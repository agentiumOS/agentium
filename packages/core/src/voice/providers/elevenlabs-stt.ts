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
export class ElevenLabsRecognizer implements SpeechRecognizer {
  readonly capabilities = {
    provider: "elevenlabs",
    formats: [8000, 16000, 22050, 24000, 44100, 48000].map(
      (sampleRateHz): SpeechFormat => ({ encoding: "pcm_s16le", sampleRateHz, channels: 1 }),
    ),
    partials: true,
    manualCommit: true,
    maturity: "stable" as const,
  };
  constructor(private options: SpeechWireOptions = {}) {}
  async open(config: SpeechOpenConfig, signal: AbortSignal) {
    requireSpeechFormat(config.format, this.capabilities.formats);
    const query = new URLSearchParams({
      model_id: "scribe_v2_realtime",
      audio_format: `pcm_${config.format.sampleRateHz}`,
      commit_strategy: "manual",
      ...(config.language ? { language_code: config.language } : {}),
    });
    const accounting = await beginSpeechAccounting(
      this.options,
      "elevenlabs",
      "scribe_v2_realtime",
      "speech.transcription",
      signal,
    );
    const socket = await (this.options.socketFactory ?? defaultSpeechSocketFactory)(
      `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${query}`,
      { "xi-api-key": speechKey(this.options, "ELEVENLABS_API_KEY") },
      signal,
    ).catch(async (error) => {
      await accounting.fail();
      throw error;
    });
    let segment = 0;
    let lastSequence = -1;
    const wire = new SpeechWire<TranscriptEvent>(
      socket,
      signal,
      (event, wire) => {
        if (event.message_type === "partial_transcript" || event.message_type === "committed_transcript") {
          const final = event.message_type === "committed_transcript";
          if (typeof event.text !== "string") throw new Error("Invalid ElevenLabs transcript");
          wire.push(
            {
              segmentId: `${config.sessionId}:${segment}`,
              kind: final ? "final" : "partial",
              role: "user",
              text: event.text,
            },
            Buffer.byteLength(event.text),
          );
          if (final) segment++;
        } else if (event.error || /error|rate_limited|quota_exceeded|auth_error/.test(event.message_type ?? ""))
          throw new Error(`ElevenLabs STT error: ${event.message_type}`);
        // Timestamp companion events annotate the same final; never commit them twice.
      },
      this.options.maxQueueBytes,
    );
    return {
      events: wire.queue,
      sendAudio: async (frame: import("../speech-types.js").AudioFrame) => {
        validateAudioFrame(frame, config.format);
        if (frame.sequence <= lastSequence) throw new Error("Out-of-order recognition frame");
        lastSequence = frame.sequence;
        wire.send({
          message_type: "input_audio_chunk",
          audio_base_64: Buffer.from(frame.bytes).toString("base64"),
          sample_rate: config.format.sampleRateHz,
        });
      },
      flush: async () =>
        wire.send({
          message_type: "input_audio_chunk",
          audio_base_64: "",
          sample_rate: config.format.sampleRateHz,
          commit: true,
        }),
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
