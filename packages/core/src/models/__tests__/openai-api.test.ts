import { describe, expect, it } from "vitest";
import {
  applyChatCompletionsParams,
  buildResponsesParams,
  chatCompletionsRejectsToolsWithReasoning,
  isOpenAIReasoningModel,
  normalizeOpenAIModelId,
  requiresResponsesForTools,
  shouldUseResponsesApi,
  toChatCompletionsMessages,
  toResponsesInput,
  toResponsesTools,
} from "../openai-api.js";
import {
  applyAnthropicThinking,
  applyGoogleRequestExtras,
  applyGoogleThinkingConfig,
  extrasFromGoogleParts,
} from "../thinking-replay.js";
import type { StreamChunk } from "../types.js";

describe("OpenAI model routing", () => {
  it("strips LiteLLM-style provider prefixes", () => {
    expect(normalizeOpenAIModelId("openai/gpt-5.6-terra")).toBe("gpt-5.6-terra");
    expect(normalizeOpenAIModelId("azure/gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });

  it("detects reasoning families", () => {
    expect(isOpenAIReasoningModel("o3-mini")).toBe(true);
    expect(isOpenAIReasoningModel("gpt-5-mini")).toBe(true);
    expect(isOpenAIReasoningModel("gpt-5.6-terra")).toBe(true);
    expect(isOpenAIReasoningModel("gpt-6-astra")).toBe(true);
    expect(isOpenAIReasoningModel("gpt-4o")).toBe(false);
  });

  it("flags GPT-5.4+ and GPT-6 as rejecting tools with reasoning on Chat Completions", () => {
    expect(chatCompletionsRejectsToolsWithReasoning("gpt-5")).toBe(false);
    expect(chatCompletionsRejectsToolsWithReasoning("gpt-5-mini")).toBe(false);
    expect(chatCompletionsRejectsToolsWithReasoning("gpt-5.2")).toBe(false);
    expect(chatCompletionsRejectsToolsWithReasoning("gpt-5.4")).toBe(true);
    expect(chatCompletionsRejectsToolsWithReasoning("gpt-5.6-terra")).toBe(true);
    expect(chatCompletionsRejectsToolsWithReasoning("openai/gpt-5.6-luna")).toBe(true);
    expect(chatCompletionsRejectsToolsWithReasoning("gpt-6-astra")).toBe(true);
    expect(chatCompletionsRejectsToolsWithReasoning("gpt-4o")).toBe(false);
  });

  it("requires Responses for GPT-6 tool calling", () => {
    expect(requiresResponsesForTools("gpt-6-astra")).toBe(true);
    expect(requiresResponsesForTools("gpt-5.6-terra")).toBe(false);
  });

  it("routes tools + GPT-5.6 to Responses unless reasoning is none", () => {
    const tools = [{ name: "t", description: "t", parameters: { type: "object" } }];
    expect(shouldUseResponsesApi("gpt-5.6-terra", { tools })).toBe(true);
    expect(shouldUseResponsesApi("gpt-5.6-terra", { tools, reasoning: { enabled: true, effort: "high" } })).toBe(true);
    expect(shouldUseResponsesApi("gpt-5.6-terra", { tools, reasoning: { enabled: true, effort: "none" } })).toBe(false);
    expect(shouldUseResponsesApi("gpt-5.6-terra", { tools, reasoning: { enabled: false } })).toBe(false);
    expect(shouldUseResponsesApi("gpt-5.6-terra", { reasoning: { enabled: true, effort: "high" } })).toBe(false);
    expect(shouldUseResponsesApi("gpt-4o", { tools })).toBe(false);
    expect(shouldUseResponsesApi("gpt-6-astra", { tools, reasoning: { enabled: true, effort: "none" } })).toBe(true);
  });
});

describe("Chat Completions params", () => {
  it("forces reasoning_effort none when tools would 400 on Chat Completions", () => {
    const params: Record<string, unknown> = {};
    applyChatCompletionsParams(params, "gpt-5.6-terra", {
      tools: [{ name: "t", description: "t", parameters: { type: "object" } }],
      temperature: 0,
    });
    expect(params.reasoning_effort).toBe("none");
    expect(params.temperature).toBeUndefined();
    expect((params.tools as any)[0].function.name).toBe("t");
  });
});

describe("Responses conversion", () => {
  it("maps tools to the flat Responses shape", () => {
    const tools = toResponsesTools([{ name: "get_weather", description: "w", parameters: { type: "object" } }]);
    expect(tools[0]).toEqual({
      type: "function",
      name: "get_weather",
      description: "w",
      parameters: { type: "object" },
    });
  });

  it("lifts system messages to instructions and tool results to function_call_output", () => {
    const { instructions, input } = toResponsesInput([
      { role: "system", content: "Be brief." },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "call_1", name: "lookup", arguments: { q: "x" } }],
      },
      { role: "tool", toolCallId: "call_1", content: "ok" },
    ]);
    expect(instructions).toBe("Be brief.");
    expect(input).toEqual([
      { role: "user", content: "hi" },
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"q":"x"}' },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ]);
  });

  it("does not set store by default so agent transcripts stay local", () => {
    const params = buildResponsesParams("gpt-5.6-terra", [{ role: "user", content: "hi" }], {
      tools: [{ name: "t", description: "t", parameters: { type: "object" } }],
    });
    expect(params.store).toBe(false);
  });

  it("asks OpenAI for a detailed reasoning summary so thinking text comes back", () => {
    const params = buildResponsesParams("gpt-5.6-terra", [{ role: "user", content: "hi" }], {
      tools: [{ name: "t", description: "t", parameters: { type: "object" } }],
      reasoning: { enabled: true, effort: "medium", mode: "pro" },
      providerOptions: { promptCacheRetention: "24h" },
    });
    expect(params.reasoning).toEqual({ effort: "medium", summary: "detailed", mode: "pro" });
    expect(params.prompt_cache_retention).toBe("24h");
  });

  it("replays a Responses reasoning item ahead of the next tool call", () => {
    const reasoning = [{ type: "reasoning", id: "rs_1", summary: [] }];
    const { input } = toResponsesInput([
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "call_1", name: "lookup", arguments: { q: "x" } }],
        providerExtras: { responsesReasoning: reasoning },
      },
    ]);
    expect(input[0]).toEqual(reasoning[0]);
    expect(input[1]).toMatchObject({ type: "function_call", call_id: "call_1" });
  });

  it("maps DeepSeek effort and replays reasoning_content", () => {
    const params: Record<string, unknown> = {};
    applyChatCompletionsParams(params, "deepseek-v4-pro", {
      reasoning: { enabled: true, effort: "medium" },
    });
    expect(params.thinking).toEqual({ type: "enabled" });
    expect(params.reasoning_effort).toBe("high");

    const messages = toChatCompletionsMessages([
      {
        role: "assistant",
        content: "ok",
        providerExtras: { reasoningContent: "step 1" },
      },
    ]);
    expect(messages[0]).toMatchObject({ reasoning_content: "step 1" });
  });
});

describe("Gemini / Vertex thinking", () => {
  it("uses thinkingBudget + includeThoughts on Gemini 2.5", () => {
    const config: Record<string, unknown> = {};
    applyGoogleThinkingConfig(config, "gemini-2.5-pro", {
      reasoning: { enabled: true, budgetTokens: 2048 },
    });
    expect(config.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 2048 });
  });

  it("uses thinkingLevel on Gemini 3", () => {
    const config: Record<string, unknown> = {};
    applyGoogleThinkingConfig(config, "gemini-3.1-pro", {
      reasoning: { enabled: true, effort: "high" },
    });
    expect(config.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });
  });

  it("uses adaptive thinking and a summarized display on Claude 4.6+", () => {
    const params: Record<string, unknown> = { max_tokens: 4096, system: "Be brief.", temperature: 0 };
    const headers = applyAnthropicThinking(params, "claude-opus-4-6", {
      reasoning: { enabled: true, effort: "high" },
      providerOptions: { promptCache: true, clearToolResults: true, compactionTokens: 1000 },
    });
    expect(params.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(params.output_config).toEqual({ effort: "high" });
    expect(params.temperature).toBeUndefined();
    expect(params.system).toEqual([{ type: "text", text: "Be brief.", cache_control: { type: "ephemeral" } }]);
    expect(params.context_management).toEqual({
      edits: [
        { type: "clear_tool_uses_20250919" },
        { type: "compact_20260112", trigger: { type: "input_tokens", value: 50000 } },
      ],
    });
    expect(headers).toEqual({
      "anthropic-beta": "context-management-2025-06-27,compact-2026-01-12",
    });
  });

  it("drops sampling params and adds Search on Gemini 3.8", () => {
    const config: Record<string, unknown> = { temperature: 0, topP: 1, tools: [{ functionDeclarations: [] }] };
    applyGoogleRequestExtras(config, "gemini-3.8-flash", {
      providerOptions: { mediaResolution: "low", cachedContent: "cachedContents/abc", googleSearch: true },
    });
    expect(config.temperature).toBeUndefined();
    expect(config.topP).toBeUndefined();
    expect(config.mediaResolution).toBe("MEDIA_RESOLUTION_LOW");
    expect(config.cachedContent).toBe("cachedContents/abc");
    expect(config.tools).toEqual([{ functionDeclarations: [] }, { googleSearch: {} }]);
  });

  it("stores googleParts when a functionCall carries a thought signature", () => {
    const parts = [{ functionCall: { name: "lookup", args: { q: 1 } }, thoughtSignature: "sig_1" }];
    expect(extrasFromGoogleParts(parts)).toEqual({ googleParts: parts });
  });
});

describe("Responses ordered continuation and stream commitment", () => {
  const output = [
    { type: "reasoning", id: "r1", summary: [], encrypted_content: "opaque" },
    { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "looking" }] },
    { type: "function_call", id: "fc1", call_id: "c1", name: "lookup", arguments: '{"q":"x"}' },
    { type: "reasoning", id: "r2", summary: [] },
  ];
  const events = async function* (items: unknown[]) {
    yield* items;
  };

  it("replays exact ordered output after JSON persistence without duplicating calls", async () => {
    const { normalizeResponsesResponse } = await import("../openai-api.js");
    const response = normalizeResponsesResponse({ output });
    const message = JSON.parse(JSON.stringify(response.message));
    expect(toResponsesInput([message, { role: "tool", toolCallId: "c1", content: "found" }]).input).toEqual([
      ...output,
      { type: "function_call_output", call_id: "c1", output: "found" },
    ]);
  });

  it("keeps non-tool reasoning and rejects another endpoint before making a request", async () => {
    const { normalizeResponsesResponse, generateOpenAIStyle } = await import("../openai-api.js");
    const { vi } = await import("vitest");
    const message = normalizeResponsesResponse({ output: output.slice(0, 2) }).message;
    expect(toResponsesInput([message]).input).toEqual(output.slice(0, 2));
    const create = vi.fn();
    await expect(
      generateOpenAIStyle({ baseURL: "https://other.example/v1", responses: { create } }, "gpt-5.6", [message]),
    ).rejects.toThrow("ownership");
    expect(create).not.toHaveBeenCalled();
  });

  it("continues through Responses even after tools are removed and rejects unavailable continuation", async () => {
    const { normalizeResponsesResponse, generateOpenAIStyle } = await import("../openai-api.js");
    const { vi } = await import("vitest");
    const message = normalizeResponsesResponse({ output: output.slice(0, 2) }).message;
    const create = vi.fn().mockResolvedValue({ output: output.slice(0, 2) });
    await generateOpenAIStyle({ responses: { create } }, "gpt-5.6", [message]);
    expect(create.mock.calls[0][0].input).toEqual(output.slice(0, 2));
    await expect(generateOpenAIStyle({ chat: { completions: { create } } }, "gpt-5.6", [message])).rejects.toThrow(
      "Responses-capable",
    );
  });

  it("retains a custom endpoint identity without credentials or query secrets", async () => {
    const { generateOpenAIStyle } = await import("../openai-api.js");
    const response = await generateOpenAIStyle(
      {
        baseURL: "https://user:secret@gateway.example/v1/?token=secret",
        responses: { create: async () => ({ output }) },
      },
      "gpt-6",
      [],
      { tools: [{ name: "lookup", description: "", parameters: {} }] },
    );
    expect(response.message.providerExtras?.responsesReplay).toMatchObject({ owner: "https://gateway.example/v1" });
    expect(toResponsesInput([response.message], "https://gateway.example/v1").input).toEqual(output);
    expect(() =>
      toResponsesInput(
        [{ role: "assistant", content: null, providerExtras: { responsesReasoning: [output[0]] } }],
        "https://gateway.example/v1",
      ),
    ).toThrow("Unowned");
  });

  it("emits complete replay on stream finish and errors on incomplete streams", async () => {
    const { iterResponsesStream } = await import("../openai-api.js");
    const chunks: StreamChunk[] = [];
    for await (const chunk of iterResponsesStream(events([{ type: "response.completed", response: { output } }])))
      chunks.push(chunk);
    expect(chunks[0]).toMatchObject({
      type: "finish",
      providerExtras: { responsesReplay: { version: 1, items: output } },
    });
    await expect(async () => {
      for await (const _chunk of iterResponsesStream(events([]))) {
        /* consume */
      }
    }).rejects.toThrow("before response.completed");
  });

  it("does not switch APIs when an unavailable-endpoint error follows visible output", async () => {
    const { streamOpenAIStyle } = await import("../openai-api.js");
    const { vi } = await import("vitest");
    const chat = vi.fn();
    const broken = async function* () {
      yield { type: "response.output_text.delta", delta: "partial" };
      throw Object.assign(new Error("not found"), { status: 404 });
    };
    const chunks: StreamChunk[] = [];
    await expect(async () => {
      for await (const chunk of streamOpenAIStyle(
        { responses: { create: async () => broken() }, chat: { completions: { create: chat } } },
        "gpt-6",
        [],
        { tools: [{ name: "t", description: "", parameters: {} }] },
      ))
        chunks.push(chunk);
    }).rejects.toThrow("not found");
    expect(chunks).toEqual([{ type: "text", text: "partial" }]);
    expect(chat).not.toHaveBeenCalled();
  });

  it("preserves initial and interleaved argument fragments and terminal usage exactly once", async () => {
    const { iterChatCompletionStream } = await import("../openai-api.js");
    const chunks: StreamChunk[] = [];
    for await (const chunk of iterChatCompletionStream(
      events([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "a", function: { name: "one", arguments: '{"x":' } },
                  { index: 1, id: "b", function: { name: "two", arguments: '{"y":2}' } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: "tool_calls" },
          ],
        },
        { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
      ]),
    ))
      chunks.push(chunk);
    expect(chunks.filter((c) => c.type === "tool_call_delta")).toEqual([
      { type: "tool_call_delta", toolCallId: "a", argumentsDelta: '{"x":' },
      { type: "tool_call_delta", toolCallId: "b", argumentsDelta: '{"y":2}' },
      { type: "tool_call_delta", toolCallId: "a", argumentsDelta: "1}" },
    ]);
    expect(chunks.filter((c) => c.type === "finish")).toHaveLength(1);
    expect(chunks.at(-1)).toMatchObject({ usage: { totalTokens: 3 } });
  });
});

it("rejects foreign Responses continuation before changing models or replay families", async () => {
  const { normalizeResponsesResponse, generateOpenAIStyle } = await import("../openai-api.js");
  const { anthropicReplayContent, googleReplayParts } = await import("../thinking-replay.js");
  const { vi } = await import("vitest");
  const message = normalizeResponsesResponse(
    { output: [{ type: "reasoning", id: "r", summary: [], encrypted_content: "secret" }] },
    "https://api.openai.com/v1",
    "original-model",
  ).message;
  const create = vi.fn();
  await expect(generateOpenAIStyle({ responses: { create } }, "different-model", [message])).rejects.toThrow(
    "ownership",
  );
  expect(create).not.toHaveBeenCalled();
  expect(() => anthropicReplayContent(message)).toThrow("Foreign provider");
  expect(() => googleReplayParts(message)).toThrow("Foreign provider");
  expect(() => toChatCompletionsMessages([message])).toThrow("cannot be converted");
});

describe("provider tool argument integrity", () => {
  it.each(["{", "", "null", "[]", '"text"'])("rejects malformed or non-object tool arguments %s", async (args) => {
    const { normalizeChatCompletionsResponse, normalizeResponsesResponse } = await import("../openai-api.js");
    expect(() =>
      normalizeChatCompletionsResponse({
        choices: [
          {
            message: {
              tool_calls: [{ id: "call", function: { name: "effect", arguments: args } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    ).toThrow(/Invalid provider tool arguments/);
    expect(() =>
      normalizeResponsesResponse({
        status: "completed",
        output: [{ type: "function_call", call_id: "call", name: "effect", arguments: args }],
      }),
    ).toThrow(/Invalid provider tool arguments/);
  });

  it.each(["anthropicContent", "googleParts"])("rejects foreign continuation %s on Chat Completions", (field) => {
    expect(() =>
      toChatCompletionsMessages([{ role: "assistant", content: "thinking", providerExtras: { [field]: [] } }]),
    ).toThrow(/Foreign provider continuation/);
  });

  it.each(["length", undefined])("rejects unfinished streaming tool calls (%s)", async (finish_reason) => {
    const { iterChatCompletionStream } = await import("../openai-api.js");
    const observed: StreamChunk[] = [];
    async function consume() {
      for await (const chunk of iterChatCompletionStream(
        (async function* () {
          yield {
            choices: [
              {
                delta: { tool_calls: [{ id: "call", index: 0, function: { name: "effect", arguments: "{}" } }] },
                finish_reason,
              },
            ],
          };
        })(),
      ))
        observed.push(chunk);
    }
    await expect(consume()).rejects.toThrow(/Incomplete|completion marker/);
    expect(observed.some((chunk) => chunk.type === "tool_call_end")).toBe(false);
  });

  it("never completes a streaming call with malformed arguments", async () => {
    const { iterChatCompletionStream } = await import("../openai-api.js");
    const observed: StreamChunk[] = [];
    await expect(
      (async () => {
        for await (const chunk of iterChatCompletionStream(
          (async function* () {
            yield {
              choices: [
                {
                  delta: { tool_calls: [{ id: "call", index: 0, function: { name: "effect", arguments: "{" } }] },
                  finish_reason: "tool_calls",
                },
              ],
            };
          })(),
        ))
          observed.push(chunk);
      })(),
    ).rejects.toThrow(/Invalid provider tool arguments/);
    expect(observed.some((chunk) => chunk.type === "tool_call_end")).toBe(false);
  });
});
