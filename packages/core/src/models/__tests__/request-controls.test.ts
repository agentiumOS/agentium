import { afterEach, describe, expect, it, vi } from "vitest";
import { withUsageEvidence } from "../../cost/context.js";
import { withRetry } from "../../utils/retry.js";
import { streamOpenAIStyle } from "../openai-api.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { OpenAIProvider } from "../providers/openai.js";
import { createRequestScope, ModelDeadlineError } from "../request-controls.js";

const failure = () => Object.assign(new Error("busy"), { status: 503 });
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("logical request controls", () => {
  it("cancels during retry backoff with the original reason and removes timers", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const scope = createRequestScope({}, { signal: controller.signal });
    const work = vi.fn().mockRejectedValue(failure());
    const result = scope.retry(work);
    const error = new Error("host cancelled");
    const assertion = expect(result).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(error);
    await assertion;
    scope.dispose();
    expect(work).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps a single deadline across retries", async () => {
    vi.useFakeTimers();
    const scope = createRequestScope({ callTimeoutMs: 2000 });
    const work = vi.fn().mockRejectedValue(failure());
    const result = scope.retry(work);
    const assertion = expect(result).rejects.toBeInstanceOf(ModelDeadlineError);
    await vi.advanceTimersByTimeAsync(2001);
    await assertion;
    expect(work).toHaveBeenCalledTimes(2);
    scope.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("disables Agentium retries independently", async () => {
    const scope = createRequestScope({ maxRetries: 0 });
    const work = vi.fn().mockRejectedValue(failure());
    await expect(scope.retry(work)).rejects.toThrow("busy");
    expect(work).toHaveBeenCalledTimes(1);
    scope.dispose();
  });
  it.each([OpenAIProvider, AnthropicProvider])(
    "forwards SDK controls for constructor and per-call keys",
    (Provider) => {
      const provider = new Provider("model", { apiKey: "test", sdkMaxRetries: 0, timeoutMs: 1234 });
      // Read actual installed SDK clients, without network traffic.
      const inspect = Reflect.get(provider, "getClient").bind(provider);
      for (const client of [inspect(), inspect("other")]) {
        expect(client.maxRetries).toBe(0);
        expect(client.timeout).toBe(1234);
      }
      expect(provider.attemptVisibility).toBe("physical");
      expect(new Provider("model", { apiKey: "test" }).attemptVisibility).toBe("opaque");
    },
  );
  it("does not fallback after consuming raw metadata before any public chunk", async () => {
    const unavailable = Object.assign(new Error("not found"), { status: 404 });
    const chat = vi.fn();
    const client = {
      responses: {
        create: async () =>
          (async function* () {
            yield { type: "response.created" };
            throw unavailable;
          })(),
      },
      chat: { completions: { create: chat } },
    };
    const stream = streamOpenAIStyle(client, "gpt-6", [], { tools: [{ name: "x", description: "x", parameters: {} }] });
    await expect(stream.next()).rejects.toBe(unavailable);
    expect(chat).not.toHaveBeenCalled();
  });
  it("retries establishment but never a partially consumed stream", async () => {
    vi.useFakeTimers();
    const provider = new OpenAIProvider("gpt-4o", { apiKey: "test", sdkMaxRetries: 0 });
    const create = vi
      .fn()
      .mockRejectedValueOnce(failure())
      .mockResolvedValue(
        (async function* () {
          yield { choices: [{ delta: { content: "first" } }] };
          throw failure();
        })(),
      );
    Reflect.set(provider, "client", { chat: { completions: { create } } });
    const stream = provider.stream([]);
    const first = stream.next();
    await vi.advanceTimersByTimeAsync(1501);
    expect((await first).value).toMatchObject({ text: "first" });
    await expect(stream.next()).rejects.toThrow("busy");
    expect(create).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("preserves caller cancellation during Anthropic streaming and closes the transport", async () => {
  const provider = new AnthropicProvider("claude-sonnet-4-20250514", {
    apiKey: "test",
    maxRetries: 0,
    sdkMaxRetries: 0,
  });
  const controller = new AbortController();
  const close = vi.fn();
  const request = vi.fn(async (_params, options) => ({
    async *[Symbol.asyncIterator]() {
      try {
        yield { type: "content_block_delta", delta: { type: "text_delta", text: "first" } };
        await new Promise<void>((_, reject) => {
          const cancel = () => reject(options.signal.reason);
          options.signal.addEventListener("abort", cancel, { once: true });
          if (options.signal.aborted) cancel();
        });
      } finally {
        close();
      }
    },
  }));
  Reflect.set(provider, "client", { messages: { create: request } });
  const stream = provider.stream([], { signal: controller.signal });
  expect((await stream.next()).value).toMatchObject({ text: "first" });
  const pending = stream.next();
  const error = new Error("stop stream");
  const assertion = expect(pending).rejects.toBe(error);
  controller.abort(error);
  await assertion;
  expect(request).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

it("expires a logical deadline while consuming an OpenAI stream", async () => {
  vi.useFakeTimers();
  const provider = new OpenAIProvider("gpt-4o", { apiKey: "test", callTimeoutMs: 10 });
  const request = vi.fn(async (_params, options) =>
    (async function* () {
      yield { choices: [{ delta: { content: "first" } }] };
      await new Promise<void>((_, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    })(),
  );
  Reflect.set(provider, "client", { chat: { completions: { create: request } } });
  const stream = provider.stream([]);
  await stream.next();
  const pending = stream.next();
  const assertion = expect(pending).rejects.toBeInstanceOf(ModelDeadlineError);
  await vi.advanceTimersByTimeAsync(11);
  await assertion;
  expect(request).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["agentium", "sdk"])("reports %s-owned retries without claiming hidden SDK visibility", async (owner) => {
  vi.useFakeTimers();
  const request = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "busy" } }), {
        status: 503,
        headers: { "content-type": "application/json", "retry-after-ms": "1" },
      }),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
  vi.stubGlobal("fetch", request);
  const provider = new OpenAIProvider("gpt-4o", {
    apiKey: "test",
    maxRetries: owner === "agentium" ? 1 : 0,
    sdkMaxRetries: owner === "sdk" ? 1 : 0,
  });
  const onRetry = vi.fn(async () => {});
  const result = withUsageEvidence({ onRetry }, () => provider.generate([]));
  await vi.advanceTimersByTimeAsync(2000);
  expect((await result).message.content).toBe("ok");
  expect(request).toHaveBeenCalledTimes(2);
  expect(onRetry).toHaveBeenCalledTimes(owner === "agentium" ? 1 : 0);
  expect(provider.attemptVisibility).toBe(owner === "agentium" ? "physical" : "opaque");
});

it("cancels an explicitly enabled Agent retry wait", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const request = vi.fn().mockRejectedValue(failure());
  const pending = withRetry(request, { maxRetries: 2 }, controller.signal);
  const reason = new Error("stop Agent retries");
  const assertion = expect(pending).rejects.toBe(reason);
  await vi.advanceTimersByTimeAsync(1);
  controller.abort(reason);
  await assertion;
  expect(request).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
