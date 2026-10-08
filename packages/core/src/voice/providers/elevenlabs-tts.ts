import {
  type AudioFrame,
  requireSpeechFormat,
  type SpeechFormat,
  type SpeechOpenConfig,
  type SpeechSynthesizer,
  validateAudioFrame,
} from "../speech-types.js";
import { beginSpeechAccounting } from "./speech-accounting.js";
import { defaultSpeechSocketFactory, SpeechWire, type SpeechWireOptions, speechKey } from "./speech-socket.js";
export interface ElevenLabsSynthesizerOptions extends SpeechWireOptions {
  voiceId: string;
  model?: "eleven_flash_v2_5" | "eleven_turbo_v2_5" | "eleven_multilingual_v2";
}
export class ElevenLabsSynthesizer implements SpeechSynthesizer {
  readonly capabilities = {
    provider: "elevenlabs",
    formats: [16000, 22050, 24000, 44100].map(
      (sampleRateHz): SpeechFormat => ({ encoding: "pcm_s16le", sampleRateHz, channels: 1 }),
    ),
    cancellation: "close-connection" as const,
    streamingText: true as const,
  };
  constructor(private options: ElevenLabsSynthesizerOptions) {
    if (
      !options.voiceId ||
      !["eleven_flash_v2_5", "eleven_turbo_v2_5", "eleven_multilingual_v2"].includes(
        options.model ?? "eleven_flash_v2_5",
      )
    )
      throw new Error("Unsupported ElevenLabs stream-input model/voice; v3/v4 require a different dialogue adapter");
  }
  async open(config: SpeechOpenConfig, signal: AbortSignal) {
    requireSpeechFormat(config.format, this.capabilities.formats);
    const query = new URLSearchParams({
      model_id: this.options.model ?? "eleven_flash_v2_5",
      output_format: `pcm_${config.format.sampleRateHz}`,
    });
    const accounting = await beginSpeechAccounting(
      this.options,
      "elevenlabs",
      this.options.model ?? "eleven_flash_v2_5",
      "speech.synthesis",
      signal,
    );
    const socket = await (this.options.socketFactory ?? defaultSpeechSocketFactory)(
      `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.voice ?? this.options.voiceId)}/stream-input?${query}`,
      { "xi-api-key": speechKey(this.options, "ELEVENLABS_API_KEY") },
      signal,
    ).catch(async (error) => {
      await accounting.fail();
      throw error;
    });
    let sequence = 0;
    let textChars = 0;
    let flushed = false;
    const wire = new SpeechWire<AudioFrame>(
      socket,
      signal,
      (event, wire) => {
        if (event.audio) {
          const frame: AudioFrame = {
            ...config.format,
            turnId: config.turnId,
            generationId: config.generationId,
            sequence: sequence++,
            bytes: Buffer.from(event.audio, "base64"),
          };
          validateAudioFrame(frame, config.format, 1024 * 1024);
          wire.push(frame, frame.bytes.byteLength);
        }
        if (event.isFinal) wire.finish();
        if (event.error) throw new Error("ElevenLabs TTS service error");
      },
      this.options.maxQueueBytes,
    );
    wire.send({ text: " " });
    return {
      frames: wire.queue,
      sendText: async (text: string) => {
        if (flushed) throw new Error("Speech generation already flushed");
        if (text) {
          textChars += text.length;
          if (textChars > 64_000) throw new Error("Speech text limit exceeded");
          wire.send({ text });
        }
      },
      flush: async () => {
        if (flushed) return;
        flushed = true;
        wire.send({ text: " ", flush: true });
        wire.send({ text: "" });
        accounting.record({ provider: "elevenlabs", unit: "characters", quantity: textChars });
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
