import type { ChatMessage, ModelProvider, ModelResponse, StreamChunk } from "@agentium/core";
import { Agent, defineTool, EventBus, LLMLoop, RunContext, ToolExecutor } from "@agentium/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";
import { agentDriver } from "../../drivers.js";
import { fetchHarnessContext } from "../context.js";
import { HarnessRuntime } from "../driver.js";
import { runBeforeModel, sortHarnessMiddleware, validateHarnessMessages } from "../middleware.js";
import { createHarnessDefinition } from "../resolve.js";
import type { HarnessContextEntry, HarnessMiddleware } from "../types.js";

const context = (signal?: AbortSignal) =>
  new RunContext({ sessionId: "session", userId: "actor", tenantId: "tenant", eventBus: new EventBus(), signal });
const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const entry = (text = "retrieved content"): HarnessContextEntry => ({
  id: "entry",
  text,
  trust: "source",
  byteLength: 1,
  estimatedTokens: 0,
});
const exchange: ChatMessage[] = [
  { role: "user", content: "old question" },
  {
    role: "assistant",
    content: null,
    toolCalls: [{ id: "a", name: "lookup", arguments: {} }],
    providerExtras: {
      responsesReplay: { version: 1, owner: "example", items: [{ type: "reasoning", encrypted_content: "opaque" }] },
    },
  },
  { role: "tool", toolCallId: "a", content: "found" },
  { role: "assistant", content: "old answer" },
];

describe("harness middleware ordering and boundaries", () => {
  it("uses stable topological order and rejects invalid constraints", () => {
    expect(
      sortHarnessMiddleware([{ id: "a", after: ["c"] }, { id: "b" }, { id: "c" }, { id: "d", after: ["a"] }]).map(
        (m) => m.id,
      ),
    ).toEqual(["b", "c", "a", "d"]);
    expect(() => sortHarnessMiddleware([{ id: "a", before: ["missing"] }])).toThrow("unknown");
    expect(() =>
      sortHarnessMiddleware([
        { id: "a", after: ["b"] },
        { id: "b", after: ["a"] },
      ]),
    ).toThrow("cycle");
    expect(() => sortHarnessMiddleware([{ id: "a" }, { id: "a" }])).toThrow("unique");
  });
  it("allows whole old turns to compact but keeps current and partial continuations intact", () => {
    const system: ChatMessage = { role: "system", content: "mandatory" };
    const current: ChatMessage = { role: "user", content: "new question" };
    expect(() => validateHarnessMessages([system, ...exchange, current], [system, current])).not.toThrow();
    expect(() => validateHarnessMessages([system, ...exchange], [system])).toThrow("intact");
    expect(() =>
      validateHarnessMessages([system, ...exchange, current], [system, exchange[0], exchange[1], current]),
    ).toThrow();
    expect(() => validateHarnessMessages([system, current], [current])).toThrow("host instructions");
    expect(() => validateHarnessMessages([system, current], [{ ...system, content: "changed" }, current])).toThrow(
      "host instructions",
    );
  });
  it("protects against in-place mutations and source promotion", async () => {
    const original: ChatMessage[] = [
      { role: "system", content: "host" },
      { role: "user", content: "hi" },
    ];
    await expect(
      runBeforeModel(
        [
          {
            id: "bad",
            async beforeModel(messages) {
              (messages[0] as ChatMessage).content = "erased";
              return [...messages];
            },
          },
        ],
        original,
        context(),
      ),
    ).rejects.toThrow("host instructions");
    expect(original[0].content).toBe("host");
    const result = await fetchHarnessContext([{ id: "source", fetch: async () => [entry()] }], "query", context());
    expect(() => validateHarnessMessages(result.messages, [{ ...result.messages[0], role: "system" }])).toThrow();
    expect(() =>
      validateHarnessMessages(result.messages, [{ ...result.messages[0], providerExtras: undefined }]),
    ).toThrow("provenance");
  });
});

describe("central harness context budgets", () => {
  it("treats every retrieved entry as source data and ignores advertised sizes", async () => {
    const result = await fetchHarnessContext(
      [
        {
          id: "source",
          fetch: async () => [{ ...entry("x".repeat(10_000)), trust: "host", source: { uri: "file://notes" } }],
        },
      ],
      "query",
      context(),
      { maxBytes: 300, maxTokens: 10000 },
    );
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    const payload = JSON.parse(result.messages[0].content as string);
    expect(payload).toMatchObject({ kind: "harness-source-data", trust: "source", source: { uri: "file://notes" } });
    expect(Buffer.byteLength(result.messages[0].content as string)).toBeLessThanOrEqual(300);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["trust_downgraded", "truncated"]);
  });
  it("shares entry and byte limits across all sources and drops expired entries", async () => {
    const next = vi.fn().mockResolvedValue([entry()]);
    const result = await fetchHarnessContext(
      [
        { id: "old", fetch: async () => [{ ...entry(), expiresAt: Date.now() - 1 }] },
        { id: "first", fetch: async () => [entry()] },
        { id: "second", fetch: next },
      ],
      "query",
      context(),
      { maxEntries: 1 },
    );
    expect(result.messages).toHaveLength(1);
    expect(next).not.toHaveBeenCalled();
    expect(result.diagnostics.map((d) => d.code)).toEqual(["expired", "budget"]);
  });
  it("centrally estimates tokens and supplies only the remaining budget", async () => {
    let remainingTokens = 0;
    const result = await fetchHarnessContext(
      [
        { id: "first", fetch: async () => [entry()] },
        {
          id: "second",
          fetch: async (_query, ctx, budget) => {
            expect(ctx.tenantId).toBe("tenant");
            remainingTokens = budget.maxTokens!;
            return [{ ...entry("y".repeat(5000)), estimatedTokens: 0 }];
          },
        },
      ],
      "query",
      context(),
      { maxTokens: 180 },
    );
    expect(remainingTokens).toBeGreaterThan(0);
    expect(remainingTokens).toBeLessThan(180);
    expect(result.diagnostics.some((d) => d.code === "truncated")).toBe(true);
  });
  it("bounds a noncooperating fetch and aborts the source signal", async () => {
    let signal: AbortSignal | undefined;
    const result = await fetchHarnessContext(
      [
        {
          id: "stuck",
          fetch: async (_query, ctx) => {
            signal = ctx.signal;
            return new Promise(() => {});
          },
        },
      ],
      "query",
      context(),
      { deadlineMs: 10 },
    );
    expect(signal?.aborted).toBe(true);
    expect(result.diagnostics[0].code).toBe("deadline");
  });
  it("propagates caller cancellation and prevents later fetches", async () => {
    const controller = new AbortController();
    const later = vi.fn();
    const promise = fetchHarnessContext(
      [
        {
          id: "first",
          fetch: async () => {
            controller.abort();
            return new Promise(() => {});
          },
        },
        { id: "later", fetch: later },
      ],
      "query",
      context(controller.signal),
    );
    await expect(promise).rejects.toThrow();
    expect(later).not.toHaveBeenCalled();
  });
  it("rejects duplicate IDs/invalid budgets and diagnoses failed sources without exposing errors", async () => {
    await expect(
      fetchHarnessContext(
        [
          { id: "same", fetch: async () => [] },
          { id: "same", fetch: async () => [] },
        ],
        "",
        context(),
      ),
    ).rejects.toThrow("unique");
    await expect(fetchHarnessContext([], "", context(), { maxBytes: -1 })).rejects.toThrow("budget");
    const result = await fetchHarnessContext(
      [
        {
          id: "fails",
          fetch: async () => {
            throw new Error("api-key-secret");
          },
        },
      ],
      "",
      context(),
    );
    expect(result.diagnostics[0].code).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("api-key-secret");
  });
});

for (const mode of ["run", "stream"] as const) {
  describe(`harness ${mode} loop integration`, () => {
    it("runs ordered input transforms and observes full model/tool results", async () => {
      const order: string[] = [];
      const responses: ModelResponse[] = [];
      const tools: unknown[] = [];
      const middleware: HarnessMiddleware[] = [
        {
          id: "second",
          after: ["first"],
          async beforeModel(messages) {
            order.push("second");
            return [...messages];
          },
          async afterModel(response) {
            responses.push(response);
          },
          async afterTool(result) {
            tools.push(result);
          },
        },
        {
          id: "first",
          async beforeModel(messages) {
            order.push("first");
            return [...messages];
          },
        },
      ];
      let n = 0;
      const provider: ModelProvider = {
        providerId: "mock",
        modelId: "mock",
        async generate() {
          return n++ === 0
            ? { message: exchange[1], usage, finishReason: "tool_calls", raw: { responseId: "native" } }
            : { message: { role: "assistant", content: "done" }, usage, finishReason: "stop", raw: {} };
        },
        async *stream(): AsyncGenerator<StreamChunk> {
          if (n++ === 0) {
            yield { type: "tool_call_start", toolCall: { id: "a", name: "lookup" } };
            yield { type: "tool_call_delta", toolCallId: "a", argumentsDelta: "{}" };
            yield { type: "finish", finishReason: "tool_calls", usage, providerExtras: exchange[1].providerExtras };
          } else {
            yield { type: "text", text: "done" };
            yield { type: "finish", finishReason: "stop", usage };
          }
        },
      };
      const tool = defineTool({
        name: "lookup",
        description: "lookup",
        parameters: z.object({}),
        async execute() {
          return { content: "found", artifacts: [{ type: "file", data: "artifact" }] };
        },
      });
      const agent = new Agent({
        name: "fixture",
        model: provider,
        instructions: "host",
        tools: [tool],
        maxToolRoundtrips: 1,
        register: false,
      });
      const runtime = new HarnessRuntime({
        driver: agentDriver(agent, { stream: mode === "stream" }),
        grants: { toolIds: ["lookup"], modelRoles: ["main"] },
        definition: createHarnessDefinition({
          abilities: [
            {
              instanceId: "middleware",
              validate() {},
              describe: () => ({ toolNames: [], requirements: [] }),
              bind: async () => ({ tools: [], middleware }),
            },
          ],
        }),
      });
      expect(
        (
          await runtime
            .start("query", { identity: { tenantId: "tenant", userId: "actor" }, sessionId: "session" })
            .result()
        ).status,
      ).toBe("completed");
      await agent.close();
      expect(order).toEqual(["first", "second", "first", "second"]);
      expect(responses).toHaveLength(2);
      expect(responses[0].message.providerExtras).toEqual(exchange[1].providerExtras);
      expect(responses[0].usage).toEqual(usage);
      expect(responses[0].raw).toBeDefined();
      expect(tools).toEqual([
        {
          toolCallId: "a",
          toolName: "lookup",
          result: { content: "found", artifacts: [{ type: "file", data: "artifact" }] },
        },
      ]);
    });
    it("prevents legacy hooks from erasing host policy even with no middleware", async () => {
      const generate = vi.fn();
      const stream = vi.fn();
      const loop = new LLMLoop({ providerId: "mock", modelId: "mock", generate, stream }, null, {
        maxToolRoundtrips: 0,
        controlledExecution: true,
        loopHooks: { beforeLLMCall: async () => [{ role: "user", content: "overridden" }] },
      });
      await expect(async () => {
        if (mode === "run") await loop.run([{ role: "system", content: "host" }], context());
        else
          for await (const _chunk of loop.stream([{ role: "system", content: "host" }], context())) {
            /* consume */
          }
      }).rejects.toThrow("host instructions");
      expect(generate).not.toHaveBeenCalled();
      expect(stream).not.toHaveBeenCalled();
    });
  });
}

for (const mode of ["run", "stream"] as const) {
  it.each([0, 1])(`enforces ${mode} harness tool budget %i before further effects`, async (maxToolRoundtrips) => {
    let turn = 0;
    const execute = vi.fn().mockResolvedValue("done");
    const provider: ModelProvider = {
      providerId: "mock",
      modelId: "mock",
      async generate() {
        return {
          message: {
            role: "assistant",
            content: null,
            toolCalls: [{ id: `call-${turn++}`, name: "act", arguments: {} }],
          },
          finishReason: "tool_calls",
          usage,
          raw: {},
        };
      },
      async *stream() {
        const id = `call-${turn++}`;
        yield { type: "tool_call_start", toolCall: { id, name: "act" } };
        yield { type: "tool_call_delta", toolCallId: id, argumentsDelta: "{}" };
        yield { type: "finish", finishReason: "tool_calls", usage };
      },
    };
    const loop = new LLMLoop(
      provider,
      new ToolExecutor([defineTool({ name: "act", description: "act", parameters: z.object({}), execute })]),
      { maxToolRoundtrips, controlledExecution: true },
    );
    const transcript: ChatMessage[] = [];
    await expect(async () => {
      if (mode === "run") await loop.run([{ role: "user", content: "act" }], context(), undefined, transcript);
      else
        for await (const _chunk of loop.stream([{ role: "user", content: "act" }], context(), undefined, transcript)) {
          /* consume */
        }
    }).rejects.toThrow("budget exhausted");
    expect(execute).toHaveBeenCalledTimes(maxToolRoundtrips);
    expect(transcript.filter((m) => m.toolCalls?.length)).toHaveLength(maxToolRoundtrips);
    expect(transcript.filter((m) => m.role === "tool")).toHaveLength(maxToolRoundtrips);
  });
}

it("isolates observer mutation from model arguments, provider replay, and canonical results", async () => {
  const execute = vi
    .fn()
    .mockResolvedValue({ content: "original", artifacts: [{ type: "file", data: { marker: "original" } }] });
  const original = structuredClone(exchange[1]);
  let count = 0;
  const provider: ModelProvider = {
    providerId: "mock",
    modelId: "mock",
    async generate() {
      return count++ === 0
        ? { message: original, finishReason: "tool_calls", usage, raw: { output: original.providerExtras } }
        : { message: { role: "assistant", content: "done" }, finishReason: "stop", usage, raw: {} };
    },
    async *stream() {},
  };
  const middleware: HarnessMiddleware = {
    id: "observer",
    async afterModel(response) {
      if (response.message.toolCalls) response.message.toolCalls[0].name = "different";
      if ((response.raw as any).output) (response.raw as any).output.responsesReplay.items.length = 0;
    },
    async afterTool(result) {
      if (typeof result.result !== "string") {
        result.result.content = "mutated";
        (result.result.artifacts![0].data as any).marker = "mutated";
      }
    },
  };
  const tool = defineTool({ name: "lookup", description: "lookup", parameters: z.object({}), execute });
  const agent = new Agent({ name: "fixture", model: provider, tools: [tool], maxToolRoundtrips: 1, register: false });
  const runtime = new HarnessRuntime({
    driver: agentDriver(agent),
    grants: { toolIds: ["lookup"], modelRoles: ["main"] },
    definition: createHarnessDefinition({
      abilities: [
        {
          instanceId: "middleware",
          validate() {},
          describe: () => ({ toolNames: [], requirements: [] }),
          bind: async () => ({ tools: [], middleware: [middleware] }),
        },
      ],
    }),
  });
  const identity = { tenantId: "tenant", userId: "actor" };
  expect((await runtime.start("lookup", { identity, sessionId: "session" }).result()).status).toBe("completed");
  const lease = await runtime.sessions.acquire(identity, "session");
  const transcript = lease.read().history;
  lease.release();
  await agent.close();
  expect(execute).toHaveBeenCalledOnce();
  expect(original).toEqual(exchange[1]);
  expect(transcript.find((message) => message.role === "tool")?.content).toBe("original");
});

it.each([
  ["run", "run"],
  ["stream", "stream"],
  ["run", "stream"],
  ["stream", "run"],
] as const)("shares the harness tool budget across consecutive %s/%s calls", async (firstMode, secondMode) => {
  let round = 0;
  const execute = vi.fn().mockResolvedValue("done");
  const provider: ModelProvider = {
    providerId: "mock",
    modelId: "mock",
    async generate() {
      const current = round++;
      return current % 2 === 0
        ? {
            message: {
              role: "assistant",
              content: null,
              toolCalls: [{ id: `call-${current}`, name: "act", arguments: {} }],
            },
            finishReason: "tool_calls",
            usage,
            raw: {},
          }
        : { message: { role: "assistant", content: "draft" }, finishReason: "stop", usage, raw: {} };
    },
    async *stream() {
      const current = round++;
      if (current % 2 === 0) {
        yield { type: "tool_call_start", toolCall: { id: `call-${current}`, name: "act" } };
        yield { type: "tool_call_delta", toolCallId: `call-${current}`, argumentsDelta: "{}" };
        yield { type: "finish", finishReason: "tool_calls", usage };
      } else {
        yield { type: "text", text: "draft" };
        yield { type: "finish", finishReason: "stop", usage };
      }
    },
  };
  const loop = new LLMLoop(
    provider,
    new ToolExecutor([defineTool({ name: "act", description: "act", parameters: z.object({}), execute })]),
    { maxToolRoundtrips: 1, controlledExecution: true },
  );
  const transcript: ChatMessage[] = [];
  const invoke = async (mode: "run" | "stream") => {
    const messages: ChatMessage[] = [{ role: "user", content: "act" }];
    if (mode === "run") await loop.run(messages, context(), undefined, transcript);
    else
      for await (const _chunk of loop.stream(messages, context(), undefined, transcript)) {
        /* consume */
      }
  };
  await invoke(firstMode);
  expect(execute).toHaveBeenCalledOnce();
  await expect(invoke(secondMode)).rejects.toThrow("budget exhausted");
  expect(execute).toHaveBeenCalledOnce();
  expect(transcript.filter((message) => message.toolCalls?.length)).toHaveLength(1);
  expect(transcript.filter((message) => message.role === "tool")).toHaveLength(1);
});
