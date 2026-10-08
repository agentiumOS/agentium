import { createRequire } from "node:module";
import type OpenAI from "openai";
import type { DecisionInputMessage, DecisionInputPart } from "openai/resources/decisions";
import { type DecisionQuestion, parseDecisionQuestions, parseDecisionResponse } from "../decisions.js";
import type { ModelProvider } from "../provider.js";
import type { ChatMessage, ModelConfig, ModelResponse, StreamChunk, ToolDefinition } from "../types.js";

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
}

function buildInput(messages: ChatMessage[]): DecisionInputMessage[] {
  let images = 0;
  const input: DecisionInputMessage[] = [];
  for (const message of messages) {
    if (message.toolCalls?.length || message.role === "tool")
      throw new Error("OpenAI Decisions does not support tool calls or tool results");
    const parts: DecisionInputPart[] = [];
    if (typeof message.content === "string") {
      if (message.content) parts.push({ type: "input_text", text: message.content });
    } else {
      for (const part of message.content ?? []) {
        if (part.type === "text") parts.push({ type: "input_text", text: part.text });
        else if (part.type === "image") {
          const imageURL = part.data.startsWith("data:")
            ? part.data
            : `data:${part.mimeType ?? "image/png"};base64,${part.data}`;
          if (!/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(imageURL))
            throw new Error("OpenAI Decisions images must contain inline base64 data; external URLs are unsupported");
          if (++images > 128) throw new Error("OpenAI Decisions accepts at most 128 images");
          parts.push({ type: "input_image", image_url: imageURL });
        } else throw new Error(`OpenAI Decisions does not support ${part.type} input`);
      }
    }
    if (!parts.length) continue;
    // The endpoint only accepts user messages. Preserve role boundaries as text evidence.
    parts.unshift({ type: "input_text", text: `[${message.role}]` });
    input.push({ role: "user", content: parts });
  }
  if (!input.length) throw new Error("OpenAI Decisions requires text or image input");
  return input;
}

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
    if (typeof client.decisions?.create !== "function") throw new Error(SDK_REQUIRED);
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
    const questions = parseDecisionQuestions(options?.questions ?? this.config.questions);
    const input = buildInput(messages);
    const raw = await this.getClient(options?.apiKey).decisions.create(
      {
        model: this.modelId,
        input,
        questions,
        ...(this.config.safetyIdentifier !== undefined ? { safety_identifier: this.config.safetyIdentifier } : {}),
      },
      { signal: options?.signal },
    );
    options?.signal?.throwIfAborted();
    const response = parseDecisionResponse(raw, questions);
    return {
      message: { role: "assistant", content: JSON.stringify(response.answers) },
      decisions: response.answers,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.total_tokens,
        cachedTokens: response.usage.input_tokens_details.cached_tokens,
        reasoningTokens: response.usage.output_tokens_details.reasoning_tokens,
        providerMetrics: response.usage,
        pricingKey: `${this.providerId}/${this.modelId}`,
      },
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
