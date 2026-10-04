import {
  type AudioFrame,
  requireSpeechFormat,
  type SpeechFormat,
  type SpeechOpenConfig,
  type SpeechSynthesizer,
  validateAudioFrame,
} from "../speech-types.js";
import { defaultSpeechSocketFactory, SpeechWire, type SpeechWireOptions, speechKey } from "./speech-socket.js";
export interface SarvamSynthesizerOptions extends SpeechWireOptions {
  speaker: string;
  model?: "bulbul:v2" | "bulbul:v3";
}
export class SarvamSynthesizer implements SpeechSynthesizer {
  readonly capabilities = {
    provider: "sarvam",
    formats: [8000, 16000, 22050, 24000].map(
      (sampleRateHz): SpeechFormat => ({ encoding: "pcm_s16le", sampleRateHz, channels: 1 }),
    ),
    cancellation: "close-connection" as const,
    streamingText: true as const,
  };
  constructor(private options: SarvamSynthesizerOptions) {
    if (!options.speaker || !["bulbul:v2", "bulbul:v3"].includes(options.model ?? "bulbul:v3"))
      throw new Error("Unsupported Sarvam voice/model");
  }
  async open(config: SpeechOpenConfig, signal: AbortSignal) {
    requireSpeechFormat(config.format, this.capabilities.formats);
    if (
      !["en-IN", "hi-IN", "bn-IN", "kn-IN", "ml-IN", "mr-IN", "od-IN", "pa-IN", "ta-IN", "te-IN", "gu-IN"].includes(
        config.language ?? "hi-IN",
      )
    )
      throw new Error("Unsupported Sarvam synthesis language");
    const query = new URLSearchParams({ model: this.options.model ?? "bulbul:v3", send_completion_event: "true" });
    const socket = await (this.options.socketFactory ?? defaultSpeechSocketFactory)(
      `wss://api.sarvam.ai/text-to-speech/ws?${query}`,
      { "Api-Subscription-Key": speechKey(this.options, "SARVAM_API_KEY") },
      signal,
    );
    let sequence = 0;
    let chars = 0;
    let flushed = false;
    const wire = new SpeechWire<AudioFrame>(
      socket,
      signal,
      (event, wire) => {
        if (event.type === "audio" && event.data?.audio) {
          const frame: AudioFrame = {
            ...config.format,
            turnId: config.turnId,
            generationId: config.generationId,
            sequence: sequence++,
            bytes: Buffer.from(event.data.audio, "base64"),
          };
          validateAudioFrame(frame, config.format, 1024 * 1024);
          wire.push(frame, frame.bytes.byteLength);
        }
        if (event.type === "event" && event.data?.event_type === "final") wire.finish();
        if (event.type === "error") throw new Error("Sarvam TTS service error");
      },
      this.options.maxQueueBytes,
    );
    wire.send({
      type: "config",
      data: {
        language_code: config.language ?? "hi-IN",
        speaker: config.voice ?? this.options.speaker,
        output_audio_codec: "linear16",
        speech_sample_rate: config.format.sampleRateHz,
      },
    });
    return {
      frames: wire.queue,
      sendText: async (text: string) => {
        if (flushed) throw new Error("Speech generation already flushed");
        if (text) {
          chars += text.length;
          if (chars > 64_000) throw new Error("Speech text limit exceeded");
          wire.send({ type: "text", data: { text } });
        }
      },
      flush: async () => {
        if (flushed) return;
        flushed = true;
        wire.send({ type: "flush" });
        this.options.onUsage?.({ provider: "sarvam", unit: "characters", quantity: chars });
      },
      close: async () => wire.close(),
    };
  }
}
