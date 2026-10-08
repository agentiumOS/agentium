import type {
  BillingContext,
  CanonicalTokens,
  NormalizationIssue,
  NormalizedUsage,
  UsageJson,
} from "../cost/accounting-types.js";
import { captureUsage } from "../cost/context.js";
import { TOKEN_METERS, tokenMeasurements } from "../cost/measurements.js";
import {
  readTokenCount,
  retainRawUsage,
  sumTokenCounts,
  unknownTokens,
  validateCanonicalTokens,
} from "../cost/usage.js";
import type { TokenUsage } from "./types.js";

/** A provider accepted the request, but its answer could not be used. Do not retry accounting failures. */
export class ModelUsageError extends Error {
  readonly retryable = false;
  constructor(
    message: string,
    readonly usage: TokenUsage,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ModelUsageError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function rawMetrics(value: UsageJson | undefined): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

/** Project inclusive display counters. Accounting must use accounting, not these legacy zero fallbacks. */
export function projectTokenUsage(accounting: NormalizedUsage): TokenUsage {
  const tokens = accounting.tokens;
  return {
    promptTokens: tokens?.input.total ?? 0,
    completionTokens: tokens?.output.total ?? 0,
    totalTokens: tokens?.total ?? 0,
    ...(tokens?.input.cacheRead !== null && tokens?.input.cacheRead !== undefined
      ? { cachedTokens: tokens.input.cacheRead }
      : {}),
    ...(tokens?.input.cacheWrite !== null && tokens?.input.cacheWrite !== undefined
      ? { cacheWriteTokens: tokens.input.cacheWrite }
      : {}),
    ...(tokens?.output.reasoning !== null && tokens?.output.reasoning !== undefined
      ? { reasoningTokens: tokens.output.reasoning }
      : {}),
    providerMetrics: rawMetrics(accounting.rawUsage),
    accounting,
  };
}

export function safeResponseContext(response: unknown): Partial<BillingContext> {
  const data = record(response);
  const metadata = record(data.$metadata);
  const model = data.model ?? data.modelVersion;
  const requestId = data.id ?? data.responseId ?? data._request_id ?? metadata.requestId;
  return {
    ...(typeof model === "string" ? { modelId: model } : {}),
    ...(typeof requestId === "string" ? { providerRequestId: requestId } : {}),
    ...(typeof data.service_tier === "string" ? { actualServiceTier: data.service_tier } : {}),
    provenance: {
      ...(typeof model === "string" ? { modelId: "response" as const } : {}),
      ...(typeof data.service_tier === "string" ? { actualServiceTier: "response" as const } : {}),
    },
  };
}

/** An API-shaped custom URL does not establish who bills it. Never retain credentials or URL query strings. */
export function endpointBillingContext(providerId: string, baseURL?: string): Partial<BillingContext> {
  const directHosts: Record<string, string[]> = {
    openai: ["api.openai.com"],
    "openai-decisions": ["api.openai.com"],
    deepseek: ["api.deepseek.com"],
    xai: ["api.x.ai"],
    meta: ["api.llama-api.com"],
    vercel: ["api.v0.dev"],
    mistral: ["api.mistral.ai"],
    cohere: ["api.cohere.com"],
    perplexity: ["api.perplexity.ai"],
  };
  const expected = directHosts[providerId];
  if (!expected) return {};
  let hostname: string;
  let resourceId: string | undefined;
  try {
    const parsed = new URL(baseURL ?? `https://${expected[0]}/v1`);
    hostname = parsed.hostname;
    resourceId = `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`;
  } catch {
    return { billingProviderId: "unknown", dimensions: { endpointContract: "unknown" } };
  }
  if (!expected.includes(hostname))
    return {
      billingProviderId: "unknown",
      resourceId,
      dimensions: { endpointContract: "unknown" },
      provenance: { resourceId: "request", billingProviderId: "unknown" },
    };
  return {
    resourceId,
    ...(providerId === "openai" || providerId === "openai-decisions"
      ? { region: "global", provenance: { region: "documented_default" as const, resourceId: "request" as const } }
      : {}),
  };
}

/** Merge sparse stream metadata without dropping earlier returned identity or tier. */
export function mergeResponseContext(current: Partial<BillingContext>, response: unknown): Partial<BillingContext> {
  const next = safeResponseContext(response);
  return { ...current, ...next, provenance: { ...current.provenance, ...next.provenance } };
}

/** Versioned mappings are specific to an API; compatible wire formats do not establish billing rules. */
export function normalizeProviderUsage(
  providerId: string,
  api: string,
  raw: unknown,
  context: Partial<BillingContext> = {},
): NormalizedUsage {
  const data = record(raw);
  const issues: NormalizationIssue[] = [];
  const tokens = unknownTokens();
  const unsupportedFeatures: string[] = context.dimensions?.hostedTools ? ["hosted_tools"] : [];
  if (context.dimensions?.endpointContract === "unknown") unsupportedFeatures.push("custom_endpoint_billing_contract");
  const count = (value: unknown, path: string) => readTokenCount(value, path, issues);
  const sum = (values: (number | null)[], path: string) => sumTokenCounts(values, issues, path);
  const subtract = (total: number | null, read: number | null, write: number | null) => {
    if (total === null || read === null || write === null) return null;
    if (read + write > total) {
      issues.push({ code: "input_partition_mismatch", path: "input", message: "Cache subsets exceed inclusive input" });
      return null;
    }
    return total - read - write;
  };
  const unknownBillableMeters = new Set<string>();
  let knownFields: string[] = [];
  let billedInput: number | null | undefined;
  let billedOutput: number | null | undefined;
  const reviewedMistral =
    providerId === "mistral" && api === "chat-completions" && context.modelId === "mistral-small-2603";
  const reviewedXAI =
    providerId === "xai" && ["chat-completions", "responses"].includes(api) && context.modelId === "grok-4.6";
  const decisionsInputOnly =
    providerId === "openai-decisions" && api === "decisions" && context.modelId === "gpt-6-luna";
  const flagNestedFields = (value: unknown, known: string[], path: string) => {
    const unknown = Object.keys(record(value)).filter((key) => !known.includes(key));
    if (unknown.length) {
      if (!unsupportedFeatures.includes("unrecognized_usage_details"))
        unsupportedFeatures.push("unrecognized_usage_details");
      issues.push({
        code: "unrecognized_usage_details",
        path,
        message: `Unrecognized nested usage fields: ${unknown.join(", ")}`,
      });
    }
  };

  if (api === "messages") {
    if (providerId === "anthropic" && !context.region)
      context = { ...context, region: "global", provenance: { ...context.provenance, region: "documented_default" } };
    if (providerId === "anthropic" && !context.dimensions?.speed && data.speed === undefined)
      context = {
        ...context,
        dimensions: { ...context.dimensions, speed: "standard" },
        provenance: { ...context.provenance, speed: "documented_default" },
      };
    knownFields = [
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
      "cache_creation",
      "service_tier",
      "inference_geo",
      "server_tool_use",
      "iterations",
      "speed",
      "output_tokens_details",
    ];
    tokens.input.ordinary = count(data.input_tokens, "input_tokens");
    tokens.input.cacheRead = count(data.cache_read_input_tokens ?? (raw ? 0 : undefined), "cache_read_input_tokens");
    tokens.input.cacheWrite = count(
      data.cache_creation_input_tokens ?? (raw ? 0 : undefined),
      "cache_creation_input_tokens",
    );
    const creation = record(data.cache_creation);
    flagNestedFields(creation, ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"], "cache_creation");
    flagNestedFields(data.output_tokens_details, ["thinking_tokens"], "output_tokens_details");
    for (const [key, ttlSeconds] of [
      ["ephemeral_5m_input_tokens", 300],
      ["ephemeral_1h_input_tokens", 3600],
    ] as const) {
      const value = count(creation[key], `cache_creation.${key}`);
      if (value !== null) tokens.input.cacheWriteByTTL.push({ ttlSeconds, tokens: value });
    }
    tokens.input.total = sum([tokens.input.ordinary, tokens.input.cacheRead, tokens.input.cacheWrite], "input.total");
    tokens.output.total = count(data.output_tokens, "output_tokens");
    tokens.output.reasoning = count(
      record(data.output_tokens_details).thinking_tokens,
      "output_tokens_details.thinking_tokens",
    );
    if (data.server_tool_use && Object.values(record(data.server_tool_use)).some((value) => value !== 0))
      unsupportedFeatures.push("hosted_tools");
    if (data.iterations) unsupportedFeatures.push("server_iterations");
    if (typeof data.speed === "string") {
      context = { ...context, dimensions: { ...context.dimensions, speed: data.speed } };
      if (
        data.speed !== "standard" &&
        !(providerId === "anthropic" && context.modelId === "claude-opus-5-5" && data.speed === "fast")
      )
        unsupportedFeatures.push("nonstandard_speed");
    }
    if (typeof data.service_tier === "string")
      context = {
        ...context,
        actualServiceTier: data.service_tier,
        provenance: { ...context.provenance, actualServiceTier: "response" },
      };
    if (typeof data.inference_geo === "string")
      context = { ...context, region: data.inference_geo, provenance: { ...context.provenance, region: "response" } };
  } else if (api === "generate-content" || api === "live") {
    knownFields = [
      "promptTokenCount",
      "candidatesTokenCount",
      "thoughtsTokenCount",
      "totalTokenCount",
      "cachedContentTokenCount",
      "toolUsePromptTokenCount",
      "promptTokensDetails",
      "cacheTokensDetails",
      "candidatesTokensDetails",
      "toolUsePromptTokensDetails",
      "serviceTier",
      "trafficType",
      "responseTokenCount",
      "responseTokensDetails",
    ];
    tokens.input.total = count(data.promptTokenCount, "promptTokenCount");
    tokens.input.cacheRead = count(data.cachedContentTokenCount ?? (raw ? 0 : undefined), "cachedContentTokenCount");
    // Cache resource creation/storage is a separate operation in this API.
    tokens.input.cacheWrite = raw ? 0 : null;
    tokens.input.ordinary = subtract(tokens.input.total, tokens.input.cacheRead, tokens.input.cacheWrite);
    tokens.output.reasoning = count(data.thoughtsTokenCount ?? (raw ? 0 : undefined), "thoughtsTokenCount");
    tokens.output.total = sum(
      [
        count(
          api === "live" ? data.responseTokenCount : data.candidatesTokenCount,
          api === "live" ? "responseTokenCount" : "candidatesTokenCount",
        ),
        tokens.output.reasoning,
      ],
      "output.total",
    );
    tokens.providerReportedTotal = count(data.totalTokenCount, "totalTokenCount");
    if (api === "live") unsupportedFeatures.push("live_modality_and_snapshot_semantics");
    if (data.toolUsePromptTokenCount !== undefined && data.toolUsePromptTokenCount !== 0)
      unsupportedFeatures.push("tool_use_prompt_tokens");
    const hasNonText = (value: unknown) =>
      Array.isArray(value) && value.some((part) => record(part).modality !== "TEXT");
    const inputNonText = hasNonText(data.promptTokensDetails) || hasNonText(data.cacheTokensDetails);
    const outputNonText = hasNonText(api === "live" ? data.responseTokensDetails : data.candidatesTokensDetails);
    if (inputNonText || outputNonText) unsupportedFeatures.push("modality_cache_partition");
    if (inputNonText) {
      unknownBillableMeters.add("token.input");
      unknownBillableMeters.add("token.cache_read");
    }
    if (outputNonText) unknownBillableMeters.add("token.output");
    const detailGroups = [
      data.promptTokensDetails,
      api === "live" ? data.responseTokensDetails : data.candidatesTokensDetails,
    ];
    if (!inputNonText && !outputNonText && detailGroups.every((group) => Array.isArray(group) && group.length > 0))
      context = {
        ...context,
        dimensions: { ...context.dimensions, modality: "text" },
        provenance: { ...context.provenance, modality: "response" },
      };
    if (typeof data.serviceTier === "string")
      context = {
        ...context,
        actualServiceTier: data.serviceTier,
        provenance: { ...context.provenance, actualServiceTier: "response" },
      };
  } else if (api === "chat-v2") {
    knownFields = ["tokens", "billedUnits", "billed_units", "cachedTokens", "cached_tokens"];
    const native = record(data.tokens);
    const billed = record(data.billedUnits ?? data.billed_units);
    tokens.input.total = count(native.inputTokens ?? native.input_tokens, "tokens.input_tokens");
    tokens.input.cacheRead = count(data.cachedTokens ?? data.cached_tokens ?? (raw ? 0 : undefined), "cached_tokens");
    tokens.input.cacheWrite = raw ? 0 : null;
    tokens.input.ordinary = subtract(tokens.input.total, tokens.input.cacheRead, tokens.input.cacheWrite);
    tokens.output.total = count(native.outputTokens ?? native.output_tokens, "tokens.output_tokens");
    billedInput = count(billed.inputTokens ?? billed.input_tokens, "billed_units.input_tokens");
    billedOutput = count(billed.outputTokens ?? billed.output_tokens, "billed_units.output_tokens");
    if (
      Object.keys(billed).some((key) => !["inputTokens", "input_tokens", "outputTokens", "output_tokens"].includes(key))
    )
      unsupportedFeatures.push("additional_billed_units");
  } else if (api === "converse") {
    knownFields = [
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "cacheReadInputTokens",
      "cacheWriteInputTokens",
      "cacheDetails",
    ];
    tokens.input.ordinary = count(data.inputTokens, "inputTokens");
    tokens.input.cacheRead = count(data.cacheReadInputTokens ?? (raw ? 0 : undefined), "cacheReadInputTokens");
    tokens.input.cacheWrite = count(data.cacheWriteInputTokens ?? (raw ? 0 : undefined), "cacheWriteInputTokens");
    tokens.input.total = sum([tokens.input.ordinary, tokens.input.cacheRead, tokens.input.cacheWrite], "input.total");
    tokens.output.total = count(data.outputTokens, "outputTokens");
    tokens.providerReportedTotal = count(data.totalTokens, "totalTokens");
    if (Array.isArray(data.cacheDetails)) {
      for (const item of data.cacheDetails) {
        const detail = record(item);
        const ttlSeconds = detail.ttl === "5m" ? 300 : detail.ttl === "1h" ? 3600 : null;
        const value = count(detail.inputTokens, "cacheDetails.inputTokens");
        if (ttlSeconds !== null && value !== null) tokens.input.cacheWriteByTTL.push({ ttlSeconds, tokens: value });
        else unsupportedFeatures.push("cache_duration_details");
      }
    }
  } else if (api === "ollama-chat") {
    knownFields = [
      "prompt_eval_count",
      "eval_count",
      "total_duration",
      "load_duration",
      "prompt_eval_duration",
      "eval_duration",
    ];
    tokens.input.total = count(data.prompt_eval_count, "prompt_eval_count");
    tokens.input.ordinary = tokens.input.total;
    tokens.input.cacheRead = raw ? 0 : null;
    tokens.input.cacheWrite = raw ? 0 : null;
    tokens.output.total = count(data.eval_count, "eval_count");
    unsupportedFeatures.push("host_compute_contract");
  } else if (api === "jev") {
    knownFields = ["input_tokens", "output_tokens"];
    tokens.input.total = count(data.input_tokens, "input_tokens");
    tokens.output.total = count(data.output_tokens, "output_tokens");
    unsupportedFeatures.push("jev_billing_contract");
  } else {
    // xAI's legacy schema reports visible completions separately from reasoning, even on compatible endpoints.
    const responses = reviewedXAI ? data.input_tokens !== undefined : api === "responses" || api === "decisions";
    const detailsIn = record(
      data[responses ? "input_tokens_details" : "prompt_tokens_details"] ??
        (reviewedMistral ? data.promptTokensDetails : undefined),
    );
    const detailsOut = record(data[responses ? "output_tokens_details" : "completion_tokens_details"]);
    const unknownDetails = [
      ...Object.keys(detailsIn).filter(
        (key) =>
          ![
            "cached_tokens",
            ...(reviewedMistral ? ["cachedTokens"] : []),
            "cache_write_tokens",
            "audio_tokens",
            "text_tokens",
            "image_tokens",
          ].includes(key),
      ),
      ...Object.keys(detailsOut).filter(
        (key) =>
          ![
            "reasoning_tokens",
            "audio_tokens",
            "text_tokens",
            "image_tokens",
            "accepted_prediction_tokens",
            "rejected_prediction_tokens",
          ].includes(key),
      ),
    ];
    if (unknownDetails.length) {
      unsupportedFeatures.push("unrecognized_usage_details");
      issues.push({
        code: "unrecognized_usage_details",
        message: `Unrecognized nested usage fields: ${unknownDetails.join(", ")}`,
      });
    }
    knownFields = [
      "input_tokens",
      "output_tokens",
      "total_tokens",
      "prompt_tokens",
      "completion_tokens",
      "promptTokens",
      "completionTokens",
      "totalTokens",
      "input_tokens_details",
      "output_tokens_details",
      "prompt_tokens_details",
      "completion_tokens_details",
      "prompt_cache_hit_tokens",
      "prompt_cache_miss_tokens",
      "reasoning_tokens",
      "cost",
      "search_context_size",
      "num_search_queries",
      "citation_tokens",
      ...(reviewedMistral ? ["promptTokensDetails"] : []),
      ...(reviewedXAI ? ["num_sources_used", "num_server_side_tools_used", "cost_in_usd_ticks"] : []),
    ];
    tokens.input.total = count(
      data[responses ? "input_tokens" : "prompt_tokens"] ?? data.promptTokens,
      responses ? "input_tokens" : "prompt_tokens",
    );
    tokens.output.total = count(
      data[responses ? "output_tokens" : "completion_tokens"] ?? data.completionTokens,
      responses ? "output_tokens" : "completion_tokens",
    );
    tokens.output.reasoning = count(
      detailsOut.reasoning_tokens ?? data.reasoning_tokens,
      "output_tokens_details.reasoning_tokens",
    );
    if (reviewedXAI && !responses)
      tokens.output.total = sum([tokens.output.total, tokens.output.reasoning], "output.total");
    if (
      reviewedXAI &&
      [data.num_sources_used, data.num_server_side_tools_used].some((value) => value !== undefined && value !== 0)
    )
      unsupportedFeatures.push("hosted_tools");
    tokens.providerReportedTotal = count(data.total_tokens ?? data.totalTokens, "total_tokens");
    tokens.input.cacheRead = count(
      detailsIn.cached_tokens ??
        (reviewedMistral ? detailsIn.cachedTokens : undefined) ??
        data.prompt_cache_hit_tokens ??
        (reviewedMistral && raw ? 0 : undefined),
      "input_tokens_details.cached_tokens",
    );
    tokens.input.cacheWrite = count(detailsIn.cache_write_tokens, "input_tokens_details.cache_write_tokens");
    if (reviewedMistral || reviewedXAI) tokens.input.cacheWrite = raw ? 0 : null;
    if (providerId === "deepseek") {
      tokens.input.cacheWrite = raw ? 0 : null;
      tokens.input.ordinary = count(data.prompt_cache_miss_tokens, "prompt_cache_miss_tokens");
    } else {
      tokens.input.ordinary = subtract(tokens.input.total, tokens.input.cacheRead, tokens.input.cacheWrite);
    }
    if (
      providerId !== "openai" &&
      providerId !== "openai-decisions" &&
      providerId !== "deepseek" &&
      !reviewedMistral &&
      !reviewedXAI
    )
      unsupportedFeatures.push(`${providerId}_billing_contract`);
    const inputAudio = typeof detailsIn.audio_tokens === "number" && detailsIn.audio_tokens > 0;
    const outputAudio = typeof detailsOut.audio_tokens === "number" && detailsOut.audio_tokens > 0;
    if (inputAudio || outputAudio) unsupportedFeatures.push("modality_cache_partition");
    if (inputAudio)
      for (const meter of ["token.input", "token.cache_read", "token.cache_write"]) unknownBillableMeters.add(meter);
    if (outputAudio) unknownBillableMeters.add("token.output");
    if (providerId === "perplexity") unsupportedFeatures.push("search_request_fees");
  }
  tokens.total = sum([tokens.input.total, tokens.output.total], "total");
  validateCanonicalTokens(tokens, issues);
  const unknownFields = Object.keys(data).filter((key) => !knownFields.includes(key));
  if (unknownFields.length) {
    unsupportedFeatures.push("unrecognized_usage_fields");
    issues.push({
      code: "unrecognized_usage_fields",
      message: `Unrecognized usage fields: ${unknownFields.join(", ")}`,
    });
  }
  const measurements = tokenMeasurements(tokens, issues);
  if (api === "messages" && tokens.input.cacheWrite === 0 && tokens.input.cacheWriteByTTL.length === 0) {
    const write = measurements.find((measurement) => measurement.meter === "token.cache_write");
    if (write) write.dimensions.ttlSeconds = "none";
  }
  if (decisionsInputOnly) {
    // This endpoint charges inclusive input once. Cache/output counts remain statistics, not payable units.
    for (const measurement of measurements) {
      measurement.quantity =
        measurement.meter === "token.input" ? (tokens.input.total === null ? null : String(tokens.input.total)) : "0";
      measurement.source = "derived";
      measurement.evidencePaths =
        measurement.meter === "token.input" ? ["input_tokens"] : ["contract:openai/decisions/gpt-6-luna/input-only"];
    }
  }
  if (api === "chat-v2") {
    // Provider billed units are authoritative for prices; token counts remain separate statistics.
    for (const measurement of measurements) {
      if (measurement.meter === "token.input" || measurement.meter === "token.output") {
        const quantity = measurement.meter === "token.input" ? billedInput : billedOutput;
        measurement.quantity = quantity === null || quantity === undefined ? null : String(quantity);
        measurement.source = "provider";
        measurement.evidencePaths = [
          measurement.meter === "token.input" ? "billed_units.input_tokens" : "billed_units.output_tokens",
        ];
      }
    }
  }
  // Marginal counts do not establish billable modality/cache intersections. Do not report guessed cells as known cost.
  for (const measurement of measurements) if (unknownBillableMeters.has(measurement.meter)) measurement.quantity = null;
  return {
    schemaVersion: 1,
    normalizerId: `${providerId}/${api}`,
    normalizerVersion: "1.1.0",
    tokens,
    measurements,
    coverage: { requiredMeters: [...TOKEN_METERS], unsupportedFeatures },
    ...retainRawUsage(raw),
    issues,
    context: {
      providerId,
      billingProviderId: providerId === "openai-decisions" ? "openai" : providerId,
      api,
      ...context,
      ...(tokens.input.total !== null ? { inputTokens: tokens.input.total } : {}),
    },
  };
}

export function providerTokenUsage(
  providerId: string,
  api: string,
  raw: unknown,
  context?: Partial<BillingContext>,
): TokenUsage {
  const normalized = normalizeProviderUsage(providerId, api, raw, context);
  const usage = projectTokenUsage(normalized);
  const data = record(raw);
  const inputDetails = record(data.prompt_tokens_details ?? data.input_tokens_details);
  const outputDetails = record(data.completion_tokens_details ?? data.output_tokens_details);
  const audioInput = readTokenCount(inputDetails.audio_tokens, "audio_tokens", normalized.issues);
  const audioOutput = readTokenCount(outputDetails.audio_tokens, "audio_tokens", normalized.issues);
  if (audioInput !== null) usage.audioInputTokens = audioInput;
  if (audioOutput !== null) usage.audioOutputTokens = audioOutput;
  captureUsage(usage);
  return usage;
}

/** Custom legacy adapters cannot prove cache partition or physical request visibility. */
export function normalizeLegacyUsage(usage: TokenUsage, providerId: string, modelId: string): NormalizedUsage {
  if (usage.accounting) return usage.accounting;
  const issues: NormalizationIssue[] = [];
  const tokens: CanonicalTokens = unknownTokens();
  tokens.input.total = readTokenCount(usage.promptTokens, "promptTokens", issues);
  tokens.input.cacheRead = readTokenCount(usage.cachedTokens, "cachedTokens", issues);
  tokens.input.cacheWrite = readTokenCount(usage.cacheWriteTokens, "cacheWriteTokens", issues);
  tokens.output.total = readTokenCount(usage.completionTokens, "completionTokens", issues);
  tokens.output.reasoning = readTokenCount(usage.reasoningTokens, "reasoningTokens", issues);
  tokens.providerReportedTotal = readTokenCount(usage.totalTokens, "totalTokens", issues);
  tokens.total = sumTokenCounts([tokens.input.total, tokens.output.total], issues, "total");
  validateCanonicalTokens(tokens, issues);
  return {
    schemaVersion: 1,
    normalizerId: "agentium/legacy",
    normalizerVersion: "1.0.0",
    tokens,
    measurements: tokenMeasurements(tokens, issues),
    coverage: { requiredMeters: [...TOKEN_METERS], unsupportedFeatures: ["legacy_token_semantics"] },
    ...retainRawUsage(usage.providerMetrics),
    issues,
    context: { providerId, billingProviderId: providerId, modelId, api: "unknown" },
  };
}
