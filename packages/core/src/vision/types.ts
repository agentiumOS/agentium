import type { EventBus } from "../events/event-bus.js";
import type { LogLevel } from "../logger/logger.js";
import type { UnifiedMemoryConfig } from "../memory/memory-config.js";
import type { ModelProvider } from "../models/provider.js";
import type { ToolDefinition } from "../models/types.js";
import type { ToolDef } from "../tools/types.js";

export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

export interface VisionSessionConfig {
  instructions?: string;
  voice?: string;
  /** BCP-47 language code for speech I/O (e.g. "en-US", "hi-IN", "ja-JP"). */
  language?: string;
  tools?: ToolDefinition[];
  temperature?: number;
  /** Suggested video frame rate (frames per second). Default: 1. */
  fps?: number;
  /** Gemini 3.1+ thinking level. Default: "minimal" for lowest latency. */
  thinkingLevel?: ThinkingLevel;
  apiKey?: string;
}

export interface VisionToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type VisionEventMap = {
  audio: { data: Buffer; mimeType?: string };
  text: { text: string };
  transcript: { text: string; role: "user" | "assistant" };
  tool_call: VisionToolCall;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  interrupted: {};
  error: { error: Error };
  connected: {};
  disconnected: {};
};

export type VisionEvent = keyof VisionEventMap;

export interface VisionConnection {
  sendAudio(data: Buffer): void;
  /** Send a video frame or image to the model. */
  sendImage(data: Buffer, mimeType?: string): void;
  sendText(text: string): void;
  sendToolResult(callId: string, result: string): void;
  interrupt(): void;
  close(): Promise<void>;
  on<K extends VisionEvent>(event: K, handler: (data: VisionEventMap[K]) => void): void;
  off<K extends VisionEvent>(event: K, handler: (data: VisionEventMap[K]) => void): void;
}

export interface VisionProvider {
  readonly providerId: string;
  readonly modelId: string;
  connect(config: VisionSessionConfig): Promise<VisionConnection>;
}

export interface VisionAgentConfig {
  name: string;
  provider: VisionProvider;
  instructions?: string;
  tools?: ToolDef[];
  voice?: string;
  /** BCP-47 language code for speech I/O (e.g. "en-US", "hi-IN", "ja-JP"). */
  language?: string;
  /** Suggested video frame rate. Default: 1. */
  fps?: number;
  /** Gemini 3.1+ thinking level. */
  thinkingLevel?: ThinkingLevel;
  temperature?: number;
  eventBus?: EventBus;
  logLevel?: LogLevel;
  memory?: UnifiedMemoryConfig;
  model?: ModelProvider;
  sessionId?: string;
  userId?: string;
  skills?: Array<import("../skills/types.js").Skill | string>;
  costTracker?: import("../cost/cost-tracker.js").CostTracker;
}

export type VisionSessionEventMap = VisionEventMap & {
  tool_call_start: { name: string; args: unknown };
  tool_result: { name: string; result: string };
};

export type VisionSessionEvent = keyof VisionSessionEventMap;

export interface VisionSession {
  sendAudio(data: Buffer): void;
  sendImage(data: Buffer, mimeType?: string): void;
  sendText(text: string): void;
  interrupt(): void;
  close(): Promise<void>;
  on<K extends VisionSessionEvent>(event: K, handler: (data: VisionSessionEventMap[K]) => void): void;
  off<K extends VisionSessionEvent>(event: K, handler: (data: VisionSessionEventMap[K]) => void): void;
}
