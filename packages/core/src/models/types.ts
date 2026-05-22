export type MessageRole = "system" | "user" | "assistant" | "tool";

// ── Multi-modal content parts ─────────────────────────────────────────────

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image";
  /** Base64-encoded image data OR a URL. */
  data: string;
  mimeType?: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

export interface AudioPart {
  type: "audio";
  /** Base64-encoded audio data. */
  data: string;
  mimeType?: "audio/mp3" | "audio/wav" | "audio/ogg" | "audio/webm";
}

export interface FilePart {
  type: "file";
  /** Base64-encoded file data OR a URL. */
  data: string;
  mimeType: string;
  filename?: string;
}

export type ContentPart = TextPart | ImagePart | AudioPart | FilePart;

/** Convenience: plain string, or an array of multi-modal content parts. */
export type MessageContent = string | ContentPart[];

// ── Chat message ──────────────────────────────────────────────────────────

export interface ChatMessage {
  role: MessageRole;
  content: MessageContent | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

// ── Tool definitions ──────────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

// ── Token usage ───────────────────────────────────────────────────────────

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  audioInputTokens?: number;
  audioOutputTokens?: number;
  /** Raw usage / metrics object returned by the underlying provider API (unmodified). */
  providerMetrics?: Record<string, unknown>;
}

// ── Model response ────────────────────────────────────────────────────────

export interface ModelResponse {
  message: ChatMessage;
  usage: TokenUsage;
  finishReason: "stop" | "tool_calls" | "length" | "content_filter";
  raw: unknown;
}

export type StreamChunk =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call_start"; toolCall: { id: string; name: string } }
  | { type: "tool_call_delta"; toolCallId: string; argumentsDelta: string }
  | { type: "tool_call_end"; toolCallId: string }
  | { type: "finish"; finishReason: string; usage?: TokenUsage };

// ── Model config ──────────────────────────────────────────────────────────

export interface ReasoningConfig {
  enabled: boolean;
  /** Reasoning effort for OpenAI o-series models. */
  effort?: "low" | "medium" | "high";
  /** Token budget for thinking (Anthropic / Gemini). */
  budgetTokens?: number;
}

export interface ModelConfig {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
  responseFormat?: "text" | "json" | { type: "json_schema"; schema: Record<string, unknown>; name?: string };
  /** Per-request API key override. When provided, the provider uses this key instead of the one set at construction. */
  apiKey?: string;
  /** Enable extended thinking / reasoning. */
  reasoning?: ReasoningConfig;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Extract the text content from a MessageContent value. */
export function getTextContent(content: MessageContent | null): string {
  if (content === null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/** Check if content has multi-modal parts. */
export function isMultiModal(content: MessageContent | null): content is ContentPart[] {
  return Array.isArray(content);
}
