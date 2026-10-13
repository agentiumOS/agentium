import { describe, expect, it, vi } from "vitest";
import { ModelCapabilityError, validateModelRequest } from "../capabilities.js";
import {
  buildResponsesParams,
  EndpointCompatibilityError,
  generateOpenAIStyle,
  streamOpenAIStyle,
} from "../openai-api.js";
import { OpenAIProvider } from "../providers/openai.js";

const tools = [{ name: "tool", description: "tool", parameters: {} }];
const unavailable = Object.assign(new Error("no responses"), { status: 404 });
const client = () => ({
  responses: { create: vi.fn().mockRejectedValue(unavailable) },
  chat: { completions: { create: vi.fn() } },
});
describe("endpoint and capability contracts", () => {
  it.each(["generate", "stream"])("requires Responses and rejects reasoning loss during %s", async (mode) => {
    const sdk = client();
    const invoke = (model: string, endpoint?: "responses") =>
      mode === "generate"
        ? generateOpenAIStyle(sdk, model, [], { tools }, undefined, { endpoint })
        : streamOpenAIStyle(sdk, model, [], { tools }, undefined, { endpoint }).next();
    await expect(invoke("gpt-5.6")).rejects.toBeInstanceOf(EndpointCompatibilityError);
    await expect(invoke("gpt-4o", "responses")).rejects.toThrow("fallback is disabled");
    expect(sdk.chat.completions.create).not.toHaveBeenCalled();
  });
  it("rejects a missing Responses SDK before using Chat Completions", async () => {
    const sdk = { chat: { completions: { create: vi.fn() } } };
    await expect(generateOpenAIStyle(sdk, "gpt-6", [], { tools })).rejects.toThrow("preserve");
    expect(sdk.chat.completions.create).not.toHaveBeenCalled();
  });
  it("permits explicit compatible Chat Completions with reasoning disabled", async () => {
    const sdk = client();
    sdk.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    await generateOpenAIStyle(sdk, "gpt-5.6", [], { tools, reasoning: { enabled: false } }, undefined, {
      endpoint: "chat_completions",
    });
    expect(sdk.responses.create).not.toHaveBeenCalled();
    expect(sdk.chat.completions.create.mock.calls[0][0]).toMatchObject({ reasoning_effort: "none" });
    await expect(
      generateOpenAIStyle(sdk, "gpt-6", [], { tools, reasoning: { enabled: false } }, undefined, {
        endpoint: "chat_completions",
      }),
    ).rejects.toThrow("preserve");
  });
  it("preserves Responses effort none, and mode/context without an explicit effort", () => {
    expect(buildResponsesParams("gpt-6", [], { reasoning: { enabled: false } }).reasoning).toEqual({ effort: "none" });
    expect(
      buildResponsesParams("gpt-6", [], { reasoning: { enabled: true, mode: "pro", context: "all_turns" } }).reasoning,
    ).toEqual({ summary: "detailed", mode: "pro", context: "all_turns" });
  });
  it("validates host capability data without assuming an unknown registry", async () => {
    expect(() => validateModelRequest(undefined, [], { tools, maxTokens: 100 })).not.toThrow();
    expect(() => validateModelRequest(undefined, [], {}, "error")).toThrow("Unknown model capability");
    expect(() => validateModelRequest({ contextWindow: 10 }, [], { maxTokens: 5 }, "allow", 6)).toThrow(
      ModelCapabilityError,
    );
    expect(() => validateModelRequest({ maxOutputTokens: 10 }, [], { maxTokens: 11 })).toThrow(ModelCapabilityError);
    expect(() =>
      validateModelRequest({ reasoningModes: ["standard"] }, [], { reasoning: { enabled: true, mode: "pro" } }),
    ).toThrow(ModelCapabilityError);
    expect(() =>
      validateModelRequest({ reasoningEfforts: ["low"] }, [], { reasoning: { enabled: true, effort: "high" } }),
    ).toThrow(ModelCapabilityError);
    const provider = new OpenAIProvider("host-model", { apiKey: "test", capabilities: { tools: false } });
    const sdk = client();
    Reflect.set(provider, "client", sdk);
    await expect(provider.generate([], { tools })).rejects.toThrow(ModelCapabilityError);
    expect(sdk.responses.create).not.toHaveBeenCalled();
    expect(sdk.chat.completions.create).not.toHaveBeenCalled();
  });
});

it("caps an omitted output limit from the host capability facts", async () => {
  const sdk = client();
  sdk.chat.completions.create.mockResolvedValue({
    choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  const provider = new OpenAIProvider("host-model", { apiKey: "test", capabilities: { maxOutputTokens: 20 } });
  Reflect.set(provider, "client", sdk);
  await provider.generate([]);
  expect(sdk.chat.completions.create.mock.calls[0][0]).toMatchObject({ max_completion_tokens: 20 });
});
