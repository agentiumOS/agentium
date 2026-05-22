import { createRequire } from "node:module";
import type { ChatMessage } from "../models/types.js";
import { getTextContent } from "../models/types.js";

const _require = createRequire(import.meta.url);

type EncoderFn = (text: string) => number[];

let _cachedEncoder: EncoderFn | null | undefined;

/**
 * Try loading gpt-tokenizer (optional peer dep).
 * Returns an encode function or null if not installed.
 */
function loadEncoder(): EncoderFn | null {
  if (_cachedEncoder !== undefined) return _cachedEncoder;
  try {
    const mod = _require("gpt-tokenizer");
    const encode: EncoderFn = mod.encode ?? mod.default?.encode;
    if (typeof encode === "function") {
      _cachedEncoder = encode;
      return encode;
    }
  } catch {
    // not installed
  }
  _cachedEncoder = null;
  return null;
}

/**
 * Model-family-aware character-to-token ratios.
 *
 * These are empirically calibrated against tiktoken/gpt-tokenizer
 * across English text, code, JSON, and mixed content:
 *
 *   - GPT-4/3.5 (cl100k_base): ~3.7 chars/token on English prose,
 *     ~2.5 on code/JSON. We use 3.3 as a safe middle ground that
 *     slightly over-estimates (better to over-count for budgets).
 *   - Claude (claude tokenizer): ~3.5 chars/token on English,
 *     similar on code. We use 3.2 for safety.
 *   - Others: 3.0 as conservative default.
 *
 * These ratios are ONLY used when gpt-tokenizer is not installed.
 */
function getCharRatio(modelId?: string): number {
  if (!modelId) return 3.0;
  const id = modelId.toLowerCase();
  if (id.includes("gpt-4") || id.includes("gpt-3.5") || id.includes("o1") || id.includes("o3") || id.includes("o4")) {
    return 3.3;
  }
  if (id.includes("claude")) return 3.2;
  if (id.includes("gemini")) return 3.4;
  return 3.0; // conservative default — slightly over-estimates
}

const MSG_OVERHEAD_TOKENS = 4; // per-message token overhead (role, delimiters)

/**
 * Count tokens in a text string.
 *
 * When `gpt-tokenizer` is installed, returns exact BPE token count.
 * Otherwise, uses a model-family-aware character ratio that is
 * calibrated to slightly over-estimate (safe for budget enforcement).
 *
 * @param text - The text to count tokens for
 * @param modelId - Optional model identifier for calibrated fallback ratio
 */
export function countTokens(text: string, modelId?: string): number {
  if (!text) return 0;

  const encoder = loadEncoder();
  if (encoder) {
    try {
      return encoder(text).length;
    } catch {
      // encoding failure — fall through to heuristic
    }
  }

  return Math.ceil(text.length / getCharRatio(modelId));
}

/**
 * Count tokens for a ChatMessage (content + per-message overhead).
 */
export function countMessageTokens(msg: ChatMessage, modelId?: string): number {
  const content = typeof msg.content === "string" ? msg.content : (getTextContent(msg.content) ?? "");
  return countTokens(content, modelId) + MSG_OVERHEAD_TOKENS;
}

/**
 * Count total tokens across an array of messages.
 */
export function countMessagesTokens(messages: ChatMessage[], modelId?: string): number {
  return messages.reduce((sum, m) => sum + countMessageTokens(m, modelId), 0);
}

/**
 * Returns true when a real tokenizer is loaded (not using heuristic).
 * Useful for logging accuracy warnings.
 */
export function hasExactTokenizer(): boolean {
  return loadEncoder() !== null;
}
