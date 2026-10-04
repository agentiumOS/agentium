import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";
import { EventBus } from "../../events/event-bus.js";
import { generateOpenAIStyle, normalizeResponsesResponse, streamOpenAIStyle } from "../../models/openai-api.js";
import type { ModelProvider } from "../../models/provider.js";
import type { ChatMessage, StreamChunk } from "../../models/types.js";
import { InMemoryStorage } from "../../storage/in-memory.js";
import { defineTool } from "../../tools/define-tool.js";
import { ToolExecutor } from "../../tools/tool-executor.js";
import { Agent } from "../agent.js";
import { LLMLoop } from "../llm-loop.js";
import { RunContext } from "../run-context.js";

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const callOutput = [
  { type: "reasoning", id: "r1", summary: [], encrypted_content: "opaque-1" },
  { type: "function_call", id: "f1", call_id: "c1", name: "lookup", arguments: '{"q":"x"}' },
];
const finalOutput = [
  { type: "reasoning", id: "r2", summary: [], encrypted_content: "opaque-2" },
  { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
];

for (const mode of ["run", "stream"] as const) {
  for (const storagePath of ["memory", "fallback"] as const) {
    it(`persists canonical ${mode} tool and non-tool continuations through ${storagePath} sessions`, async () => {
      const requests: any[] = [];
      let count = 0;
      const execute = vi.fn().mockResolvedValue("found");
      const tool = defineTool({
        name: "lookup",
        description: "lookup",
        parameters: z.object({ q: z.string() }),
        execute,
      });
      const client = {
        responses: {
          create: async (params: any) => {
            requests.push(JSON.parse(JSON.stringify(params)));
            const output = count++ === 0 ? callOutput : finalOutput;
            if (!params.stream) return { output, status: "completed" };
            return (async function* () {
              if (output === callOutput) {
                yield { type: "response.output_item.added", item: { ...callOutput[1], arguments: "" } };
                yield { type: "response.function_call_arguments.delta", item_id: "f1", delta: '{"q":"x"}' };
                yield { type: "response.output_item.done", item: callOutput[1] };
              } else {
                yield { type: "response.output_text.delta", delta: "answer" };
              }
              yield { type: "response.completed", response: { output, status: "completed" } };
            })();
          },
        },
      };
      const model: ModelProvider = {
        providerId: "openai",
        modelId: "gpt-6",
        generate: (messages, options) => generateOpenAIStyle(client, "gpt-6", messages, options),
        stream: (messages, options) => streamOpenAIStyle(client, "gpt-6", messages, options),
      };
      // InMemoryStorage performs JSON stringify/parse on every write/read.
      const storage = new InMemoryStorage();
      const config = {
        name: `continuation-${mode}-${storagePath}`,
        register: false,
        model,
        tools: [tool],
        ...(storagePath === "memory" ? { memory: { storage, summaries: false } } : {}),
      };
      let agent = new Agent(config);
      const invoke = async (input: string) => {
        if (mode === "run") await agent.run(input, { sessionId: "conversation" });
        else
          for await (const _chunk of agent.stream(input, { sessionId: "conversation" })) {
            /* consume */
          }
      };
      await invoke("first");
      if (storagePath === "memory") agent = new Agent(config);
      await invoke("second");
      expect(execute).toHaveBeenCalledOnce();
      expect(requests[1].input).toEqual([
        { role: "user", content: "first" },
        ...callOutput,
        { type: "function_call_output", call_id: "c1", output: "found" },
      ]);
      expect(requests[2].input).toEqual([
        { role: "user", content: "first" },
        ...callOutput,
        { type: "function_call_output", call_id: "c1", output: "found" },
        ...finalOutput,
        { role: "user", content: "second" },
      ]);
    });
  }
}

describe("loop continuation boundaries", () => {
  const ctx = () => new RunContext({ sessionId: "s", eventBus: new EventBus() });
  it.each(["malformed", "interrupted", "unterminated"])("executes no tool on a %s stream", async (kind) => {
    const execute = vi.fn().mockResolvedValue("effect");
    const tool = defineTool({ name: "write", description: "write", parameters: z.object({}), execute });
    const provider: ModelProvider = {
      providerId: "mock",
      modelId: "mock",
      generate: vi.fn(),
      async *stream() {
        yield { type: "tool_call_start", toolCall: { id: "a", name: "write" } };
        yield { type: "tool_call_delta", toolCallId: "a", argumentsDelta: kind === "malformed" ? "{" : "{}" };
        if (kind === "interrupted") throw new Error("connection lost");
        if (kind !== "unterminated") yield { type: "finish", finishReason: "tool_calls" };
      },
    };
    const loop = new LLMLoop(provider, new ToolExecutor([tool]), { maxToolRoundtrips: 1 });
    await expect(async () => {
      for await (const _chunk of loop.stream([], ctx())) {
        /* consume */
      }
    }).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["run", "stream"] as const)(
    "keeps %s canonical exchanges separate from request compaction and preserves options",
    async (mode) => {
      const execute = vi.fn().mockResolvedValue("found");
      const tool = defineTool({ name: "lookup", description: "lookup", parameters: z.object({}), execute });
      let n = 0;
      const seen: any[] = [];
      const responses: ChatMessage[] = [
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "a", name: "lookup", arguments: {} }],
          providerExtras: { retained: 1 },
        },
        { role: "assistant", content: "done", providerExtras: { retained: 2 } },
      ];
      const provider: ModelProvider = {
        providerId: "mock",
        modelId: "mock",
        async generate(messages, options) {
          seen.push({ messages: [...messages], options });
          const message = responses[n++];
          return { message, usage, raw: {}, finishReason: message.toolCalls ? "tool_calls" : "stop" };
        },
        async *stream(messages, options): AsyncGenerator<StreamChunk> {
          seen.push({ messages: [...messages], options });
          const message = responses[n++];
          if (message.toolCalls) {
            yield { type: "tool_call_start", toolCall: { id: "a", name: "lookup" } };
            yield { type: "tool_call_delta", toolCallId: "a", argumentsDelta: "{}" };
          } else yield { type: "text", text: "done" };
          yield {
            type: "finish",
            finishReason: message.toolCalls ? "tool_calls" : "stop",
            usage,
            providerExtras: message.providerExtras,
          };
        },
      };
      const options = {
        maxToolRoundtrips: 1,
        reasoning: { enabled: true, effort: "high" as const },
        providerOptions: { promptCache: true },
        loopHooks: {
          beforeLLMCall: async (_messages: ChatMessage[], round: number) =>
            round === 1 ? [{ role: "user" as const, content: "compacted view" }] : _messages,
        },
      };
      const loop = new LLMLoop(provider, new ToolExecutor([tool]), options);
      const transcript: ChatMessage[] = [];
      if (mode === "run") await loop.run([{ role: "user", content: "question" }], ctx(), undefined, transcript);
      else
        for await (const _chunk of loop.stream([{ role: "user", content: "question" }], ctx(), undefined, transcript)) {
          /* consume */
        }
      expect(transcript).toEqual([
        responses[0],
        { role: "tool", content: "found", toolCallId: "a", name: "lookup" },
        responses[1],
      ]);
      expect(seen[0].messages).toEqual([{ role: "user", content: "question" }]);
      expect(seen[1].messages).toEqual([{ role: "user", content: "compacted view" }]);
      expect(seen[0].options).toMatchObject({ reasoning: options.reasoning, providerOptions: options.providerOptions });
      expect(seen[1].options).toEqual(seen[0].options);
    },
  );
});

describe("incomplete terminal tool turns", () => {
  for (const mode of ["run", "stream"] as const) {
    it.each(["length", "stop"] as const)(
      `rejects ${mode} tool calls with %s status without persisting or executing them`,
      async (reason) => {
        const execute = vi.fn().mockResolvedValue("effect");
        const tool = defineTool({ name: "write", description: "write", parameters: z.object({}), execute });
        const provider: ModelProvider = {
          providerId: "mock",
          modelId: "mock",
          async generate() {
            return {
              message: { role: "assistant", content: null, toolCalls: [{ id: "a", name: "write", arguments: {} }] },
              usage,
              raw: {},
              finishReason: reason,
            };
          },
          async *stream() {
            yield { type: "tool_call_start", toolCall: { id: "a", name: "write" } };
            yield { type: "tool_call_delta", toolCallId: "a", argumentsDelta: "{}" };
            yield { type: "finish", finishReason: reason };
          },
        };
        const loop = new LLMLoop(provider, new ToolExecutor([tool]), { maxToolRoundtrips: 1 });
        const ctx = new RunContext({ sessionId: "s", eventBus: new EventBus() });
        const transcript: ChatMessage[] = [];
        await expect(async () => {
          if (mode === "run") await loop.run([], ctx, undefined, transcript);
          else
            for await (const _chunk of loop.stream([], ctx, undefined, transcript)) {
              /* consume */
            }
        }).rejects.toThrow("Incomplete");
        expect(transcript).toEqual([]);
        expect(execute).not.toHaveBeenCalled();
      },
    );
  }
});

it("preserves tool exchanges and non-tool reasoning across reflection and the next user turn", async () => {
  const requests: ChatMessage[][] = [];
  const revisedOutput = [
    { type: "reasoning", id: "r3", summary: [], encrypted_content: "revision" },
    { type: "message", id: "m2", role: "assistant", content: [{ type: "output_text", text: "revised" }] },
  ];
  const outputs = [callOutput, finalOutput, revisedOutput, revisedOutput];
  const execute = vi.fn().mockResolvedValue("found");
  const model: ModelProvider = {
    providerId: "openai",
    modelId: "gpt-6",
    async generate(messages) {
      requests.push(JSON.parse(JSON.stringify(messages)));
      return normalizeResponsesResponse({ output: outputs[requests.length - 1] });
    },
    async *stream() {},
  };
  let critiques = 0;
  const critic: ModelProvider = {
    providerId: "critic",
    modelId: "critic",
    async generate() {
      return {
        message: {
          role: "assistant",
          content: JSON.stringify({ pass: critiques++ > 0, score: 1, feedback: "revise" }),
        },
        usage,
        finishReason: "stop",
        raw: {},
      };
    },
    async *stream() {},
  };
  const agent = new Agent({
    name: "reflection-continuation",
    register: false,
    model,
    tools: [defineTool({ name: "lookup", description: "lookup", parameters: z.object({ q: z.string() }), execute })],
    reflection: { enabled: true, maxReflections: 1, critic },
  });
  await agent.run("first", { sessionId: "same" });
  await agent.run("second", { sessionId: "same" });
  const revisionHistory = requests[2].filter((message) => message.role !== "system");
  expect(revisionHistory.slice(0, 4)).toEqual([
    { role: "user", content: "first" },
    normalizeResponsesResponse({ output: callOutput }).message,
    { role: "tool", toolCallId: "c1", name: "lookup", content: "found" },
    normalizeResponsesResponse({ output: finalOutput }).message,
  ]);
  expect(requests[3].filter((message) => message.role !== "system")).toEqual([
    ...revisionHistory,
    normalizeResponsesResponse({ output: revisedOutput }).message,
    { role: "user", content: "second" },
  ]);
  expect(execute).toHaveBeenCalledOnce();
});
