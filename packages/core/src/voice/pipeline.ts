import { meteredGenerateFor, meteredOperation } from "../cost/accounting.js";
import { type AccountingContext, withAccountingContext } from "../cost/context.js";
import { normalizeSpeechUsage } from "../cost/operation-usage.js";
import type { ModelProvider } from "../models/provider.js";
import { endpointBillingContext } from "../models/usage-normalizers.js";
import { voiceMigrationDiagnostics } from "./migrations.js";
import {
  DEFAULT_FILE_TRANSCRIPTION_MODEL,
  OpenAIFileTranscriber,
  type OpenAITranscriptionContext,
} from "./providers/openai-transcription.js";

/**
 * Chained STT → LLM → TTS turn. Use when you do not want a single
 * speech-to-speech realtime model (Deepgram/Cartesia-style stack).
 * Talks to OpenAI's file transcription + speech endpoints.
 */
export interface VoicePipelineConfig {
  accounting?: AccountingContext;
  llm: ModelProvider;
  apiKey?: string;
  baseURL?: string;
  sttModel?: string;
  transcriptionContext?: OpenAITranscriptionContext;
  fetch?: typeof fetch;
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
  get migrationDiagnostics() {
    return voiceMigrationDiagnostics({
      transcriptionModel: this.config.sttModel ?? DEFAULT_FILE_TRANSCRIPTION_MODEL,
      ttsModel: this.config.ttsModel ?? "gpt-4o-mini-tts",
    });
  }

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

  async transcribe(audio: Buffer, mimeType = "audio/wav", signal?: AbortSignal): Promise<string> {
    const result = await new OpenAIFileTranscriber({
      accounting: this.config.accounting,
      apiKey: this.config.apiKey,
      baseURL: this.config.baseURL,
      model: this.config.sttModel,
      fetch: this.config.fetch,
      ...this.config.transcriptionContext,
    }).transcribe(audio, mimeType, signal);
    return result.text;
  }

  async speak(text: string, signal?: AbortSignal): Promise<Buffer> {
    signal?.throwIfAborted();
    return meteredOperation(
      {
        accounting: this.config.accounting,
        context: {
          providerId: "openai",
          billingProviderId: "openai",
          modelId: this.config.ttsModel ?? "gpt-4o-mini-tts",
          api: "audio.speech",
          occurredAt: new Date().toISOString(),
          ...endpointBillingContext("openai", this.config.baseURL),
        },
        purpose: "file-speech",
        attemptVisibility: "physical",
        signal,
      },
      async (capture) => {
        const res = await (this.config.fetch ?? fetch)(`${this.root()}/v1/audio/speech`, {
          signal,
          redirect: "error",
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
        capture(normalizeSpeechUsage("openai", "characters", text.length));
        return Buffer.from(await res.arrayBuffer());
      },
    );
  }

  async turn(audio: Buffer, mimeType?: string, signal?: AbortSignal): Promise<VoicePipelineTurn> {
    if (this.config.accounting)
      return withAccountingContext(this.config.accounting, () => this.turnAccounted(audio, mimeType, signal));
    return this.turnAccounted(audio, mimeType, signal);
  }

  private async turnAccounted(audio: Buffer, mimeType?: string, signal?: AbortSignal): Promise<VoicePipelineTurn> {
    const transcript = await this.transcribe(audio, mimeType, signal);
    signal?.throwIfAborted();
    const response = await meteredGenerateFor(
      "voice-pipeline-answer",
      this.config.llm,
      [
        ...(this.config.instructions ? [{ role: "system" as const, content: this.config.instructions }] : []),
        { role: "user", content: transcript },
      ],
      { signal },
    );
    const reply = typeof response.message.content === "string" ? response.message.content : "";
    const spoken = await this.speak(reply, signal);
    return { transcript, reply, audio: spoken };
  }
}
