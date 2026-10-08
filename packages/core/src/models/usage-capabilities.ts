/** Coverage concerns observable usage, not automatic tariff availability. All fixtures are synthetic. */
export interface ModelUsageCapability {
  providerId: string;
  api: string;
  tokenSemantics: "documented" | "partial";
  limitations: string[];
  fixture: string;
  sourceUrl: string;
}

const fixture = "models/__tests__/usage-conformance.test.ts";
const openaiSource = "https://developers.openai.com/api/docs/guides/prompt-caching";
const anthropicSource = "https://platform.claude.com/docs/en/build-with-claude/prompt-caching";
const googleSource = "https://ai.google.dev/api/generate-content#UsageMetadata";

/** An unsupported feature is explicit; adding a provider requires a normalizer and fixtures. */
export const MODEL_USAGE_CAPABILITIES: readonly ModelUsageCapability[] = [
  ...["chat-completions", "responses"].map(
    (api): ModelUsageCapability => ({
      providerId: "openai",
      api,
      tokenSemantics: "documented",
      limitations: ["missing_cache_counters", "modality_cache_partition", "hosted_tools"],
      fixture,
      sourceUrl: openaiSource,
    }),
  ),
  {
    providerId: "openai-decisions",
    api: "decisions",
    tokenSemantics: "documented",
    limitations: ["input_only_gpt_6_luna_contract", "custom_endpoint_billing_contract"],
    fixture,
    sourceUrl: "https://developers.openai.com/api/docs/guides/decisions",
  },
  ...["anthropic", "aws-claude"].map(
    (providerId): ModelUsageCapability => ({
      providerId,
      api: "messages",
      tokenSemantics: "documented",
      limitations: ["missing_ttl_partition", "hosted_tools", "server_iterations"],
      fixture,
      sourceUrl: anthropicSource,
    }),
  ),
  {
    providerId: "aws-bedrock",
    api: "converse",
    tokenSemantics: "documented",
    limitations: ["missing_ttl_partition"],
    fixture,
    sourceUrl: "https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html",
  },
  ...["google", "vertex"].map(
    (providerId): ModelUsageCapability => ({
      providerId,
      api: "generate-content",
      tokenSemantics: "documented",
      limitations: ["modality_cache_partition", "tool_use_prompt_tokens", "hosted_tools"],
      fixture,
      sourceUrl: googleSource,
    }),
  ),
  {
    providerId: "cohere",
    api: "chat-v2",
    tokenSemantics: "documented",
    limitations: ["additional_billed_units", "missing_billed_units"],
    fixture,
    sourceUrl: "https://docs.cohere.com/v2/reference/chat",
  },
  {
    providerId: "deepseek",
    api: "chat-completions",
    tokenSemantics: "documented",
    limitations: ["missing_cache_counters"],
    fixture,
    sourceUrl: "https://api-docs.deepseek.com/guides/kv_cache",
  },
  ...["azure-openai", "azure-foundry", "meta", "perplexity", "vercel", "cohere", "custom"].map(
    (providerId): ModelUsageCapability => ({
      providerId,
      api: "chat-completions",
      tokenSemantics: "partial",
      limitations: [`${providerId}_billing_contract`, "missing_cache_counters"],
      fixture,
      sourceUrl: providerId === "vercel" ? "https://v0.dev/docs/api" : openaiSource,
    }),
  ),
  ...["chat-completions", "responses"].map(
    (api): ModelUsageCapability => ({
      providerId: "xai",
      api,
      tokenSemantics: "documented",
      limitations: ["reviewed_grok_4_6_contract_only", "hosted_tools", "modality_cache_partition"],
      fixture,
      sourceUrl: "https://docs.x.ai/developers/rest-api-reference/inference/chat-completions",
    }),
  ),
  {
    providerId: "mistral",
    api: "chat-completions",
    tokenSemantics: "documented",
    limitations: ["reviewed_mistral_small_2603_contract_only", "modality_cache_partition"],
    fixture,
    sourceUrl: "https://docs.mistral.ai/studio/conversations/advanced/prompt-caching",
  },
  {
    providerId: "ollama",
    api: "ollama-chat",
    tokenSemantics: "partial",
    limitations: ["host_compute_contract"],
    fixture,
    sourceUrl: "https://docs.ollama.com/api/chat",
  },
  {
    providerId: "jev",
    api: "jev",
    tokenSemantics: "partial",
    limitations: ["jev_billing_contract", "missing_cache_counters"],
    fixture,
    sourceUrl: "https://www.npmjs.com/package/@jev/sdk",
  },
];
