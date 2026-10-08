/** Synthetic API-shaped fixtures, not live captures. References checked 2026-10-08. */
export const USAGE_FIXTURES = {
  openai: {
    source: "https://developers.openai.com/api/docs/guides/prompt-caching",
    schema: "OpenAI Responses usage, openai >= 7.30",
    raw: {
      input_tokens: 15000,
      output_tokens: 500,
      total_tokens: 15500,
      input_tokens_details: { cached_tokens: 12000, cache_write_tokens: 2000 },
      output_tokens_details: { reasoning_tokens: 100 },
    },
  },
  anthropic: {
    source: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
    schema: "Messages usage with cache_creation TTL partition",
    raw: {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 12000,
      cache_creation_input_tokens: 2000,
      cache_creation: { ephemeral_5m_input_tokens: 1500, ephemeral_1h_input_tokens: 500 },
      service_tier: "standard",
      inference_geo: "global",
    },
  },
  google: {
    source: "https://ai.google.dev/api/generate-content#UsageMetadata",
    schema: "GenerateContent UsageMetadata",
    raw: {
      promptTokenCount: 100,
      cachedContentTokenCount: 80,
      candidatesTokenCount: 10,
      thoughtsTokenCount: 30,
      totalTokenCount: 140,
    },
  },
  cohere: {
    source: "https://docs.cohere.com/v2/reference/chat",
    schema: "Chat v2 usage (camelCase JS SDK and snake_case HTTP supported)",
    raw: { tokens: { inputTokens: 71, outputTokens: 418 }, billedUnits: { inputTokens: 5, outputTokens: 418 } },
  },
  bedrock: {
    source: "https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html",
    schema: "Converse TokenUsage and CacheDetail",
    raw: {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 12000,
      cacheWriteInputTokens: 2000,
      totalTokens: 15500,
      cacheDetails: [
        { ttl: "5m", inputTokens: 1500 },
        { ttl: "1h", inputTokens: 500 },
      ],
    },
  },
};
