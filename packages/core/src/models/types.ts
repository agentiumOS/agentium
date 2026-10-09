import type { NormalizedUsage } from "../cost/accounting-types.js";
import type { DecisionAnswer, ModelQuestions } from "./decisions.js";
import type { PublicMessage, PublicMessageEvent, PublicMessagePhase } from "./public-messages.js";
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

/** JSON-persistable Responses output; never expose opaque items as display text. */
export interface ResponsesReplayEnvelope {
  version: 1;
  /** Normalized endpoint origin/path; credentials and query strings are excluded. */
  owner: string;
  /** Model identity when produced by an adapter. Switching it needs an explicit new continuation. */
  model?: string;
  items: unknown[];
}

// ── Chat message ──────────────────────────────────────────────────────────

export interface ChatMessage {
  role: MessageRole;
  /** Public assistant phase; opaque provider replay remains in providerExtras. */
  phase?: "commentary" | "final";
  content: MessageContent | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  /**
   * Opaque provider payload replayed on the next request. Anthropic needs the
   * original `thinking` / `redacted_thinking` blocks (with signatures) before
   * `tool_use`; Gemini 2.5/3 needs `thoughtSignature` on function-call parts.
   * Dropping these 400s a tools + reasoning loop.
   */
  providerExtras?: Record<string, unknown>;
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
  /** Cache reads are a subset of promptTokens. */
  cachedTokens?: number;
  /** Cache writes are a disjoint subset of promptTokens. */
  cacheWriteTokens?: number;
  /** Canonical evidence for accounting. Missing counters remain null here. */
  accounting?: NormalizedUsage;
  audioInputTokens?: number;
  audioOutputTokens?: number;
  /** Bounded usage evidence; excludes prompts and credentials. */
  providerMetrics?: Record<string, unknown>;
  /** Endpoint-specific pricing identity when a model has more than one tariff. */
  pricingKey?: string;
}

// ── Model response ────────────────────────────────────────────────────────

export interface ModelResponse {
  publicMessages?: PublicMessage[];
  message: ChatMessage;
  usage: TokenUsage;
  finishReason: "stop" | "tool_calls" | "length" | "content_filter";
  raw: unknown;
  /** Validated OpenAI Decisions answers. */
  decisions?: DecisionAnswer[];
}

export type StreamChunk =
  | { type: "text"; text: string; itemId?: string; phase?: PublicMessagePhase }
  | { type: "reasoning_summary"; text: string; itemId?: string }
  | { type: "public_message"; event: PublicMessageEvent }
  | { type: "thinking"; text: string }
  | { type: "tool_call_start"; toolCall: { id: string; name: string } }
  | { type: "tool_call_delta"; toolCallId: string; argumentsDelta: string }
  | { type: "tool_call_end"; toolCallId: string }
  | {
      type: "finish";
      /** Present on an Agent terminal finish when cost accounting is enabled. */
      costs?: import("../cost/accounting-types.js").RunCostSnapshot;
      finishReason: string;
      phase?: "commentary" | "final";
      publicMessages?: PublicMessage[];
      usage?: TokenUsage;
      /** Usage defaults to a cumulative snapshot. Deltas require a stable event identity. */
      usageObservation?: { kind: "snapshot" | "delta"; id: string; sequence: number };
      providerExtras?: Record<string, unknown>;
      decisions?: DecisionAnswer[];
    };

// ── Model config ──────────────────────────────────────────────────────────

export interface ReasoningConfig {
  enabled: boolean;
  /**
   * Reasoning effort for OpenAI-family models (o-series, GPT-5.x, GPT-6).
   * `none` keeps function tools on Chat Completions; any other value with
   * tools is sent through the Responses API on GPT-5.4+ / GPT-6.
   * Anthropic maps this onto `output_config.effort`. DeepSeek accepts `low` / `high` / `max`.
   */
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Token budget for thinking (Anthropic / Gemini / Cohere). */
  budgetTokens?: number;
  /** OpenAI Responses summary. Default `detailed`. */
  summary?: "auto" | "concise" | "detailed";
  /** GPT-5.6 / GPT-6 Responses execution mode. */
  mode?: "standard" | "pro";
  /** Which reasoning items later turns send back. Default is the model's own. */
  context?: "auto" | "current_turn" | "all_turns";
}

/** Provider request options that are not shared sampling knobs. */
export interface ProviderOptions {
  /** Anthropic: cache the system prompt (`cache_control: ephemeral`). */
  promptCache?: boolean;
  /** OpenAI Responses `prompt_cache_retention`. */
  promptCacheRetention?: "in_memory" | "24h";
  /**
   * OpenAI `service_tier` on Responses and Chat Completions. Omitted unless set.
   * The returned tier still drives cost accounting.
   */
  serviceTier?: "auto" | "default" | "flex" | "priority" | "scale" | (string & {});
  /**
   * Anthropic server compaction once input exceeds this many tokens.
   * Values under 50000 are raised to 50000. Requires the compaction beta.
   */
  compactionTokens?: number;
  /** Anthropic: clear old tool results server-side. Requires the context-management beta. */
  clearToolResults?: boolean;
  /** Gemini media token budget. */
  mediaResolution?: "low" | "medium" | "high" | "ultra_high";
  /** Gemini explicit cache resource name (`cachedContents/...`). */
  cachedContent?: string;
  /** Gemini Google Search grounding tool. */
  googleSearch?: boolean;
}

/**
 * Trusted host billing facts for metered calls. No paid plan or service tier is inferred.
 * Returned facts override configured facts; configured facts override documented defaults.
 * These values do not select a request tier or change the remote provider request.
 * @example
 * ```ts
 * const agent = new Agent({
 *   name: "assistant",
 *   model: google("gemini-3.8-flash"),
 *   cost: true,
 *   billingContext: {
 *     region: "global",
 *     actualServiceTier: "standard",
 *     dimensions: { pricePlan: "paid" },
 *   },
 * });
 * const result = await agent.run("Hello");
 * console.log(result.costs?.total); // Decimal string, or null if any cost is unknown.
 * await agent.close();
 * ```
 */
export interface ModelBillingContext {
  accountId?: string;
  contractId?: string;
  region?: string;
  /** Known effective account/endpoint tier. A returned service tier takes precedence. */
  actualServiceTier?: string;
  /** For example { pricePlan: "paid" }. Never include credentials or prompt data. */
  dimensions?: Record<string, string>;
}

export interface ModelConfig {
  /** Billing facts for metered calls. Provider-returned facts take precedence. */
  billingContext?: ModelBillingContext;
  /** Cooperative cancellation, forwarded by compatible providers. */
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
  responseFormat?: "text" | "json" | { type: "json_schema"; schema: Record<string, unknown>; name?: string };
  /** Per-request API key override. When provided, the provider uses this key instead of the one set at construction. */
  apiKey?: string;
  /** Enable extended thinking / reasoning. */
  reasoning?: ReasoningConfig;
  /** Provider-specific request options (cache, compaction, Gemini grounding). */
  providerOptions?: ProviderOptions;
  /**
   * Jev question map or native OpenAI Decisions question array for this call.
   * Ignored by chat providers.
   */
  questions?: ModelQuestions;
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
