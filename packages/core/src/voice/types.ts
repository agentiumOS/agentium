import type { EventBus } from "../events/event-bus.js";
import type { LogLevel } from "../logger/logger.js";
import type { UnifiedMemoryConfig } from "../memory/memory-config.js";
import type { ModelProvider } from "../models/provider.js";
import type { ToolDefinition } from "../models/types.js";
import type { ToolDef } from "../tools/types.js";

// ── Audio formats ────────────────────────────────────────────────────────

export type AudioFormat = "pcm16" | "g711_ulaw" | "g711_alaw";

export type SemanticVadEagerness = "low" | "medium" | "high" | "auto";

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** When to talk around a tool call. Long tools (browse_web) should not go silent. */
export type ToolCallBehavior = "silent" | "speakBefore" | "speakAfter" | "speakBeforeAndAfter";

/** Whether user speech cancels the current spoken reply. */
export type BargeInPolicy = "always" | "never";

export interface ServerVadConfig {
  type: "server_vad";
  threshold?: number;
  prefixPaddingMs?: number;
  silenceDurationMs?: number;
  createResponse?: boolean;
  interruptResponse?: boolean;
  /** After this idle (ms) the model speaks (“still there?”). */
  idleTimeoutMs?: number;
}

export interface SemanticVadConfig {
  type: "semantic_vad";
  eagerness?: SemanticVadEagerness;
  createResponse?: boolean;
  interruptResponse?: boolean;
}

export type TurnDetectionConfig = ServerVadConfig | SemanticVadConfig;

export interface NoiseReductionConfig {
  type: "near_field" | "far_field";
}

export interface RealtimeMcpServer {
  serverLabel: string;
  serverUrl: string;
  headers?: Record<string, string>;
}

export interface VoiceTranslationConfig {
  /** Hint the model to translate speech into this language (BCP-47 or name). */
  targetLanguage: string;
}

export interface VoiceRecordingConfig {
  output?: boolean;
  input?: boolean;
}

// ── Realtime session config (passed to provider.connect) ─────────────────

export interface RealtimeSessionConfig {
  signal?: AbortSignal;
  /** Provider session checkpoint. Gemini only; handles must stay with their original owner/configuration. */
  sessionResumption?: { handle?: string };
  instructions?: string;
  voice?: string;
  tools?: ToolDefinition[];
  inputAudioFormat?: AudioFormat;
  outputAudioFormat?: AudioFormat;
  turnDetection?: TurnDetectionConfig | null;
  temperature?: number;
  maxResponseOutputTokens?: number | "inf";
  apiKey?: string;
  reasoningEffort?: ReasoningEffort;
  transcriptionModel?: string;
  transcriptionContext?: import("./providers/openai-transcription.js").OpenAITranscriptionContext;
  noiseReduction?: NoiseReductionConfig;
  mcpServers?: RealtimeMcpServer[];
  safetyIdentifier?: string;
  translation?: VoiceTranslationConfig;
}

export type RealtimeRecoveryContinuity = "session-resumption" | "fresh";

/** Opt-in, bounded recovery. No audio, user input, or tool results are resent. */
export interface RealtimeRecoveryPolicy {
  /** Default: stop when a safe provider checkpoint is unavailable. Fresh loses conversation context. */
  fallback?: "stop" | "fresh";
  /** Total reconnect attempts over this logical session, including successful reconnects. Default: 3. */
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  connectTimeoutMs?: number;
  /** Maximum elapsed time for one recovery incident, including backoff. Default: 30 seconds. */
  maxElapsedMs?: number;
}

export interface RealtimeRecoveryState {
  status: "recovering" | "recovered" | "failed";
  attempt: number;
  continuity?: RealtimeRecoveryContinuity;
  reason: "disconnected" | "go-away" | "unsafe-checkpoint" | "uncertain-tools" | "exhausted";
  /** Replacement sessions never replay output and require new user input before forwarding output. */
  requiresInput: boolean;
}

// ── Realtime events ──────────────────────────────────────────────────────

export interface RealtimeToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type RealtimeEventMap = {
  audio: { data: Buffer; mimeType?: string; generationId?: string };
  text: { text: string };
  transcript: {
    text: string;
    role: "user" | "assistant";
    segmentId?: string;
    kind?: "partial" | "final";
    generationId?: string;
  };
  tool_call: RealtimeToolCall;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  interrupted: {};
  error: { error: Error };
  connected: {};
  disconnected: {};
  idle: {};
  generation_start: { generationId: string };
  turn_complete: { generationId?: string };
  go_away: { timeLeft?: string };
  session_resume: { handle?: string; resumable: boolean };
  recovery: RealtimeRecoveryState;
};

export type RealtimeEvent = keyof RealtimeEventMap;

export interface CreateResponseOpts {
  instructions?: string;
  /** `"none"` = out-of-band (not stored on the conversation). */
  conversation?: "none" | "auto";
  modalities?: Array<"text" | "audio">;
}

// ── RealtimeConnection (provider returns this) ───────────────────────────

export interface RealtimeConnection {
  /** Native transports expose closure so a connect/close race cannot return an already dead session. */
  readonly connectionState?: "open" | "closed";
  /** Client owns OpenAI continuation; Gemini resumes when a tool response arrives. */
  readonly toolContinuation?: "client" | "provider";
  sendAudio(data: Buffer): void;
  sendText(text: string): void;
  sendImage(image: Buffer | string, opts?: { mimeType?: string; text?: string }): void;
  sendToolResult(callId: string, result: string): void;
  createResponse(opts?: CreateResponseOpts): void;
  commitAudio(): void;
  interrupt(): void;
  close(): Promise<void>;

  on<K extends RealtimeEvent>(event: K, handler: (data: RealtimeEventMap[K]) => void): void;

  off<K extends RealtimeEvent>(event: K, handler: (data: RealtimeEventMap[K]) => void): void;
}

// ── RealtimeProvider interface ───────────────────────────────────────────

export interface RealtimeProvider {
  readonly capabilities?: {
    manualCommit: boolean;
    images: boolean;
    asyncTools: boolean;
    transcripts: boolean;
    resume: boolean;
    /** Advertised recovery contract; absent means recovery is unsupported. */
    recovery?: "session-resumption" | "fresh";
    inputSampleRateHz: number;
    outputSampleRateHz: number;
  };
  readonly providerId: string;
  readonly modelId: string;

  connect(config: RealtimeSessionConfig): Promise<RealtimeConnection>;
}

// ── VoiceAgent config ────────────────────────────────────────────────────

export interface VoiceAgentConfig {
  approval?: import("../tools/approval.js").ApprovalConfig;
  approvalManager?: import("../tools/approval.js").ApprovalManager;
  executionPolicy?: import("../tools/execution-policy.js").ExecutionPolicy;
  name: string;
  provider: RealtimeProvider;
  /** Off by default. Recovery state is emitted on the VoiceSession `recovery` event. */
  recovery?: RealtimeRecoveryPolicy;
  instructions?: string;
  tools?: ToolDef[];
  voice?: string;
  /**
   * Turn detection. Default: `{ type: "semantic_vad", eagerness: "low" }`.
   * Pass `{ type: "server_vad" }` for silence-based VAD, or `null` for push-to-talk.
   */
  turnDetection?: TurnDetectionConfig | null;
  inputAudioFormat?: AudioFormat;
  outputAudioFormat?: AudioFormat;
  temperature?: number;
  maxResponseOutputTokens?: number | "inf";
  eventBus?: EventBus;
  logLevel?: LogLevel;

  memory?: UnifiedMemoryConfig;
  model?: ModelProvider;
  sessionId?: string;
  userId?: string;
  skills?: Array<import("../skills/types.js").Skill | string>;
  costTracker?: import("../cost/cost-tracker.js").CostTracker;

  /** Realtime 2.x thinking depth. Default: `low`. */
  reasoningEffort?: ReasoningEffort;
  /** Input transcription model. Default: `gpt-transcribe` (native WebSocket sessions). */
  transcriptionModel?: string;
  transcriptionContext?: import("./providers/openai-transcription.js").OpenAITranscriptionContext;
  noiseReduction?: NoiseReductionConfig;
  /** Remote MCP servers attached to the OpenAI Realtime session. */
  mcpServers?: RealtimeMcpServer[];
  safetyIdentifier?: string;
  translation?: VoiceTranslationConfig;
  /**
   * One client-owned continuation follows completed OpenAI tool calls.
   * Legacy speakBefore variants no longer create competing out-of-band responses.
   */
  toolCallBehavior?: ToolCallBehavior;
  /** User speech cancels the current reply. Default: `always`. */
  bargeIn?: BargeInPolicy;
  recording?: VoiceRecordingConfig;
}

// ── VoiceSession events ──────────────────────────────────────────────────

export type VoiceSessionEventMap = RealtimeEventMap & {
  tool_call_start: { name: string; args: unknown };
  tool_result: { name: string; result: string };
};

export type VoiceSessionEvent = keyof VoiceSessionEventMap;

export interface VoiceRecording {
  output: Buffer;
  input: Buffer;
}

export interface VoiceSession {
  sendAudio(data: Buffer): void;
  sendText(text: string): void;
  sendImage(image: Buffer | string, opts?: { mimeType?: string; text?: string }): void;
  commitAudio(): void;
  interrupt(): void;
  close(): Promise<void>;
  /** Playback-confirmed projection; unacknowledged generated text is marked unknown. */
  acknowledgePlayback?(ack: import("./speech-types.js").PlaybackAck): void;
  getTranscript(): string;
  getRecording(): VoiceRecording;

  on<K extends VoiceSessionEvent>(event: K, handler: (data: VoiceSessionEventMap[K]) => void): this;

  off<K extends VoiceSessionEvent>(event: K, handler: (data: VoiceSessionEventMap[K]) => void): this;
}
