import { createRequire } from "node:module";
import type OpenAI from "openai";
import { z } from "zod";
import { buildDecisionInput, validateDecisionInput } from "../decision-input.js";
import {
  type DecisionInputItem,
  type DecisionQuestion,
  parseDecisionQuestions,
  parseDecisionResponse,
} from "../decisions.js";
import type { ModelProvider } from "../provider.js";
import type { ChatMessage, ModelConfig, ModelResponse, StreamChunk, ToolDefinition } from "../types.js";
import {
  endpointBillingContext,
  ModelUsageError,
  mergeResponseContext,
  providerTokenUsage,
} from "../usage-normalizers.js";

const requireSDK = createRequire(import.meta.url);
const SDK_REQUIRED = "OpenAI Decisions requires openai >= 7.30.0. Install it: npm install openai@^7.30.0";

export interface OpenAIDecisionsConfig {
  /** Falls back to OPENAI_API_KEY. A run's apiKey takes precedence. */
  apiKey?: string;
  /** OpenAI API root, including /v1. */
  baseURL?: string;
  /** Replaced by questions supplied to run() or stream(). */
  questions?: DecisionQuestion[];
  /** Opaque end-user identifier; this does not authenticate the user. */
  safetyIdentifier?: string;
  /** Partition reusable prompt prefixes. */
  promptCacheKey?: string;
  /** Disable the implicit cache breakpoint. With no explicit markers, caching is disabled. */
  promptCacheOptions?: { mode: "explicit" };
}

/** Native evidence evaluation without changing the generic chat input contract. */
export interface OpenAIDecisionsEvaluateOptions {
  questions?: DecisionQuestion[];
  signal?: AbortSignal;
  apiKey?: string;
  promptCacheKey?: string;
  promptCacheOptions?: { mode: "explicit" };
}

const cacheSchema = z.object({
  prompt_cache_key: z.string().max(64).optional(),
  prompt_cache_options: z
    .object({ mode: z.literal("explicit") })
    .strict()
    .optional(),
});
const responseEnvelope = z.object({ usage: z.unknown().optional() }).passthrough();

/** Typed classification through POST /v1/decisions; no generated tool arguments. */
export class OpenAIDecisionsProvider implements ModelProvider {
  readonly providerId = "openai-decisions";
  readonly modelId: string;
  private client?: OpenAI;

  constructor(
    modelId = "gpt-6-luna",
    private readonly config: OpenAIDecisionsConfig = {},
  ) {
    this.modelId = modelId;
  }

  private getClient(apiKey?: string): OpenAI {
    if (!apiKey && this.client) return this.client;
    let ctor: typeof OpenAI;
    try {
      const sdk = requireSDK("openai");
      ctor = sdk.default ?? sdk;
    } catch (cause) {
      throw new Error(SDK_REQUIRED, { cause });
    }
    const key = apiKey ?? this.config.apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OpenAI Decisions requires apiKey or OPENAI_API_KEY");
    const client = new ctor({ apiKey: key, baseURL: this.config.baseURL, maxRetries: 0 });
    if (typeof client.post !== "function") throw new Error(SDK_REQUIRED);
    if (!apiKey) this.client = client;
    return client;
  }

  async generate(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): Promise<ModelResponse> {
    options?.signal?.throwIfAborted();
    if (options?.tools?.length)
      throw new Error("OpenAI Decisions does not support tools; use choice questions for routing");
    if (options?.responseFormat)
      throw new Error("OpenAI Decisions does not support responseFormat or structuredOutput; supply questions");
    if (
      options?.reasoning ||
      options?.providerOptions ||
      options?.temperature !== undefined ||
      options?.maxTokens !== undefined ||
      options?.topP !== undefined ||
      options?.stop !== undefined
    )
      throw new Error("OpenAI Decisions does not support chat sampling, reasoning, or provider options");
    const questions = options?.questions;
    if (questions !== undefined && !Array.isArray(questions))
      throw new Error("OpenAI Decisions questions must be an ordered question array");
    return this.evaluate(buildDecisionInput(messages), {
      questions,
      signal: options?.signal,
      apiKey: options?.apiKey,
    });
  }

  /** Evaluate native messages, JSON, and historical tool activity in one request. */
  async evaluate(input: DecisionInputItem[], options?: OpenAIDecisionsEvaluateOptions): Promise<ModelResponse> {
    options?.signal?.throwIfAborted();
    const questions = parseDecisionQuestions(options?.questions ?? this.config.questions);
    const evidence = validateDecisionInput(input, questions);
    const cache = cacheSchema.safeParse({
      prompt_cache_key: options?.promptCacheKey ?? this.config.promptCacheKey,
      prompt_cache_options: options?.promptCacheOptions ?? this.config.promptCacheOptions,
    });
    if (!cache.success) throw new Error(`Invalid OpenAI Decisions cache options: ${cache.error.message}`);
    let raw: unknown;
    try {
      raw = await this.getClient(options?.apiKey).post<unknown>("/decisions", {
        body: {
          model: this.modelId,
          input: evidence,
          questions,
          ...cache.data,
          ...(this.config.safetyIdentifier !== undefined ? { safety_identifier: this.config.safetyIdentifier } : {}),
        },
        signal: options?.signal,
      });
    } catch (cause) {
      options?.signal?.throwIfAborted();
      throw cause;
    }
    const envelope = responseEnvelope.safeParse(raw);
    const usage = providerTokenUsage(
      this.providerId,
      "decisions",
      envelope.success ? envelope.data.usage : undefined,
      mergeResponseContext(
        {
          ...endpointBillingContext(this.providerId, this.config.baseURL),
          modelId: this.modelId,
          requestedModelId: this.modelId,
        },
        raw,
      ),
    );
    usage.pricingKey = `${this.providerId}/${this.modelId}`;
    let response;
    try {
      options?.signal?.throwIfAborted();
      response = parseDecisionResponse(raw, questions);
    } catch (cause) {
      throw new ModelUsageError(cause instanceof Error ? cause.message : "Invalid Decisions response", usage, cause);
    }
    return {
      message: { role: "assistant", content: JSON.stringify(response.answers) },
      decisions: response.answers,
      usage,
      finishReason: response.answers.every((answer) => answer.type === "refusal") ? "content_filter" : "stop",
      raw,
    };
  }

  async *stream(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): AsyncGenerator<StreamChunk> {
    const result = await this.generate(messages, options);
    yield { type: "text", text: JSON.stringify(result.decisions) };
    yield { type: "finish", finishReason: result.finishReason, usage: result.usage, decisions: result.decisions };
  }
}
