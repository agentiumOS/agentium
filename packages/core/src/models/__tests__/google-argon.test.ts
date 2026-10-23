import { createServer, type RequestListener } from "node:http";
import { describe, expect, it } from "vitest";
import { GoogleProvider } from "../providers/google.js";
import type { ChatMessage, ModelConfig, StreamChunk } from "../types.js";
import { ModelUsageError } from "../usage-normalizers.js";

async function server(listener: RequestListener) {
  const instance = createServer(listener);
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  const address = instance.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      instance.closeAllConnections();
      await new Promise<void>((resolve, reject) => instance.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

const usage = {
  promptTokenCount: 10,
  cachedContentTokenCount: 0,
  candidatesTokenCount: 2,
  thoughtsTokenCount: 1,
  totalTokenCount: 13,
};
const answer = {
  modelVersion: "gemini-4-argon-001",
  candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
  usageMetadata: usage,
};

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe.each(["generate", "stream"] as const)("Argon %s through the Google SDK", (mode) => {
  it.each([
    ["low", "LOW"],
    ["medium", "MEDIUM"],
    [undefined, "MEDIUM"],
    ["high", "HIGH"],
    ["xhigh", "HIGH"],
    ["max", "HIGH"],
  ] as const)("serializes reasoning %s without a thinking budget", async (effort, expected) => {
    const requests: unknown[] = [];
    const fixture = await server(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      response.writeHead(200, { "content-type": mode === "stream" ? "text/event-stream" : "application/json" });
      response.end(mode === "stream" ? `data: ${JSON.stringify(answer)}\n\n` : JSON.stringify(answer));
    });
    try {
      const provider = new GoogleProvider("gemini-4-argon", { apiKey: "fixture", baseURL: fixture.url });
      const options = { reasoning: { enabled: true, effort }, temperature: 0.4, topP: 0.8, maxTokens: 65536 };
      const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
      if (mode === "stream") await collect(provider.stream(messages, options));
      else await provider.generate(messages, options);
      expect(requests).toEqual([
        {
          contents: [{ role: "user", parts: [{ text: "hello" }] }],
          generationConfig: {
            maxOutputTokens: 65536,
            thinkingConfig: { includeThoughts: true, thinkingLevel: expected },
          },
        },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it.each<ModelConfig>([
    { reasoning: { enabled: false } },
    { reasoning: { enabled: true, effort: "none" } },
    { reasoning: { enabled: true, effort: "minimal" } },
    { reasoning: { enabled: true, budgetTokens: 0 } },
    { providerOptions: { cachedContent: "cachedContents/test" } },
    { maxTokens: 65537 },
  ])("rejects unsupported Argon options before HTTP %#", async (options) => {
    let calls = 0;
    const fixture = await server((_request, response) => {
      calls++;
      response.end(JSON.stringify(answer));
    });
    try {
      const provider = new GoogleProvider("gemini-4-argon", { apiKey: "fixture", baseURL: fixture.url });
      const pending =
        mode === "stream"
          ? provider.stream([{ role: "user", content: "hello" }], options).next()
          : provider.generate([{ role: "user", content: "hello" }], options);
      await expect(pending).rejects.toThrow(/Argon/);
      expect(calls).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it("preserves a lower explicit limit and leaves omitted reasoning at the provider default", async () => {
    const requests: unknown[] = [];
    const fixture = await server(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      response.writeHead(200, { "content-type": mode === "stream" ? "text/event-stream" : "application/json" });
      response.end(mode === "stream" ? `data: ${JSON.stringify(answer)}\n\n` : JSON.stringify(answer));
    });
    try {
      const provider = new GoogleProvider("models/gemini-4-argon", { apiKey: "fixture", baseURL: fixture.url });
      if (mode === "stream") await collect(provider.stream([{ role: "user", content: "hello" }], { maxTokens: 123 }));
      else await provider.generate([{ role: "user", content: "hello" }], { maxTokens: 123 });
      expect(requests).toEqual([
        { contents: [{ role: "user", parts: [{ text: "hello" }] }], generationConfig: { maxOutputTokens: 123 } },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it.each([{ finishReason: "CONTINUATION" }, { continuationToken: "private-continuation-token" }])(
    "fails on a no-content continuation and retains usage %#",
    async (candidate) => {
      let calls = 0;
      const fixture = await server((_request, response) => {
        calls++;
        response.writeHead(200, { "content-type": mode === "stream" ? "text/event-stream" : "application/json" });
        const partial = { modelVersion: "gemini-4-argon-001", usageMetadata: usage, candidates: [candidate] };
        response.end(mode === "stream" ? `data: ${JSON.stringify(partial)}\n\n` : JSON.stringify(partial));
      });
      try {
        const provider = new GoogleProvider("gemini-4-argon", { apiKey: "fixture", baseURL: fixture.url });
        const pending =
          mode === "stream"
            ? collect(provider.stream([{ role: "user", content: "hello" }]))
            : provider.generate([{ role: "user", content: "hello" }]);
        const error = await pending.catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(ModelUsageError);
        if (!(error instanceof ModelUsageError)) throw new Error("Expected an accounted continuation failure");
        expect(error.message).toMatch(/continuation/i);
        expect(error.message).not.toContain("private-continuation-token");
        expect(error.usage).toMatchObject({ promptTokens: 10, completionTokens: 3, totalTokens: 13 });
        expect(error.retryable).toBe(false);
        expect(calls).toBe(1);
      } finally {
        await fixture.close();
      }
    },
  );

  it("replays a signed native function call with its matching result", async () => {
    const requests: unknown[] = [];
    const signedPart = {
      functionCall: { id: "native-call-42", name: "lookup", args: { q: "hello" } },
      thoughtSignature: "c2ln",
    };
    const toolAnswer = {
      ...answer,
      candidates: [{ content: { role: "model", parts: [signedPart] }, finishReason: "STOP" }],
    };
    const fixture = await server(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      const result = requests.length === 1 ? toolAnswer : answer;
      response.writeHead(200, { "content-type": mode === "stream" ? "text/event-stream" : "application/json" });
      response.end(mode === "stream" ? `data: ${JSON.stringify(result)}\n\n` : JSON.stringify(result));
    });
    try {
      const provider = new GoogleProvider("gemini-4-argon", { apiKey: "fixture", baseURL: fixture.url });
      const history: ChatMessage[] = [{ role: "user", content: "hello" }];
      if (mode === "generate") {
        const first = await provider.generate(history);
        expect(first.message.toolCalls).toEqual([{ id: "native-call-42", name: "lookup", arguments: { q: "hello" } }]);
        history.push(first.message);
      } else {
        const chunks = await collect(provider.stream(history));
        expect(chunks.find((chunk) => chunk.type === "tool_call_start")).toEqual({
          type: "tool_call_start",
          toolCall: { id: "native-call-42", name: "lookup" },
        });
        const finish = chunks.find((chunk) => chunk.type === "finish");
        if (finish?.type !== "finish") throw new Error("Missing finish chunk");
        history.push({
          role: "assistant",
          content: null,
          toolCalls: [{ id: "native-call-42", name: "lookup", arguments: { q: "hello" } }],
          providerExtras: finish.providerExtras,
        });
      }
      history.push({ role: "tool", toolCallId: "native-call-42", name: "lookup", content: "found" });
      if (mode === "stream") await collect(provider.stream(history));
      else await provider.generate(history);
      expect(requests[1]).toEqual({
        contents: [
          { role: "user", parts: [{ text: "hello" }] },
          { role: "model", parts: [signedPart] },
          {
            role: "function",
            parts: [{ functionResponse: { id: "native-call-42", name: "lookup", response: { result: "found" } } }],
          },
        ],
        generationConfig: {},
      });
    } finally {
      await fixture.close();
    }
  });

  it("keeps fallback call IDs positional after a native ID", async () => {
    const fixture = await server((_request, response) => {
      const result = {
        ...answer,
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { id: "google_tc_0", name: "first", args: {} } },
                { functionCall: { name: "second", args: {} } },
              ],
            },
            finishReason: "STOP",
          },
        ],
      };
      response.writeHead(200, { "content-type": mode === "stream" ? "text/event-stream" : "application/json" });
      response.end(mode === "stream" ? `data: ${JSON.stringify(result)}\n\n` : JSON.stringify(result));
    });
    try {
      const provider = new GoogleProvider("gemini-4-argon", { apiKey: "fixture", baseURL: fixture.url });
      const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
      const calls =
        mode === "stream"
          ? (await collect(provider.stream(messages)))
              .filter((chunk) => chunk.type === "tool_call_start")
              .map((chunk) => chunk.toolCall)
          : (await provider.generate(messages)).message.toolCalls;
      expect(calls?.map((call) => call.id)).toEqual(["google_tc_0", "google_tc_1"]);
    } finally {
      await fixture.close();
    }
  });
});

it.each(["call", "text", "empty"] as const)(
  "replays every signed function call split across stream chunks with a %s terminal chunk",
  async (terminal) => {
    const requests: unknown[] = [];
    const first = { functionCall: { id: "one", name: "lookup", args: { q: 1 } }, thoughtSignature: "c2ln" };
    const second = { functionCall: { id: "two", name: "lookup", args: { q: 2 } }, thoughtSignature: "c2lnMg==" };
    const terminalParts = terminal === "text" ? [{ text: "Looking up both." }] : [];
    const fixture = await server(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunks =
        requests.length > 1
          ? [answer]
          : [
              { candidates: [{ content: { parts: [first] } }] },
              ...(terminal === "call" ? [] : [{ candidates: [{ content: { parts: [second] } }] }]),
              {
                candidates: [
                  {
                    ...(terminal === "empty"
                      ? {}
                      : { content: { parts: terminal === "call" ? [second] : terminalParts } }),
                    finishReason: "STOP",
                  },
                ],
                usageMetadata: usage,
              },
            ];
      for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.end();
    });
    try {
      const provider = new GoogleProvider("gemini-4-argon", { apiKey: "fixture", baseURL: fixture.url });
      const history: ChatMessage[] = [{ role: "user", content: "look up both" }];
      const chunks = await collect(provider.stream(history));
      expect(chunks.filter((chunk) => chunk.type === "tool_call_start").map((chunk) => chunk.toolCall)).toEqual([
        { id: "one", name: "lookup" },
        { id: "two", name: "lookup" },
      ]);
      const finish = chunks.find((chunk) => chunk.type === "finish");
      expect(finish).toMatchObject({ type: "finish", finishReason: "tool_calls", usage: { totalTokens: 13 } });
      if (finish?.type !== "finish") throw new Error("Missing tool finish chunk");
      history.push(
        {
          role: "assistant",
          content: terminal === "text" ? "Looking up both." : null,
          toolCalls: [
            { id: "one", name: "lookup", arguments: { q: 1 } },
            { id: "two", name: "lookup", arguments: { q: 2 } },
          ],
          providerExtras: finish.providerExtras,
        },
        { role: "tool", toolCallId: "one", name: "lookup", content: "first result" },
        { role: "tool", toolCallId: "two", name: "lookup", content: "second result" },
      );
      await collect(provider.stream(history));
      expect(requests[1]).toEqual({
        contents: [
          { role: "user", parts: [{ text: "look up both" }] },
          { role: "model", parts: [first, second, ...terminalParts] },
          {
            role: "function",
            parts: [{ functionResponse: { id: "one", name: "lookup", response: { result: "first result" } } }],
          },
          {
            role: "function",
            parts: [{ functionResponse: { id: "two", name: "lookup", response: { result: "second result" } } }],
          },
        ],
        generationConfig: {},
      });
    } finally {
      await fixture.close();
    }
  },
);

it("retains streamed usage and served identity before a token-only continuation", async () => {
  let calls = 0;
  const fixture = await server((_request, response) => {
    calls++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of [
      {
        modelVersion: "gemini-4-argon-001",
        responseId: "response-42",
        candidates: [{ content: { parts: [{ text: "partial" }] } }],
      },
      { usageMetadata: usage },
      { candidates: [{ continuationToken: "private-token" }] },
    ])
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end();
  });
  try {
    const provider = new GoogleProvider("gemini-4-argon", { apiKey: "fixture", baseURL: fixture.url });
    const chunks: StreamChunk[] = [];
    let failure: unknown;
    try {
      for await (const chunk of provider.stream([{ role: "user", content: "hello" }])) chunks.push(chunk);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ModelUsageError);
    if (!(failure instanceof ModelUsageError)) throw new Error("Expected continuation failure");
    expect(failure.usage.accounting?.context).toMatchObject({
      requestedModelId: "gemini-4-argon",
      modelId: "gemini-4-argon-001",
      providerRequestId: "response-42",
    });
    expect(failure.usage.totalTokens).toBe(13);
    expect(chunks.filter((chunk) => chunk.type === "text")).toEqual([{ type: "text", text: "partial" }]);
    expect(chunks.filter((chunk) => chunk.type === "finish")).toEqual([]);
    expect(calls).toBe(1);
  } finally {
    await fixture.close();
  }
});

it("aborts an in-flight Argon stream with the caller's reason and closes HTTP", async () => {
  let closed: (() => void) | undefined;
  const disconnected = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const fixture = await server((_request, response) => {
    response.on("close", () => closed?.());
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "started" }] } }] })}\n\n`);
  });
  try {
    const provider = new GoogleProvider("gemini-4-argon", {
      apiKey: "fixture",
      baseURL: fixture.url,
      sdkMaxRetries: 0,
    });
    const controller = new AbortController();
    const iterator = provider.stream([{ role: "user", content: "hello" }], { signal: controller.signal });
    expect(await iterator.next()).toEqual({ value: { type: "text", text: "started" }, done: false });
    const reason = new Error("caller stopped Argon");
    controller.abort(reason);
    await expect(iterator.next()).rejects.toBe(reason);
    await disconnected;
  } finally {
    await fixture.close();
  }
});
