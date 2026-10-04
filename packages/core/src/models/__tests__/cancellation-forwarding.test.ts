import { describe, expect, it, vi } from "vitest";
import { generateOpenAIStyle, streamOpenAIStyle } from "../openai-api.js";

describe("OpenAI SDK cancellation forwarding", () => {
  it("passes the signal as SDK request options without serializing it into Chat Completions", async () => {
    const controller = new AbortController();
    const create = vi.fn(async () => ({
      choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
    await generateOpenAIStyle({ chat: { completions: { create } } }, "gpt-4o", [{ role: "user", content: "hello" }], {
      signal: controller.signal,
    });
    expect(create).toHaveBeenCalledWith(expect.not.objectContaining({ signal: expect.anything() }), {
      signal: controller.signal,
    });
  });
  it("forwards the same signal to streaming Responses and stops before dispatch for pre-abort", async () => {
    const controller = new AbortController();
    const create = vi.fn(async function* () {
      yield {
        type: "response.completed",
        response: {
          id: "fixture-response",
          output: [],
          status: "completed",
          usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
        },
      };
    });
    const client = { responses: { create: vi.fn(async () => create()) } };
    for await (const _chunk of streamOpenAIStyle(client, "gpt-5.6-terra", [{ role: "user", content: "hello" }], {
      tools: [{ name: "fixture", description: "fixture", parameters: { type: "object" } }],
      signal: controller.signal,
    })) {
    }
    expect(client.responses.create).toHaveBeenCalledWith(expect.any(Object), { signal: controller.signal });
    controller.abort();
    await expect(generateOpenAIStyle(client, "gpt-5.6-terra", [], { signal: controller.signal })).rejects.toThrow();
    expect(client.responses.create).toHaveBeenCalledTimes(1);
  });
});
