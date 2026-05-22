import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// OpenAI Provider Tests
// ---------------------------------------------------------------------------

describe("OpenAIProvider", () => {
  const origKey = process.env.OPENAI_API_KEY;
  let OpenAIProvider: any;
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    process.env.OPENAI_API_KEY = "test-key-123";
    mockCreate = vi.fn();

    const mod = await import("../providers/openai.js");
    OpenAIProvider = mod.OpenAIProvider;
  });

  afterEach(() => {
    if (origKey) process.env.OPENAI_API_KEY = origKey;
    else delete process.env.OPENAI_API_KEY;
  });

  function makeProvider(modelId = "gpt-4o") {
    const provider = new OpenAIProvider(modelId);
    (provider as any).client = { chat: { completions: { create: mockCreate } } };
    return provider;
  }

  describe("withRetry", () => {
    it("retries on 429 (rate limit) and eventually succeeds", async () => {
      const rateLimitError = Object.assign(new Error("rate limited"), { status: 429 });
      const successResponse = {
        choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      };

      mockCreate.mockRejectedValueOnce(rateLimitError).mockResolvedValueOnce(successResponse);

      const provider = makeProvider();
      const result = await provider.generate([{ role: "user", content: "hello" }]);
      expect(result.message.content).toBe("ok");
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it("retries on 500 server errors", async () => {
      const serverError = Object.assign(new Error("internal"), { status: 500 });
      const successResponse = {
        choices: [{ message: { content: "recovered", tool_calls: [] }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      };

      mockCreate.mockRejectedValueOnce(serverError).mockResolvedValueOnce(successResponse);

      const provider = makeProvider();
      const result = await provider.generate([{ role: "user", content: "test" }]);
      expect(result.message.content).toBe("recovered");
    });

    it("retries on 502 and 503 errors", async () => {
      const error502 = Object.assign(new Error("bad gateway"), { status: 502 });
      const successResponse = {
        choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      };

      mockCreate.mockRejectedValueOnce(error502).mockResolvedValueOnce(successResponse);

      const provider = makeProvider();
      const result = await provider.generate([{ role: "user", content: "test" }]);
      expect(result.message.content).toBe("ok");
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it("retries on ECONNRESET", async () => {
      const connError = Object.assign(new Error("reset"), { code: "ECONNRESET" });
      const successResponse = {
        choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      };

      mockCreate.mockRejectedValueOnce(connError).mockResolvedValueOnce(successResponse);

      const provider = makeProvider();
      const result = await provider.generate([{ role: "user", content: "test" }]);
      expect(result.message.content).toBe("ok");
    });

    it("retries on 'rate limit' message substring", async () => {
      const rateLimitMsg = new Error("you hit the rate limit, slow down");
      const successResponse = {
        choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      };

      mockCreate.mockRejectedValueOnce(rateLimitMsg).mockResolvedValueOnce(successResponse);

      const provider = makeProvider();
      const result = await provider.generate([{ role: "user", content: "test" }]);
      expect(result.message.content).toBe("ok");
    });

    it("does not retry on 400 (client error)", async () => {
      const clientError = Object.assign(new Error("bad request"), { status: 400 });
      mockCreate.mockRejectedValue(clientError);

      const provider = makeProvider();
      await expect(provider.generate([{ role: "user", content: "bad" }])).rejects.toThrow("bad request");
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it("does not retry on 401 (auth error)", async () => {
      const authError = Object.assign(new Error("unauthorized"), { status: 401 });
      mockCreate.mockRejectedValue(authError);

      const provider = makeProvider();
      await expect(provider.generate([{ role: "user", content: "test" }])).rejects.toThrow("unauthorized");
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it("exhausts retries then throws", async () => {
      const rateLimitError = Object.assign(new Error("rate limited"), { status: 429 });
      mockCreate.mockRejectedValue(rateLimitError);

      const provider = makeProvider();
      await expect(provider.generate([{ role: "user", content: "overloaded" }])).rejects.toThrow("rate limited");
      expect(mockCreate).toHaveBeenCalledTimes(3); // initial + 2 retries
    });
  });

  describe("o-series model detection", () => {
    const oSeriesPattern = /^o[134]/;

    it("matches o1, o3, o4 model names", () => {
      expect(oSeriesPattern.test("o1")).toBe(true);
      expect(oSeriesPattern.test("o1-preview")).toBe(true);
      expect(oSeriesPattern.test("o3-mini")).toBe(true);
      expect(oSeriesPattern.test("o4-mini")).toBe(true);
    });

    it("does not match gpt models", () => {
      expect(oSeriesPattern.test("gpt-4o")).toBe(false);
      expect(oSeriesPattern.test("gpt-4")).toBe(false);
      expect(oSeriesPattern.test("gpt-3.5-turbo")).toBe(false);
    });

    it("uses max_completion_tokens for o-series models", async () => {
      const successResponse = {
        choices: [{ message: { content: "hi", tool_calls: [] }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      };
      mockCreate.mockResolvedValueOnce(successResponse);

      const provider = makeProvider("o3-mini");
      await provider.generate([{ role: "user", content: "test" }], { maxTokens: 1000 });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.max_completion_tokens).toBe(1000);
      expect(callArgs.max_tokens).toBeUndefined();
    });

    it("uses max_tokens for non-o-series models", async () => {
      const successResponse = {
        choices: [{ message: { content: "hi", tool_calls: [] }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      };
      mockCreate.mockResolvedValueOnce(successResponse);

      const provider = makeProvider("gpt-4o");
      await provider.generate([{ role: "user", content: "test" }], { maxTokens: 1000 });

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.max_tokens).toBe(1000);
      expect(callArgs.max_completion_tokens).toBeUndefined();
    });
  });

  describe("normalizeResponse", () => {
    it("extracts text content from response", async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: "Hello world", tool_calls: [] }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      const provider = makeProvider();
      const result = await provider.generate([{ role: "user", content: "hi" }]);

      expect(result.message.role).toBe("assistant");
      expect(result.message.content).toBe("Hello world");
      expect(result.finishReason).toBe("stop");
      expect(result.usage).toMatchObject({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      });
    });

    it("parses tool calls from response", async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_abc",
                  type: "function",
                  function: {
                    name: "get_weather",
                    arguments: '{"city":"London","units":"celsius"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
      });

      const provider = makeProvider();
      const result = await provider.generate([{ role: "user", content: "weather?" }]);

      expect(result.finishReason).toBe("tool_calls");
      expect(result.message.toolCalls).toHaveLength(1);
      expect(result.message.toolCalls![0]).toEqual({
        id: "call_abc",
        name: "get_weather",
        arguments: { city: "London", units: "celsius" },
      });
    });

    it("handles invalid JSON in tool arguments gracefully", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_bad",
                  type: "function",
                  function: { name: "broken", arguments: "{invalid json" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      });

      const provider = makeProvider();
      const result = await provider.generate([{ role: "user", content: "test" }]);

      expect(result.message.toolCalls).toHaveLength(1);
      expect(result.message.toolCalls![0].arguments).toEqual({});
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("extracts reasoning tokens when present", async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: "thought", tool_calls: [] }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 50,
          total_tokens: 60,
          completion_tokens_details: { reasoning_tokens: 30 },
        },
      });

      const provider = makeProvider("o3-mini");
      const result = await provider.generate([{ role: "user", content: "think" }]);

      expect(result.usage.reasoningTokens).toBe(30);
    });

    it("omits reasoningTokens when not present", async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: "hi", tool_calls: [] }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });

      const provider = makeProvider();
      const result = await provider.generate([{ role: "user", content: "test" }]);
      expect(result.usage.reasoningTokens).toBeUndefined();
    });

    it("maps finish_reason length and content_filter", async () => {
      for (const [apiReason, expectedReason] of [
        ["length", "length"],
        ["content_filter", "content_filter"],
      ] as const) {
        mockCreate.mockResolvedValueOnce({
          choices: [{ message: { content: "x", tool_calls: [] }, finish_reason: apiReason }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });

        const provider = makeProvider();
        const result = await provider.generate([{ role: "user", content: "test" }]);
        expect(result.finishReason).toBe(expectedReason);
      }
    });

    it("extracts thinking content from reasoning_content", async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: "answer",
              reasoning_content: "let me think step by step...",
              tool_calls: [],
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      });

      const provider = makeProvider("o3-mini");
      const result = await provider.generate([{ role: "user", content: "reason" }]);
      expect((result as any).thinking).toBe("let me think step by step...");
    });

    it("returns null content when message content is null", async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [
          {
            message: { content: null, tool_calls: [] },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
      });

      const provider = makeProvider();
      const result = await provider.generate([{ role: "user", content: "test" }]);
      expect(result.message.content).toBeNull();
    });
  });

  describe("generate parameters", () => {
    it("passes temperature to API", async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: "hi", tool_calls: [] }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });

      const provider = makeProvider();
      await provider.generate([{ role: "user", content: "test" }], { temperature: 0.7 });
      expect(mockCreate.mock.calls[0][0].temperature).toBe(0.7);
    });

    it("passes tools to API", async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: "hi", tool_calls: [] }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });

      const tools = [{ name: "test_tool", description: "A test", parameters: { type: "object" } }];
      const provider = makeProvider();
      await provider.generate([{ role: "user", content: "test" }], { tools });
      expect(mockCreate.mock.calls[0][0].tools).toHaveLength(1);
      expect(mockCreate.mock.calls[0][0].tools[0].function.name).toBe("test_tool");
    });

    it("uses reasoning_effort instead of temperature for reasoning models", async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: "hi", tool_calls: [] }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });

      const provider = makeProvider();
      await provider.generate([{ role: "user", content: "test" }], {
        reasoning: { enabled: true, effort: "high" },
        temperature: 0.5,
      });
      const args = mockCreate.mock.calls[0][0];
      expect(args.reasoning_effort).toBe("high");
      expect(args.temperature).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Anthropic Provider Tests
// ---------------------------------------------------------------------------

describe("AnthropicProvider", () => {
  let AnthropicProvider: any;
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mockCreate = vi.fn();

    const mod = await import("../providers/anthropic.js");
    AnthropicProvider = mod.AnthropicProvider;
  });

  function makeProvider(modelId = "claude-sonnet-4-20250514") {
    // Bypass the constructor (which requires the SDK) by creating via prototype
    const provider = Object.create(AnthropicProvider.prototype);
    provider.providerId = "anthropic";
    provider.modelId = modelId;
    provider.client = { messages: { create: mockCreate } };
    provider.AnthropicCtor = class {};
    provider.clientCache = new Map();
    return provider;
  }

  describe("toAnthropicMessages (message conversion)", () => {
    it("extracts system message and converts user messages", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "I am Claude" }],
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: "end_turn",
      });

      const provider = makeProvider();
      await provider.generate([
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hi" },
      ]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.system).toBe("You are helpful.");
      expect(callArgs.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Hi" }] }]);
    });

    it("converts tool role to user with tool_result", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "London is sunny" }],
        usage: { input_tokens: 20, output_tokens: 10 },
        stop_reason: "end_turn",
      });

      const provider = makeProvider();
      await provider.generate([
        { role: "user", content: "Weather?" },
        {
          role: "assistant",
          content: "Let me check",
          toolCalls: [{ id: "tc_1", name: "get_weather", arguments: { city: "London" } }],
        },
        { role: "tool", content: "sunny, 20°C", toolCallId: "tc_1" },
      ]);

      const callArgs = mockCreate.mock.calls[0][0];
      const toolResultMsg = callArgs.messages[2];
      expect(toolResultMsg.role).toBe("user");
      expect(toolResultMsg.content[0].type).toBe("tool_result");
      expect(toolResultMsg.content[0].tool_use_id).toBe("tc_1");
    });

    it("converts assistant messages with tool_use blocks", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "done" }],
        usage: { input_tokens: 5, output_tokens: 3 },
        stop_reason: "end_turn",
      });

      const provider = makeProvider();
      await provider.generate([
        { role: "user", content: "Do something" },
        {
          role: "assistant",
          content: "Using tool",
          toolCalls: [{ id: "tc_1", name: "my_tool", arguments: { x: 1 } }],
        },
        { role: "tool", content: "result", toolCallId: "tc_1" },
      ]);

      const callArgs = mockCreate.mock.calls[0][0];
      const assistantMsg = callArgs.messages[1];
      expect(assistantMsg.role).toBe("assistant");
      expect(assistantMsg.content).toEqual([
        { type: "text", text: "Using tool" },
        { type: "tool_use", id: "tc_1", name: "my_tool", input: { x: 1 } },
      ]);
    });

    it("omits system param when no system message is present", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 5, output_tokens: 2 },
        stop_reason: "end_turn",
      });

      const provider = makeProvider();
      await provider.generate([{ role: "user", content: "hello" }]);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.system).toBeUndefined();
    });
  });

  describe("normalizeResponse", () => {
    it("extracts text content", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "Hello from Claude" }],
        usage: { input_tokens: 8, output_tokens: 4 },
        stop_reason: "end_turn",
      });

      const provider = makeProvider();
      const result = await provider.generate([{ role: "user", content: "hi" }]);

      expect(result.message.role).toBe("assistant");
      expect(result.message.content).toBe("Hello from Claude");
      expect(result.finishReason).toBe("stop");
      expect(result.usage).toMatchObject({
        promptTokens: 8,
        completionTokens: 4,
        totalTokens: 12,
      });
    });

    it("extracts tool_use blocks as toolCalls", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [
          { type: "text", text: "Let me check" },
          { type: "tool_use", id: "tu_1", name: "search", input: { query: "test" } },
        ],
        usage: { input_tokens: 15, output_tokens: 20 },
        stop_reason: "tool_use",
      });

      const provider = makeProvider();
      const result = await provider.generate([{ role: "user", content: "find test" }]);

      expect(result.finishReason).toBe("tool_calls");
      expect(result.message.toolCalls).toHaveLength(1);
      expect(result.message.toolCalls![0]).toEqual({
        id: "tu_1",
        name: "search",
        arguments: { query: "test" },
      });
    });

    it("maps max_tokens stop_reason to length", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "truncated..." }],
        usage: { input_tokens: 10, output_tokens: 4096 },
        stop_reason: "max_tokens",
      });

      const provider = makeProvider();
      const result = await provider.generate([{ role: "user", content: "long" }]);
      expect(result.finishReason).toBe("length");
    });

    it("extracts thinking content", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [
          { type: "thinking", thinking: "Step 1: analyze..." },
          { type: "text", text: "The answer is 42" },
        ],
        usage: { input_tokens: 10, output_tokens: 50 },
        stop_reason: "end_turn",
      });

      const provider = makeProvider();
      const result = await provider.generate([{ role: "user", content: "think" }]);

      expect(result.message.content).toBe("The answer is 42");
      expect((result as any).thinking).toBe("Step 1: analyze...");
    });

    it("handles empty content blocks", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [],
        usage: { input_tokens: 5, output_tokens: 0 },
        stop_reason: "end_turn",
      });

      const provider = makeProvider();
      const result = await provider.generate([{ role: "user", content: "test" }]);
      expect(result.message.content).toBeNull();
      expect(result.message.toolCalls).toBeUndefined();
    });
  });

  describe("withRetry", () => {
    it("retries on 429 and succeeds", async () => {
      const rateLimitError = Object.assign(new Error("rate limited"), { status: 429 });
      mockCreate.mockRejectedValueOnce(rateLimitError).mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 5, output_tokens: 3 },
        stop_reason: "end_turn",
      });

      const provider = makeProvider();
      const result = await provider.generate([{ role: "user", content: "test" }]);
      expect(result.message.content).toBe("ok");
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it("does not retry on 400", async () => {
      const clientError = Object.assign(new Error("bad request"), { status: 400 });
      mockCreate.mockRejectedValue(clientError);

      const provider = makeProvider();
      await expect(provider.generate([{ role: "user", content: "bad" }])).rejects.toThrow("bad request");
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// ModelRegistry Tests
// ---------------------------------------------------------------------------

describe("ModelRegistry", () => {
  it("registers a custom provider and resolves it", async () => {
    const { ModelRegistry } = await import("../registry.js");
    const reg = new ModelRegistry();
    const mockProvider = { providerId: "mock", modelId: "mock-v1" };
    reg.register("mock", () => mockProvider as any);

    const resolved = reg.resolve("mock", "mock-v1");
    expect(resolved).toBe(mockProvider);
  });

  it("throws for unknown provider", async () => {
    const { ModelRegistry } = await import("../registry.js");
    const reg = new ModelRegistry();
    expect(() => reg.resolve("nonexistent", "model")).toThrow('Unknown provider "nonexistent"');
  });

  it("has() returns true for registered, false for unregistered", async () => {
    const { ModelRegistry } = await import("../registry.js");
    const reg = new ModelRegistry();
    reg.register("test", () => ({}) as any);
    expect(reg.has("test")).toBe(true);
    expect(reg.has("nope")).toBe(false);
  });

  it("default registry has openai, anthropic, google, ollama, vertex", async () => {
    const { modelRegistry } = await import("../registry.js");
    expect(modelRegistry.has("openai")).toBe(true);
    expect(modelRegistry.has("anthropic")).toBe(true);
    expect(modelRegistry.has("google")).toBe(true);
    expect(modelRegistry.has("ollama")).toBe(true);
    expect(modelRegistry.has("vertex")).toBe(true);
  });
});
