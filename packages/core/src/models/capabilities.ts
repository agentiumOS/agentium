import { countConversationTokens } from "../context/context-compactor.js";
import { countTokens } from "../utils/token-counter.js";
import type { ChatMessage, ModelConfig, ReasoningConfig, ToolDefinition } from "./types.js";

/** Host-supplied facts; this interface does not select or fetch a model registry. */
export interface ModelCapabilities {
  contextWindow?: number;
  maxOutputTokens?: number;
  tools?: boolean;
  reasoningEfforts?: readonly NonNullable<ReasoningConfig["effort"]>[];
  reasoningModes?: readonly NonNullable<ReasoningConfig["mode"]>[];
  /** Closed old turns may be removed without invalidating retained provider continuation. */
  historyEviction?: "closed_turns" | "unsupported";
}
export type UnknownCapabilityPolicy = "allow" | "error";
export class ModelCapabilityError extends Error {
  readonly code = "MODEL_CAPABILITY_UNSUPPORTED";
  readonly retryable = false;
  constructor(
    readonly capability: keyof ModelCapabilities,
    message: string,
  ) {
    super(message);
    this.name = "ModelCapabilityError";
  }
}
export function validateModelCapabilities(capabilities?: ModelCapabilities): void {
  for (const value of [capabilities?.contextWindow, capabilities?.maxOutputTokens])
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
      throw new TypeError("Model token limits must be positive safe integers");
}
/** Configured facts reject known incompatibility. Estimated context sizes are advisory; provider limits remain authoritative. */
export function validateModelRequest(
  capabilities: ModelCapabilities | undefined,
  messages: readonly ChatMessage[],
  options: ModelConfig & { tools?: readonly ToolDefinition[] } = {},
  unknown: UnknownCapabilityPolicy = "allow",
  inputTokens = countConversationTokens([...messages]) +
    (options.tools?.length ? countTokens(JSON.stringify(options.tools)) : 0),
): void {
  validateModelCapabilities(capabilities);
  const requireKnown = (key: keyof ModelCapabilities) => {
    if (unknown === "error" && capabilities?.[key] === undefined)
      throw new ModelCapabilityError(key, `Unknown model capability: ${key}`);
  };
  requireKnown("contextWindow");
  requireKnown("maxOutputTokens");
  if (options.maxTokens !== undefined) {
    if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)
      throw new TypeError("maxTokens must be a positive safe integer");
    requireKnown("maxOutputTokens");
    if (capabilities?.maxOutputTokens !== undefined && options.maxTokens > capabilities.maxOutputTokens)
      throw new ModelCapabilityError("maxOutputTokens", "Requested output exceeds the configured model output limit");
  }
  if (capabilities?.contextWindow !== undefined && inputTokens + (options.maxTokens ?? 0) > capabilities.contextWindow)
    throw new ModelCapabilityError(
      "contextWindow",
      "Projected input plus output exceeds the configured model context limit",
    );
  if (options.tools?.length) {
    requireKnown("tools");
    if (capabilities?.tools === false)
      throw new ModelCapabilityError("tools", "Configured model does not support tools");
  }
  const effort = options.reasoning?.enabled === false ? "none" : options.reasoning?.effort;
  if (effort) {
    requireKnown("reasoningEfforts");
    if (capabilities?.reasoningEfforts && !capabilities.reasoningEfforts.includes(effort))
      throw new ModelCapabilityError("reasoningEfforts", `Unsupported reasoning effort: ${effort}`);
  } else if (options.reasoning?.enabled) requireKnown("reasoningEfforts");
  const mode = options.reasoning?.mode;
  if (mode) {
    requireKnown("reasoningModes");
    if (capabilities?.reasoningModes && !capabilities.reasoningModes.includes(mode))
      throw new ModelCapabilityError("reasoningModes", `Unsupported reasoning mode: ${mode}`);
  }
}
