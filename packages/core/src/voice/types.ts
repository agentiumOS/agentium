import type { EventBus } from "../events/event-bus.js";
import type { LogLevel } from "../logger/logger.js";
import type { UnifiedMemoryConfig } from "../memory/memory-config.js";
import type { ModelProvider } from "../models/provider.js";
import type { ToolDefinition } from "../models/types.js";
import type { ToolDef } from "../tools/types.js";

// ── Audio formats ────────────────────────────────────────────────────────

export type AudioFormat = "pcm16" | "g711_ulaw" | "g711_alaw";

// ── Turn detection / VAD ─────────────────────────────────────────────────

export interface TurnDetectionConfig {
  /** Server-side VAD type. */
  type: "server_vad";
  /** Activation threshold (0-1). Lower = more sensitive. */
  threshold?: number;
  /** Duration of speech (ms) required to open the turn. */
  prefixPaddingMs?: number;
  /** Duration of silence (ms) required to close the turn. */
  silenceDurationMs?: number;
}

// ── Realtime session config (passed to provider.connect) ─────────────────

export interface RealtimeSessionConfig {
  instructions?: string;
  voice?: string;
  tools?: ToolDefinition[];
  inputAudioFormat?: AudioFormat;
  outputAudioFormat?: AudioFormat;
  turnDetection?: TurnDetectionConfig | null;
  temperature?: number;
  maxResponseOutputTokens?: number | "inf";
  apiKey?: string;
}

// ── Realtime events ──────────────────────────────────────────────────────

export interface RealtimeToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type RealtimeEventMap = {
  audio: { data: Buffer; mimeType?: string };
  text: { text: string };
  transcript: { text: string; role: "user" | "assistant" };
  tool_call: RealtimeToolCall;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  interrupted: {};
  error: { error: Error };
  connected: {};
  disconnected: {};
};

export type RealtimeEvent = keyof RealtimeEventMap;

// ── RealtimeConnection (provider returns this) ───────────────────────────

export interface RealtimeConnection {
  sendAudio(data: Buffer): void;
  sendText(text: string): void;
  sendToolResult(callId: string, result: string): void;
  interrupt(): void;
  close(): Promise<void>;

  on<K extends RealtimeEvent>(event: K, handler: (data: RealtimeEventMap[K]) => void): void;

  off<K extends RealtimeEvent>(event: K, handler: (data: RealtimeEventMap[K]) => void): void;
}

// ── RealtimeProvider interface ───────────────────────────────────────────

export interface RealtimeProvider {
  readonly providerId: string;
  readonly modelId: string;

  connect(config: RealtimeSessionConfig): Promise<RealtimeConnection>;
}

// ── VoiceAgent config ────────────────────────────────────────────────────

export interface VoiceAgentConfig {
  name: string;
  provider: RealtimeProvider;
  instructions?: string;
  tools?: ToolDef[];
  voice?: string;
  turnDetection?: TurnDetectionConfig | null;
  inputAudioFormat?: AudioFormat;
  outputAudioFormat?: AudioFormat;
  temperature?: number;
  maxResponseOutputTokens?: number | "inf";
  eventBus?: EventBus;
  logLevel?: LogLevel;

  /**
   * Unified memory config — sessions, summaries, user facts, user profile,
   * entities, decisions, and learnings. Same config as Agent.
   */
  memory?: UnifiedMemoryConfig;
  /** LLM model used for background extraction. Falls back to memory.model. */
  model?: ModelProvider;
  /** Default session ID (can be overridden per connect()). */
  sessionId?: string;
  /** Default user ID (can be overridden per connect()). */
  userId?: string;
  /** Skills — pre-packaged or learned tool bundles. */
  skills?: Array<import("../skills/types.js").Skill | string>;
  /** Cost tracker for tracking token usage. */
  costTracker?: import("../cost/cost-tracker.js").CostTracker;
}

// ── VoiceSession events ──────────────────────────────────────────────────

export type VoiceSessionEventMap = RealtimeEventMap & {
  tool_call_start: { name: string; args: unknown };
  tool_result: { name: string; result: string };
};

export type VoiceSessionEvent = keyof VoiceSessionEventMap;

// ── VoiceSession (returned by VoiceAgent.connect) ────────────────────────

export interface VoiceSession {
  sendAudio(data: Buffer): void;
  sendText(text: string): void;
  interrupt(): void;
  close(): Promise<void>;

  on<K extends VoiceSessionEvent>(event: K, handler: (data: VoiceSessionEventMap[K]) => void): void;

  off<K extends VoiceSessionEvent>(event: K, handler: (data: VoiceSessionEventMap[K]) => void): void;
}
