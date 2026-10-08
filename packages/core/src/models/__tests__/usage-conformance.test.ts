import { describe, expect, it } from "vitest";
import {
  iterChatCompletionStream,
  iterResponsesStream,
  normalizeChatCompletionsResponse,
  normalizeResponsesResponse,
} from "../openai-api.js";
import { MODEL_USAGE_CAPABILITIES } from "../usage-capabilities.js";
import {
  endpointBillingContext,
  ModelUsageError,
  normalizeLegacyUsage,
  normalizeProviderUsage,
  providerTokenUsage,
} from "../usage-normalizers.js";
import { USAGE_FIXTURES } from "./fixtures/usage-fixtures.js";

async function* stream(events: unknown[]) {
  yield* events;
}

describe("canonical provider usage", () => {
  it.each([
    [19, 16, 9, 35],
    [19, 76, 64, 95],
  ])("counts inclusive output once (%s/%s/%s)", (input, output, reasoning, total) => {
    const usage = providerTokenUsage("openai", "responses", {
      input_tokens: input,
      output_tokens: output,
      total_tokens: total,
      output_tokens_details: { reasoning_tokens: reasoning },
    });
    expect(usage.totalTokens).toBe(total);
    expect(usage.accounting?.tokens?.output).toEqual({ total: output, reasoning });
    expect(usage.accounting?.measurements.some((value) => value.meter.includes("reasoning"))).toBe(false);
  });
  it("partitions OpenAI reads and writes without adding them to inclusive input", () => {
    const usage = normalizeProviderUsage("openai", "responses", USAGE_FIXTURES.openai.raw);
    expect(usage.tokens?.input).toEqual({
      total: 15000,
      ordinary: 1000,
      cacheRead: 12000,
      cacheWrite: 2000,
      cacheWriteByTTL: [],
    });
    expect(usage.measurements.map((value) => value.quantity)).toEqual(["1000", "12000", "2000", "500"]);
    expect(usage.issues).toEqual([]);
  });
  it.each(["anthropic", "aws-claude"])("adds exclusive %s input and preserves both TTL buckets", (provider) => {
    const usage = normalizeProviderUsage(provider, "messages", USAGE_FIXTURES.anthropic.raw);
    expect(usage.tokens?.input.total).toBe(15000);
    expect(usage.tokens?.total).toBe(15500);
    const writes = usage.measurements.filter((value) => value.meter === "token.cache_write");
    expect(writes.map((value) => [value.quantity, value.dimensions.ttlSeconds])).toEqual([
      ["1500", "300"],
      ["500", "3600"],
    ]);
    expect(usage.context?.actualServiceTier).toBe("standard");
  });
  it.each(["google", "vertex"])("maps %s thoughts into inclusive output", (provider) => {
    const usage = normalizeProviderUsage(provider, "generate-content", USAGE_FIXTURES.google.raw);
    expect(usage.tokens?.output).toEqual({ total: 40, reasoning: 30 });
    expect(usage.tokens?.total).toBe(140);
    expect(usage.tokens?.input).toMatchObject({ ordinary: 20, cacheRead: 80, cacheWrite: 0 });
  });
  it("does not force Google unexplained residuals into billable input", () => {
    const usage = normalizeProviderUsage("google", "generate-content", {
      ...USAGE_FIXTURES.google.raw,
      totalTokenCount: 160,
      toolUsePromptTokenCount: 20,
    });
    expect(usage.tokens?.total).toBe(140);
    expect(usage.tokens?.providerReportedTotal).toBe(160);
    expect(usage.issues.map((issue) => issue.code)).toContain("provider_total_mismatch");
    expect(usage.coverage.unsupportedFeatures).toContain("tool_use_prompt_tokens");
  });
  it("retains Cohere token statistics but prices its separate billed units", () => {
    const usage = normalizeProviderUsage("cohere", "chat-v2", USAGE_FIXTURES.cohere.raw);
    expect(usage.tokens?.input.total).toBe(71);
    expect(usage.measurements.find((value) => value.meter === "token.input")?.quantity).toBe("5");
    expect(usage.rawUsage).toEqual(USAGE_FIXTURES.cohere.raw);
  });
  it("maps Bedrock exclusive input and TTL details", () => {
    const usage = normalizeProviderUsage("aws-bedrock", "converse", USAGE_FIXTURES.bedrock.raw);
    expect(usage.tokens?.total).toBe(15500);
    expect(usage.measurements.filter((item) => item.meter === "token.cache_write")).toHaveLength(2);
  });
  it.each(["azure-openai", "azure-foundry", "xai", "meta", "mistral", "perplexity", "vercel", "custom"])(
    "does not equate %s wire compatibility with OpenAI billing",
    (provider) => {
      const usage = normalizeProviderUsage(provider, "chat-completions", {
        prompt_tokens: 5,
        completion_tokens: 3,
        total_tokens: 8,
      });
      expect(usage.context?.billingProviderId).toBe(provider);
      expect(usage.coverage.unsupportedFeatures).toContain(`${provider}_billing_contract`);
      expect(usage.tokens?.input.cacheWrite).toBeNull();
    },
  );
  it("maps DeepSeek cache hits/misses without a made-up cache write fee", () => {
    const usage = normalizeProviderUsage("deepseek", "chat-completions", {
      prompt_tokens: 100,
      prompt_cache_hit_tokens: 80,
      prompt_cache_miss_tokens: 20,
      completion_tokens: 5,
      total_tokens: 105,
    });
    expect(usage.tokens?.input).toMatchObject({ total: 100, ordinary: 20, cacheRead: 80, cacheWrite: 0 });
  });
  it.each([
    ["ollama", "ollama-chat", { prompt_eval_count: 4, eval_count: 2 }],
    ["jev", "jev", { input_tokens: 4, output_tokens: 2 }],
  ] as const)("retains %s statistics without assuming free hosting", (provider, api, raw) => {
    const usage = normalizeProviderUsage(provider, api, raw);
    expect(usage.tokens?.total).toBe(6);
    expect(usage.coverage.unsupportedFeatures.length).toBeGreaterThan(0);
  });
  it("does not invent omitted cache counters or a tier", () => {
    const usage = normalizeProviderUsage("openai", "responses", { input_tokens: 19, output_tokens: 16 });
    expect(usage.tokens?.input.cacheRead).toBeNull();
    expect(usage.tokens?.input.cacheWrite).toBeNull();
    expect(usage.tokens?.input.ordinary).toBeNull();
    expect(usage.context?.actualServiceTier).toBeUndefined();
  });
  it("preserves unknown billing fields and flags them", () => {
    const usage = normalizeProviderUsage("openai", "responses", {
      ...USAGE_FIXTURES.openai.raw,
      new_billable_units: 7,
    });
    expect(usage.rawUsage).toHaveProperty("new_billable_units", 7);
    expect(usage.coverage.unsupportedFeatures).toContain("unrecognized_usage_fields");
  });
  it("flags independent modality and cache marginals instead of guessing an intersection", () => {
    const usage = normalizeProviderUsage("openai", "chat-completions", {
      prompt_tokens: 100,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 0, audio_tokens: 40 },
    });
    expect(usage.coverage.unsupportedFeatures).toContain("modality_cache_partition");
  });
  it("requires explicit normalization for custom legacy adapters", () => {
    const usage = normalizeLegacyUsage(
      { promptTokens: 19, completionTokens: 16, totalTokens: 44, reasoningTokens: 9 },
      "custom",
      "model",
    );
    expect(usage.tokens?.total).toBe(35);
    expect(usage.tokens?.providerReportedTotal).toBe(44);
    expect(usage.coverage.unsupportedFeatures).toContain("legacy_token_semantics");
  });
});

describe("OpenAI failure and stream evidence", () => {
  it("captures Chat usage before malformed tool arguments", () => {
    try {
      normalizeChatCompletionsResponse({
        usage: { prompt_tokens: 19, completion_tokens: 16, total_tokens: 35 },
        choices: [{ message: { tool_calls: [{ function: { arguments: "{" } }] } }],
      });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelUsageError);
      if (error instanceof ModelUsageError) expect(error.usage.totalTokens).toBe(35);
    }
  });
  it("captures Responses failure usage and returned model/tier", () => {
    try {
      normalizeResponsesResponse({
        status: "failed",
        model: "actual",
        service_tier: "default",
        usage: USAGE_FIXTURES.openai.raw,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ModelUsageError);
      if (error instanceof ModelUsageError) {
        expect(error.usage.totalTokens).toBe(15500);
        expect(error.usage.accounting?.context).toMatchObject({ modelId: "actual", actualServiceTier: "default" });
      }
    }
  });
  it("reads Chat usage-only tails once", async () => {
    const chunks = [];
    for await (const chunk of iterChatCompletionStream(
      stream([
        { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 19, completion_tokens: 16, total_tokens: 35 } },
      ]),
    ))
      chunks.push(chunk);
    const finishes = chunks.filter((chunk) => chunk.type === "finish");
    expect(finishes).toHaveLength(1);
    expect(finishes[0]).toMatchObject({ usage: { totalTokens: 35 } });
  });
  it("captures incomplete Responses terminal usage", async () => {
    try {
      for await (const _chunk of iterResponsesStream(
        stream([{ type: "response.incomplete", response: { usage: USAGE_FIXTURES.openai.raw } }]),
      )) {
        /* consume */
      }
    } catch (error) {
      expect(error).toBeInstanceOf(ModelUsageError);
      if (error instanceof ModelUsageError) expect(error.usage.cacheWriteTokens).toBe(2000);
    }
  });
});

// Instantiate only the adapter boundary, with deterministic SDK-shaped transports.
import type { ModelProvider } from "../provider.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { AwsBedrockProvider } from "../providers/aws-bedrock.js";
import { AwsClaudeProvider } from "../providers/aws-claude.js";
import { CohereProvider } from "../providers/cohere.js";
import { GoogleProvider } from "../providers/google.js";
import { MistralProvider } from "../providers/mistral.js";
import { PerplexityProvider } from "../providers/perplexity.js";
import { VertexAIProvider } from "../providers/vertex.js";
import type { StreamChunk } from "../types.js";

function adapter(prototype: ModelProvider, providerId: string, fields: Record<string, unknown>): ModelProvider {
  const provider: ModelProvider = Object.create(prototype);
  Object.assign(provider, { providerId, modelId: "fixture-model", ...fields });
  return provider;
}
async function collect(provider: ModelProvider): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of provider.stream([{ role: "user", content: "fixture" }])) chunks.push(chunk);
  return chunks;
}

describe("native adapter stream conformance", () => {
  it.each([
    [AnthropicProvider.prototype, "anthropic"],
    [AwsClaudeProvider.prototype, "aws-claude"],
  ] as const)("retains %s initial cache counters through terminal output", async (prototype, providerId) => {
    const events = [
      {
        type: "message_start",
        message: { id: "fixture", usage: { ...USAGE_FIXTURES.anthropic.raw, output_tokens: 0 } },
      },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 500 } },
    ];
    const provider = adapter(prototype, providerId, { client: { messages: { create: async () => stream(events) } } });
    const finishes = (await collect(provider)).filter((chunk) => chunk.type === "finish");
    expect(finishes).toHaveLength(1);
    expect(finishes[0]).toMatchObject({
      usage: {
        promptTokens: 15000,
        completionTokens: 500,
        totalTokens: 15500,
        cachedTokens: 12000,
        cacheWriteTokens: 2000,
      },
    });
  });
  it.each([
    [GoogleProvider.prototype, "google"],
    [VertexAIProvider.prototype, "vertex"],
  ] as const)("retains metadata without candidates for %s", async (prototype, providerId) => {
    const events = [
      { candidates: [{ content: { parts: [{ text: "hello" }] }, finishReason: "STOP" }] },
      { usageMetadata: USAGE_FIXTURES.google.raw },
    ];
    const provider = adapter(prototype, providerId, {
      ai: { models: { generateContentStream: async () => stream(events) } },
    });
    const finishes = (await collect(provider)).filter((chunk) => chunk.type === "finish" && chunk.usage);
    expect(finishes).toHaveLength(1);
    expect(finishes[0]).toMatchObject({ usage: { completionTokens: 40, reasoningTokens: 30, totalTokens: 140 } });
  });
  it("keeps Bedrock tool finish reason until metadata arrives", async () => {
    const provider = adapter(AwsBedrockProvider.prototype, "aws-bedrock", {
      Cmds: { ConverseStreamCommand: class {} },
      client: {
        send: async () => ({
          stream: stream([
            { messageStop: { stopReason: "tool_use" } },
            { metadata: { usage: USAGE_FIXTURES.bedrock.raw } },
          ]),
        }),
      },
    });
    const finishes = (await collect(provider)).filter((chunk) => chunk.type === "finish");
    expect(finishes).toHaveLength(1);
    expect(finishes[0]).toMatchObject({
      finishReason: "tool_calls",
      usage: { totalTokens: 15500, cacheWriteTokens: 2000 },
    });
  });
  it("retains Cohere billed units at message-end", async () => {
    const provider = adapter(CohereProvider.prototype, "cohere", {
      mode: "native",
      client: {
        chatStream: async () => stream([{ type: "message-end", delta: { usage: USAGE_FIXTURES.cohere.raw } }]),
      },
    });
    const finishes = (await collect(provider)).filter((chunk) => chunk.type === "finish");
    const usage = finishes[0]?.usage;
    expect(usage?.promptTokens).toBe(71);
    expect(usage?.accounting?.measurements[0].quantity).toBe("5");
  });
  it("reads Mistral usage-only tails", async () => {
    const provider = adapter(MistralProvider.prototype, "mistral", {
      mode: "native",
      client: {
        chat: {
          stream: async () =>
            stream([
              { data: { choices: [{ delta: { content: "ok" }, finishReason: "stop" }] } },
              { data: { usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 } } },
            ]),
        },
      },
    });
    const finishes = (await collect(provider)).filter((chunk) => chunk.type === "finish");
    expect(finishes).toHaveLength(1);
    expect(finishes[0]?.usage?.totalTokens).toBe(8);
  });
  it("emits one Perplexity finish after late usage", async () => {
    const provider = adapter(PerplexityProvider.prototype, "perplexity", {
      mode: "native",
      client: {
        chat: {
          completions: {
            create: async () =>
              stream([
                { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
                { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
              ]),
          },
        },
      },
    });
    const finishes = (await collect(provider)).filter((chunk) => chunk.type === "finish");
    expect(finishes).toHaveLength(1);
    expect(finishes[0]?.usage?.totalTokens).toBe(8);
  });
});

describe("capability inventory", () => {
  it.each(MODEL_USAGE_CAPABILITIES)("preserves missing usage for $providerId/$api", ({ providerId, api }) => {
    const usage = normalizeProviderUsage(providerId, api, undefined);
    expect(usage.tokens?.total).toBeNull();
    expect(usage.tokens?.input.total).toBeNull();
    expect(usage.context?.providerId).toBe(providerId);
    expect(usage.context?.api).toBe(api);
    expect(usage.coverage.requiredMeters).toEqual([
      "token.input",
      "token.cache_read",
      "token.cache_write",
      "token.output",
    ]);
  });
  it("flags unknown nested counters without charging them", () => {
    const usage = normalizeProviderUsage("openai", "responses", {
      ...USAGE_FIXTURES.openai.raw,
      input_tokens_details: { ...USAGE_FIXTURES.openai.raw.input_tokens_details, future_billable_tokens: 100 },
    });
    expect(usage.coverage.unsupportedFeatures).toContain("unrecognized_usage_details");
    expect(usage.measurements).toHaveLength(4);
  });
});

describe("billing endpoint identity", () => {
  it("marks a custom OpenAI endpoint biller unknown and removes URL credentials", () => {
    const context = endpointBillingContext("openai", "https://user:password@gateway.example/v1?api_key=private");
    expect(context.billingProviderId).toBe("unknown");
    expect(context.resourceId).toBe("https://gateway.example/v1");
    expect(JSON.stringify(context)).not.toContain("private");
    expect(JSON.stringify(context)).not.toContain("password");
    const usage = normalizeProviderUsage("openai", "responses", USAGE_FIXTURES.openai.raw, context);
    expect(usage.coverage.unsupportedFeatures).toContain("custom_endpoint_billing_contract");
  });
  it("records the documented OpenAI global region only for the native endpoint", () => {
    expect(endpointBillingContext("openai")).toMatchObject({
      region: "global",
      provenance: { region: "documented_default" },
    });
    expect(endpointBillingContext("openai", "https://gateway.example/v1").region).toBeUndefined();
  });
  it("retains early stream identity and tier when the usage-only tail omits them", async () => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of iterChatCompletionStream(
      stream([
        {
          id: "request-1",
          model: "actual-model",
          service_tier: "default",
          choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
        },
        { choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } },
      ]),
      "openai",
      "requested-model",
    ))
      chunks.push(chunk);
    const finish = chunks.find((chunk) => chunk.type === "finish");
    expect(finish?.usage?.accounting?.context).toMatchObject({
      modelId: "actual-model",
      actualServiceTier: "default",
      providerRequestId: "request-1",
    });
  });
});

describe("native adapter non-stream conformance", () => {
  it.each([
    [AnthropicProvider.prototype, "anthropic"],
    [AwsClaudeProvider.prototype, "aws-claude"],
  ] as const)("captures %s usage and identity before output processing", async (prototype, providerId) => {
    const provider = adapter(prototype, providerId, {
      client: {
        messages: {
          create: async () => ({
            id: "request",
            model: "actual",
            content: [{ type: "text", text: "ok" }],
            usage: USAGE_FIXTURES.anthropic.raw,
            stop_reason: "end_turn",
          }),
        },
      },
    });
    const result = await provider.generate([{ role: "user", content: "fixture" }]);
    expect(result.usage.accounting?.tokens?.input.total).toBe(15000);
    expect(result.usage.accounting?.context).toMatchObject({ modelId: "actual", providerRequestId: "request" });
  });
  it.each([
    [GoogleProvider.prototype, "google"],
    [VertexAIProvider.prototype, "vertex"],
  ] as const)("captures %s usage separately from response content", async (prototype, providerId) => {
    const provider = adapter(prototype, providerId, {
      ai: {
        models: {
          generateContent: async () => ({
            responseId: "request",
            modelVersion: "actual",
            candidates: [{ content: { parts: [{ text: "ok" }] } }],
            usageMetadata: USAGE_FIXTURES.google.raw,
          }),
        },
      },
    });
    const result = await provider.generate([{ role: "user", content: "fixture" }]);
    expect(result.usage.accounting?.tokens?.output.total).toBe(40);
    expect(result.usage.accounting?.context).toMatchObject({ modelId: "actual", providerRequestId: "request" });
    expect(result.usage.accounting?.rawUsage).not.toHaveProperty("candidates");
  });
  it("captures Bedrock safe request ID without raw response metadata", async () => {
    const provider = adapter(AwsBedrockProvider.prototype, "aws-bedrock", {
      Cmds: { ConverseCommand: class {} },
      client: {
        send: async () => ({
          $metadata: { requestId: "request" },
          output: { message: { content: [{ text: "ok" }] } },
          usage: USAGE_FIXTURES.bedrock.raw,
        }),
      },
    });
    const result = await provider.generate([{ role: "user", content: "fixture" }]);
    expect(result.usage.totalTokens).toBe(15500);
    expect(result.usage.accounting?.context?.providerRequestId).toBe("request");
    expect(result.usage.accounting?.rawUsage).not.toHaveProperty("$metadata");
  });
  it("captures Cohere v2 billed units through the real adapter", async () => {
    const provider = adapter(CohereProvider.prototype, "cohere", {
      mode: "native",
      client: {
        chat: async () => ({ message: { content: [{ type: "text", text: "ok" }] }, usage: USAGE_FIXTURES.cohere.raw }),
      },
    });
    const result = await provider.generate([{ role: "user", content: "fixture" }]);
    expect(result.usage.promptTokens).toBe(71);
    expect(result.usage.accounting?.measurements[0].quantity).toBe("5");
  });
});

describe("reviewed provider-specific usage contracts", () => {
  it("adds xAI legacy reasoning once but preserves inclusive Responses output", () => {
    const chat = normalizeProviderUsage(
      "xai",
      "chat-completions",
      {
        prompt_tokens: 32,
        completion_tokens: 9,
        total_tokens: 135,
        prompt_tokens_details: { cached_tokens: 6 },
        completion_tokens_details: { reasoning_tokens: 94 },
      },
      { modelId: "grok-4.6" },
    );
    expect(chat.tokens?.output).toEqual({ total: 103, reasoning: 94 });
    expect(chat.tokens?.total).toBe(135);
    expect(chat.issues).toEqual([]);
    expect(chat.coverage.unsupportedFeatures).toEqual([]);
    const responses = normalizeProviderUsage(
      "xai",
      "responses",
      {
        input_tokens: 131,
        output_tokens: 624,
        total_tokens: 755,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 246 },
      },
      { modelId: "grok-4.6" },
    );
    expect(responses.tokens?.output).toEqual({ total: 624, reasoning: 246 });
    expect(responses.tokens?.total).toBe(755);
    expect(responses.issues).toEqual([]);
  });
  it("leaves xAI legacy inclusive output unknown when reasoning is omitted", () => {
    const usage = normalizeProviderUsage(
      "xai",
      "chat-completions",
      { prompt_tokens: 32, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 6 } },
      { modelId: "grok-4.6" },
    );
    expect(usage.tokens?.output.total).toBeNull();
    expect(usage.measurements.find((measurement) => measurement.meter === "token.output")?.quantity).toBeNull();
  });
  it("retains unpriced xAI hosted tool usage", () => {
    const usage = normalizeProviderUsage(
      "xai",
      "chat-completions",
      {
        prompt_tokens: 32,
        completion_tokens: 9,
        prompt_tokens_details: { cached_tokens: 6 },
        completion_tokens_details: { reasoning_tokens: 94 },
        num_server_side_tools_used: 1,
      },
      { modelId: "grok-4.6" },
    );
    expect(usage.coverage.unsupportedFeatures).toContain("hosted_tools");
  });
  it("maps omitted Mistral cached tokens to the documented no-hit case", () => {
    const usage = normalizeProviderUsage(
      "mistral",
      "chat-completions",
      { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      { modelId: "mistral-small-2603" },
    );
    expect(usage.tokens?.input).toMatchObject({ ordinary: 5, cacheRead: 0, cacheWrite: 0 });
    expect(usage.coverage.unsupportedFeatures).toEqual([]);
  });
  it.each(["cache_creation", "output_tokens_details"])("retains and flags future Anthropic %s fields", (field) => {
    const usage = normalizeProviderUsage("anthropic", "messages", {
      input_tokens: 4,
      output_tokens: 2,
      [field]: { future_billable_tokens: 7 },
    });
    expect(usage.coverage.unsupportedFeatures).toContain("unrecognized_usage_details");
    expect(usage.rawUsage).toHaveProperty(`${field}.future_billable_tokens`, 7);
  });
});
