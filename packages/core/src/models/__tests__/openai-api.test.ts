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
