import {
  type ChatMessage,
  type ContentPart,
  getTextContent,
  isMultiModal,
  type ModelConfig,
  type ModelResponse,
  type StreamChunk,
  type TokenUsage,
  type ToolCall,
  type ToolDefinition,
} from "./types.js";

export type ChatMaxTokensField = "max_tokens" | "max_completion_tokens";

export interface ChatCompletionsExtra {
  stream?: boolean;
  /** OpenAI/Azure always use max_completion_tokens. Compatible APIs keep max_tokens unless the model is a reasoning family. */
  maxTokensField?: ChatMaxTokensField;
}

type GenerateOptions = ModelConfig & { tools?: ToolDefinition[] };

type RetryFn = <T>(fn: () => Promise<T>) => Promise<T>;

const identityRetry: RetryFn = async (fn) => fn();

/** Strip LiteLLM-style prefixes (`openai/gpt-5.6-terra` → `gpt-5.6-terra`). */
export function normalizeOpenAIModelId(modelId: string): string {
  const trimmed = modelId.trim();
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function parseGptVersion(modelId: string): { major: number; minor: number } | null {
  const id = normalizeOpenAIModelId(modelId).toLowerCase();
  const m = id.match(/^gpt-(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return { major: Number(m[1]), minor: m[2] ? Number(m[2]) : 0 };
}

/** o-series, GPT-5, and GPT-6 reject arbitrary temperature/top_p/stop. */
export function isOpenAIReasoningModel(modelId: string): boolean {
  const id = normalizeOpenAIModelId(modelId);
  return /^(o\d|gpt-5|gpt-6)/i.test(id);
}

/**
 * GPT-5.4+ and GPT-6 reject function tools on `/v1/chat/completions` unless
 * `reasoning_effort` is effectively `none`. GPT-5.6 defaults to medium when
 * the field is omitted, which is why agents 400 even with no reasoning config.
 */
export function chatCompletionsRejectsToolsWithReasoning(modelId: string): boolean {
  const v = parseGptVersion(modelId);
  if (!v) return false;
  if (v.major >= 6) return true;
  return v.major === 5 && v.minor >= 4;
}

/** GPT-6 requires `/v1/responses` for any tool calling. */
export function requiresResponsesForTools(modelId: string): boolean {
  const v = parseGptVersion(modelId);
  return v !== null && v.major >= 6;
}

function wantsReasoning(options?: ModelConfig): boolean {
  if (!options?.reasoning) return true;
  if (options.reasoning.enabled === false) return false;
  if (options.reasoning.effort === "none") return false;
  return true;
}

/**
 * Tools + reasoning (including GPT-5.6's omitted default) belong on Responses.
 * Chat Completions can only carry function tools with `reasoning_effort: "none"`.
 */
export function shouldUseResponsesApi(modelId: string, options?: GenerateOptions): boolean {
  if (!options?.tools?.length) return false;
  if (requiresResponsesForTools(modelId)) return true;
  return chatCompletionsRejectsToolsWithReasoning(modelId) && wantsReasoning(options);
}

export function isResponsesUnavailable(err: unknown): boolean {
  const e = err as { status?: number; statusCode?: number; message?: string; code?: string };
  const status = e?.status ?? e?.statusCode;
  const msg = String(e?.message ?? "");
  if (status === 404) return true;
  return /unknown request url|\/v1\/responses.*(404|not found|does not exist)|invalid.*responses endpoint/i.test(msg);
}

export function applyChatCompletionsParams(
  params: Record<string, unknown>,
  modelId: string,
  options?: GenerateOptions,
  extra?: ChatCompletionsExtra,
): void {
  const isReasoning = isOpenAIReasoningModel(modelId);
  const hasTools = Boolean(options?.tools?.length);
  const forceNone = hasTools && chatCompletionsRejectsToolsWithReasoning(modelId);

  if (forceNone) {
    params.reasoning_effort = "none";
  } else if (options?.reasoning?.enabled) {
    params.reasoning_effort = options.reasoning.effort ?? "medium";
  }

  const skipSampling = isReasoning || Boolean(options?.reasoning?.enabled);
  if (!skipSampling && options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }
  if (!skipSampling && options?.topP !== undefined) params.top_p = options.topP;
  if (!skipSampling && options?.stop) params.stop = options.stop;

  if (options?.maxTokens !== undefined) {
    const field = extra?.maxTokensField ?? (isReasoning ? "max_completion_tokens" : "max_tokens");
    params[field] = options.maxTokens;
  }

  applyChatResponseFormat(params, options);

  if (options?.tools?.length) {
    params.tools = toChatCompletionsTools(options.tools);
  }

  if (extra?.stream) {
    params.stream = true;
    params.stream_options = { include_usage: true };
  }
}

export function buildChatCompletionsParams(
  modelId: string,
  messages: ChatMessage[],
  options?: GenerateOptions,
  extra?: ChatCompletionsExtra,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    model: modelId,
    messages: toChatCompletionsMessages(messages),
  };
  applyChatCompletionsParams(params, modelId, options, extra);
  return params;
}

export function buildResponsesParams(
  modelId: string,
  messages: ChatMessage[],
  options?: GenerateOptions,
  extra?: { stream?: boolean },
): Record<string, unknown> {
  const { instructions, input } = toResponsesInput(messages);
  const params: Record<string, unknown> = {
    model: modelId,
    input,
    store: false,
  };
  if (instructions) params.instructions = instructions;

  const isReasoning = isOpenAIReasoningModel(modelId);
  if (!isReasoning && options?.temperature !== undefined) params.temperature = options.temperature;
  if (!isReasoning && options?.topP !== undefined) params.top_p = options.topP;

  if (options?.maxTokens !== undefined) params.max_output_tokens = options.maxTokens;

  if (options?.reasoning?.enabled && options.reasoning.effort && options.reasoning.effort !== "none") {
    params.reasoning = { effort: options.reasoning.effort };
  }

  applyResponsesTextFormat(params, options);

  if (options?.tools?.length) params.tools = toResponsesTools(options.tools);
  if (extra?.stream) params.stream = true;

  return params;
}

export async function generateOpenAIStyle(
  client: {
    chat?: { completions?: { create: (params: unknown) => Promise<unknown> } };
    responses?: { create?: (params: unknown) => Promise<unknown> };
  },
  modelId: string,
  messages: ChatMessage[],
  options?: GenerateOptions,
  withRetry: RetryFn = identityRetry,
  extra?: ChatCompletionsExtra,
): Promise<ModelResponse> {
  if (shouldUseResponsesApi(modelId, options) && typeof client.responses?.create === "function") {
    const create = client.responses.create.bind(client.responses);
    try {
      const response = await withRetry(() => create(buildResponsesParams(modelId, messages, options)));
      return normalizeResponsesResponse(response);
    } catch (err) {
      if (!isResponsesUnavailable(err)) throw err;
    }
  }

  const params = buildChatCompletionsParams(modelId, messages, options, extra);
  const response = await withRetry(() => client.chat!.completions!.create(params));
  return normalizeChatCompletionsResponse(response);
}

export async function* streamOpenAIStyle(
  client: {
    chat?: { completions?: { create: (params: unknown) => Promise<unknown> } };
    responses?: { create?: (params: unknown) => Promise<unknown> };
  },
  modelId: string,
  messages: ChatMessage[],
  options?: GenerateOptions,
  withRetry: RetryFn = identityRetry,
  extra?: ChatCompletionsExtra,
): AsyncGenerator<StreamChunk> {
  if (shouldUseResponsesApi(modelId, options) && typeof client.responses?.create === "function") {
    const create = client.responses.create.bind(client.responses);
    try {
      const stream = await withRetry(() => create(buildResponsesParams(modelId, messages, options, { stream: true })));
      yield* iterResponsesStream(stream as AsyncIterable<unknown>);
      return;
    } catch (err) {
      if (!isResponsesUnavailable(err)) throw err;
    }
  }

  const params = buildChatCompletionsParams(modelId, messages, options, { ...extra, stream: true });
  const stream = await withRetry(() => client.chat!.completions!.create(params));
  yield* iterChatCompletionStream(stream as AsyncIterable<unknown>);
}

export function toChatCompletionsMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((msg) => {
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      return {
        role: "assistant",
        content: getTextContent(msg.content),
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        })),
      };
    }

    if (msg.role === "tool") {
      return {
        role: "tool",
        tool_call_id: msg.toolCallId,
        content: getTextContent(msg.content),
      };
    }

    if (isMultiModal(msg.content)) {
      return {
        role: msg.role,
        content: msg.content.map((part) => partToChatCompletions(part)),
      };
    }

    return {
      role: msg.role,
      content: msg.content ?? "",
    };
  });
}

export function toChatCompletionsTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      ...(t.strict ? { strict: true } : {}),
    },
  }));
}

function partToChatCompletions(part: ContentPart): unknown {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image": {
      const isUrl = part.data.startsWith("http://") || part.data.startsWith("https://");
      return {
        type: "image_url",
        image_url: {
          url: isUrl ? part.data : `data:${part.mimeType ?? "image/png"};base64,${part.data}`,
        },
      };
    }
    case "audio":
      return {
        type: "input_audio",
        input_audio: {
          data: part.data,
          format: part.mimeType?.split("/")[1] ?? "mp3",
        },
      };
    case "file": {
      const isFileUrl = part.data.startsWith("http://") || part.data.startsWith("https://");
      return {
        type: "file",
        file: {
          filename: part.filename ?? "attachment",
          file_data: isFileUrl ? part.data : `data:${part.mimeType};base64,${part.data}`,
        },
      };
    }
  }
}

function applyChatResponseFormat(params: Record<string, unknown>, options?: ModelConfig): void {
  if (!options?.responseFormat) return;
  if (options.responseFormat === "json") {
    params.response_format = { type: "json_object" };
  } else if (options.responseFormat === "text") {
    // default
  } else if (typeof options.responseFormat === "object") {
    params.response_format = {
      type: "json_schema",
      json_schema: {
        name: options.responseFormat.name ?? "response",
        schema: options.responseFormat.schema,
        strict: true,
      },
    };
  }
}

function applyResponsesTextFormat(params: Record<string, unknown>, options?: ModelConfig): void {
  if (!options?.responseFormat) return;
  if (options.responseFormat === "json") {
    params.text = { format: { type: "json_object" } };
  } else if (typeof options.responseFormat === "object") {
    params.text = {
      format: {
        type: "json_schema",
        name: options.responseFormat.name ?? "response",
        schema: options.responseFormat.schema,
        strict: true,
      },
    };
  }
}

export function toResponsesTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    ...(t.strict ? { strict: true } : {}),
  }));
}

export function toResponsesInput(messages: ChatMessage[]): { instructions?: string; input: unknown[] } {
  let instructions: string | undefined;
  const input: unknown[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      const text = getTextContent(msg.content);
      instructions = instructions ? `${instructions}\n\n${text}` : text;
      continue;
    }

    if (msg.role === "assistant" && msg.toolCalls?.length) {
      const text = getTextContent(msg.content);
      if (text) input.push({ role: "assistant", content: text });
      for (const tc of msg.toolCalls) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.name,
          arguments: JSON.stringify(tc.arguments ?? {}),
        });
      }
      continue;
    }

    if (msg.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: msg.toolCallId,
        output: getTextContent(msg.content),
      });
      continue;
    }

    if (isMultiModal(msg.content)) {
      input.push({
        role: msg.role,
        content: msg.content.map((part) => partToResponsesContent(part)),
      });
      continue;
    }

    input.push({ role: msg.role, content: msg.content ?? "" });
  }

  return { instructions, input };
}

function partToResponsesContent(part: ContentPart): unknown {
  switch (part.type) {
    case "text":
      return { type: "input_text", text: part.text };
    case "image": {
      const isUrl = part.data.startsWith("http://") || part.data.startsWith("https://");
      return {
        type: "input_image",
        image_url: isUrl ? part.data : `data:${part.mimeType ?? "image/png"};base64,${part.data}`,
      };
    }
    case "audio":
      return { type: "input_text", text: "[audio]" };
    case "file": {
      const isFileUrl = part.data.startsWith("http://") || part.data.startsWith("https://");
      return {
        type: "input_file",
        filename: part.filename ?? "attachment",
        file_data: isFileUrl ? part.data : `data:${part.mimeType};base64,${part.data}`,
      };
    }
  }
}

export function normalizeChatCompletionsResponse(response: any): ModelResponse & { thinking?: string } {
  const choice = response.choices[0];
  const msg = choice.message;

  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc: any) => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.function.arguments || "{}");
    } catch (err) {
      console.warn("[agentium] Error:", err instanceof Error ? err.message : err);
    }
    return {
      id: tc.id,
      name: tc.function.name,
      arguments: args,
    };
  });

  const usage = usageFromChatCompletions(response.usage);

  let finishReason: ModelResponse["finishReason"] = "stop";
  if (choice.finish_reason === "tool_calls") finishReason = "tool_calls";
  else if (choice.finish_reason === "length") finishReason = "length";
  else if (choice.finish_reason === "content_filter") finishReason = "content_filter";

  const result: ModelResponse & { thinking?: string } = {
    message: {
      role: "assistant",
      content: msg.content ?? null,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    },
    usage,
    finishReason,
    raw: response,
  };

  if (msg.reasoning_content) result.thinking = msg.reasoning_content;
  return result;
}

export function normalizeResponsesResponse(response: any): ModelResponse & { thinking?: string } {
  const { text, toolCalls, thinking } = extractResponsesOutput(response);
  const usage = usageFromResponses(response.usage);

  const result: ModelResponse & { thinking?: string } = {
    message: {
      role: "assistant",
      content: text.length > 0 ? text : response.output_text || null,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    },
    usage,
    finishReason: toolCalls.length > 0 ? "tool_calls" : responsesStatusToFinish(response?.status),
    raw: response,
  };
  if (thinking) result.thinking = thinking;
  return result;
}

function extractResponsesOutput(response: any): { text: string; toolCalls: ToolCall[]; thinking: string } {
  let text = "";
  let thinking = "";
  const toolCalls: ToolCall[] = [];

  for (const item of response?.output ?? []) {
    if (item?.type === "function_call") {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(item.arguments || "{}");
      } catch (err) {
        console.warn("[agentium] Error:", err instanceof Error ? err.message : err);
      }
      toolCalls.push({
        id: item.call_id ?? item.id,
        name: item.name,
        arguments: args,
      });
      continue;
    }
    if (item?.type === "message") {
      for (const part of item.content ?? []) {
        if (part?.type === "output_text" || part?.type === "text") text += part.text ?? "";
      }
      continue;
    }
    if (item?.type === "reasoning") {
      const summary = item.summary;
      if (Array.isArray(summary)) {
        thinking += summary.map((s: any) => s.text ?? "").join("");
      } else if (typeof item.content === "string") {
        thinking += item.content;
      }
    }
  }

  if (!text && typeof response?.output_text === "string") text = response.output_text;
  return { text, toolCalls, thinking };
}

function responsesStatusToFinish(status: unknown): ModelResponse["finishReason"] {
  if (status === "incomplete") return "length";
  return "stop";
}

function usageFromChatCompletions(usage: any): TokenUsage {
  const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const audioInputTokens = usage?.prompt_tokens_details?.audio_tokens ?? 0;
  const audioOutputTokens = usage?.completion_tokens_details?.audio_tokens ?? 0;
  return {
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    totalTokens: usage?.total_tokens ?? 0,
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    ...(cachedTokens > 0 ? { cachedTokens } : {}),
    ...(audioInputTokens > 0 ? { audioInputTokens } : {}),
    ...(audioOutputTokens > 0 ? { audioOutputTokens } : {}),
    providerMetrics: usage ? { ...usage } : undefined,
  };
}

function usageFromResponses(usage: any): TokenUsage {
  const reasoningTokens = usage?.output_tokens_details?.reasoning_tokens ?? 0;
  const cachedTokens = usage?.input_tokens_details?.cached_tokens ?? 0;
  return {
    promptTokens: usage?.input_tokens ?? 0,
    completionTokens: usage?.output_tokens ?? 0,
    totalTokens: usage?.total_tokens ?? 0,
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    ...(cachedTokens > 0 ? { cachedTokens } : {}),
    providerMetrics: usage ? { ...usage } : undefined,
  };
}

export async function* iterChatCompletionStream(stream: AsyncIterable<any>): AsyncGenerator<StreamChunk> {
  const activeToolCalls = new Map<number, { id: string; name: string; args: string }>();
  let finishReason: string | null = null;

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    if (!choice) {
      if (chunk.usage && finishReason) {
        yield {
          type: "finish",
          finishReason: finishReason === "tool_calls" ? "tool_calls" : finishReason,
          usage: usageFromChatCompletions(chunk.usage),
        };
      }
      continue;
    }

    const delta = choice.delta;

    if (delta?.content) {
      yield { type: "text", text: delta.content };
    }

    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;

        if (tc.id) {
          activeToolCalls.set(idx, {
            id: tc.id,
            name: tc.function?.name ?? "",
            args: tc.function?.arguments ?? "",
          });
          yield {
            type: "tool_call_start",
            toolCall: {
              id: tc.id,
              name: tc.function?.name ?? "",
            },
          };
        } else if (tc.function?.arguments) {
          const existing = activeToolCalls.get(idx);
          if (existing) {
            existing.args += tc.function.arguments;
            yield {
              type: "tool_call_delta",
              toolCallId: existing.id,
              argumentsDelta: tc.function.arguments,
            };
          }
        }

        if (tc.function?.name && !tc.id) {
          const existing = activeToolCalls.get(idx);
          if (existing) existing.name = tc.function.name;
        }
      }
    }

    if (delta?.reasoning_content) {
      yield { type: "thinking", text: delta.reasoning_content };
    }

    if (choice.finish_reason) {
      for (const [, tc] of activeToolCalls) {
        yield { type: "tool_call_end", toolCallId: tc.id };
      }
      const reason: string = choice.finish_reason;
      finishReason = reason;

      if (chunk.usage) {
        yield {
          type: "finish",
          finishReason: reason === "tool_calls" ? "tool_calls" : reason,
          usage: usageFromChatCompletions(chunk.usage),
        };
        finishReason = null;
      }
    }
  }

  if (finishReason) {
    yield { type: "finish" as const, finishReason, usage: undefined };
  }
}

export async function* iterResponsesStream(stream: AsyncIterable<any>): AsyncGenerator<StreamChunk> {
  const itemToCall = new Map<string, { callId: string; name: string }>();
  let emittedFinish = false;

  for await (const event of stream) {
    const type = event?.type as string | undefined;
    if (!type) continue;

    if (type === "response.output_text.delta" && event.delta) {
      yield { type: "text", text: event.delta };
      continue;
    }

    if ((type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") && event.delta) {
      yield { type: "thinking", text: event.delta };
      continue;
    }

    if (type === "response.output_item.added" && event.item?.type === "function_call") {
      const callId = event.item.call_id ?? event.item.id;
      const name = event.item.name ?? "";
      if (event.item.id) itemToCall.set(event.item.id, { callId, name });
      if (callId) yield { type: "tool_call_start", toolCall: { id: callId, name } };
      continue;
    }

    if (type === "response.function_call_arguments.delta" && event.delta) {
      const mapped = event.item_id ? itemToCall.get(event.item_id) : undefined;
      const callId = mapped?.callId ?? event.item_id;
      if (callId) yield { type: "tool_call_delta", toolCallId: callId, argumentsDelta: event.delta };
      continue;
    }

    if (type === "response.output_item.done" && event.item?.type === "function_call") {
      const callId = event.item.call_id ?? event.item.id;
      if (callId) yield { type: "tool_call_end", toolCallId: callId };
      continue;
    }

    if (type === "response.completed") {
      const response = event.response ?? event;
      const { toolCalls } = extractResponsesOutput(response);
      yield {
        type: "finish",
        finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
        usage: usageFromResponses(response?.usage),
      };
      emittedFinish = true;
    }
  }

  if (!emittedFinish) {
    yield { type: "finish" as const, finishReason: "stop", usage: undefined };
  }
}
