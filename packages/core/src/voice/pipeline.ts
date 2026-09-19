import type { ModelProvider } from "../models/provider.js";

/**
 * Chained STT → LLM → TTS turn. Use when you do not want a single
 * speech-to-speech realtime model (Deepgram/Cartesia-style stack).
 * Talks to OpenAI's file transcription + speech endpoints.
 */
export interface VoicePipelineConfig {
  llm: ModelProvider;
  apiKey?: string;
  baseURL?: string;
  sttModel?: string;
  ttsModel?: string;
  voice?: string;
  instructions?: string;
}

export interface VoicePipelineTurn {
  transcript: string;
  reply: string;
  audio: Buffer;
}

export class VoicePipeline {
  private config: VoicePipelineConfig;

  constructor(config: VoicePipelineConfig) {
    this.config = config;
  }

  private key(): string {
    const k = this.config.apiKey ?? process.env.OPENAI_API_KEY;
    if (!k) throw new Error("OPENAI_API_KEY is required for VoicePipeline STT/TTS.");
    return k;
  }

  private root(): string {
    return (this.config.baseURL ?? "https://api.openai.com").replace(/\/$/, "");
  }

  async transcribe(audio: Buffer, mimeType = "audio/wav"): Promise<string> {
    const form = new FormData();
    form.append("model", this.config.sttModel ?? "whisper-1");
    form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), "audio.wav");
    const res = await fetch(`${this.root()}/v1/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.key()}` },
      body: form,
    });
    const json = (await res.json()) as { text?: string; error?: { message?: string } };
    if (!res.ok) throw new Error(json.error?.message ?? `transcription failed (${res.status})`);
    return json.text ?? "";
  }

  async speak(text: string): Promise<Buffer> {
    const res = await fetch(`${this.root()}/v1/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.key()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.ttsModel ?? "gpt-4o-mini-tts",
        voice: this.config.voice ?? "alloy",
        input: text,
      }),
    });
    if (!res.ok) {
      const json = (await res.json()) as { error?: { message?: string } };
      throw new Error(json.error?.message ?? `speech failed (${res.status})`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async turn(audio: Buffer, mimeType?: string): Promise<VoicePipelineTurn> {
    const transcript = await this.transcribe(audio, mimeType);
    const response = await this.config.llm.generate([
      ...(this.config.instructions ? [{ role: "system" as const, content: this.config.instructions }] : []),
      { role: "user", content: transcript },
    ]);
    const reply = typeof response.message.content === "string" ? response.message.content : "";
    const spoken = await this.speak(reply);
    return { transcript, reply, audio: spoken };
  }
}
