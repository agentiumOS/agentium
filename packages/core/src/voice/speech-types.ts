import type { ChatMessage } from "../models/types.js";

export type SpeechEncoding = "pcm_s16le" | "mulaw" | "alaw";
export interface SpeechFormat {
  encoding: SpeechEncoding;
  sampleRateHz: number;
  channels: 1;
}
export interface AudioFrame extends SpeechFormat {
  bytes: Uint8Array;
  sequence: number;
  turnId: string;
  generationId: string;
}
export interface TranscriptEvent {
  segmentId: string;
  kind: "partial" | "final";
  text: string;
  role: "user" | "assistant";
  language?: string;
  /** Provider-detected languages; an empty array means no prediction. */
  languages?: readonly string[];
  startMs?: number;
  endMs?: number;
}
export interface SpeechUsage {
  unit: "seconds" | "characters" | "audio_tokens" | "text_tokens";
  quantity: number;
  provider: string;
  cost?: number;
}
export interface SpeechOpenConfig {
  format: SpeechFormat;
  sessionId: string;
  turnId: string;
  generationId: string;
  language?: string;
  voice?: string;
}
export interface SpeechRecognizerSession {
  events: AsyncIterable<TranscriptEvent>;
  sendAudio(frame: AudioFrame): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}
export interface SpeechRecognizer {
  readonly capabilities: {
    provider: string;
    formats: readonly SpeechFormat[];
    partials: boolean;
    manualCommit: boolean;
    maturity: "stable" | "preview";
  };
  open(config: SpeechOpenConfig, signal: AbortSignal): Promise<SpeechRecognizerSession>;
}
export interface SpeechSynthesizerSession {
  frames: AsyncIterable<AudioFrame>;
  sendText(text: string): Promise<void>;
  /** Flush short final text and finish this generation's frame stream. */
  flush(): Promise<void>;
  close(): Promise<void>;
}
export interface SpeechSynthesizer {
  readonly capabilities: {
    provider: string;
    formats: readonly SpeechFormat[];
    cancellation: "close-connection";
    streamingText: true;
  };
  open(config: SpeechOpenConfig, signal: AbortSignal): Promise<SpeechSynthesizerSession>;
}
export interface VoiceBrainInput {
  text: string;
  history: readonly ChatMessage[];
  sessionId: string;
  turnId: string;
  generationId: string;
}
export interface VoiceBrain {
  respond(input: VoiceBrainInput, signal: AbortSignal): AsyncIterable<{ type: "text"; text: string }>;
}
export interface PlaybackAck {
  generationId: string;
  playedCharacters?: number;
  complete?: boolean;
}
export interface VoiceTransport {
  readonly inputFormat: SpeechFormat;
  readonly outputFormat: SpeechFormat;
  readonly playbackAcknowledgements: boolean;
  play(frame: AudioFrame, signal: AbortSignal): Promise<void>;
  clear(generationId: string): Promise<void>;
}
export interface VoiceTurnRecord {
  turnId: string;
  generationId: string;
  generatedText: string;
  heardText: string;
  delivery: "confirmed" | "partial" | "unknown";
  interrupted: boolean;
}
export function validateAudioFrame(frame: AudioFrame, format?: SpeechFormat, maxBytes = 256 * 1024): void {
  if (
    !(frame.bytes instanceof Uint8Array) ||
    frame.bytes.byteLength > maxBytes ||
    frame.bytes.byteLength === 0 ||
    !Number.isSafeInteger(frame.sequence) ||
    frame.sequence < 0 ||
    !frame.turnId ||
    !frame.generationId
  )
    throw new Error("Invalid or oversized audio frame");
  if (
    !["pcm_s16le", "mulaw", "alaw"].includes(frame.encoding) ||
    frame.channels !== 1 ||
    !Number.isSafeInteger(frame.sampleRateHz) ||
    frame.sampleRateHz < 8000 ||
    frame.sampleRateHz > 48000
  )
    throw new Error("Unsupported audio format");
  if (frame.encoding === "pcm_s16le" && frame.bytes.byteLength % 2)
    throw new Error("PCM16 frame must contain complete samples");
  if (
    format &&
    (frame.encoding !== format.encoding ||
      frame.sampleRateHz !== format.sampleRateHz ||
      frame.channels !== format.channels)
  )
    throw new Error("Audio format mismatch; explicit conversion is required");
}
export function requireSpeechFormat(format: SpeechFormat, supported: readonly SpeechFormat[]): void {
  if (
    !supported.some(
      (candidate) =>
        candidate.encoding === format.encoding &&
        candidate.sampleRateHz === format.sampleRateHz &&
        candidate.channels === format.channels,
    )
  )
    throw new Error("Speech provider does not support the requested format; explicit conversion is required");
}
