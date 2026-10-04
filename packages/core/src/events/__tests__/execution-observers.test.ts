import { expect, it, vi } from "vitest";
import { z } from "zod/v3";
import { Agent } from "../../agent/agent.js";
import type { ModelProvider } from "../../models/provider.js";
import type { ModelResponse, StreamChunk } from "../../models/types.js";
import { defineTool } from "../../tools/define-tool.js";
import { EventBus } from "../event-bus.js";

const usage = { promptTokens: 2, completionTokens: 1, totalTokens: 3 };
it.each([false, true])(
  "observer failures preserve real tool effects and model result (stream=%s)",
  async (streaming) => {
    let effects = 0,
      calls = 0;
    const bus = new EventBus();
    const starts: any[] = [];
    const ends: any[] = [];
    const results: any[] = [];
    bus.onAny(async () => {
      throw new Error("broken async exporter");
    });
    for (const event of [
      "run.start",
      "run.complete",
      "model.start",
      "model.result",
      "tool.call",
      "tool.result",
    ] as const)
      bus.on(event, () => {
        throw new Error("broken observer");
      });
    bus.on("model.start", (event) => {
      starts.push(event);
    });
    bus.on("model.result", (event) => {
      ends.push(event);
    });
    bus.on("tool.result", (event) => {
      results.push(event);
    });
    const reply = (): ModelResponse =>
      ++calls === 1
        ? {
            message: { role: "assistant", content: null, toolCalls: [{ id: "effect", name: "effect", arguments: {} }] },
            raw: null,
            usage,
            finishReason: "tool_calls",
          }
        : { message: { role: "assistant", content: "finished" }, raw: null, usage, finishReason: "stop" };
    const model: ModelProvider = {
      providerId: "synthetic",
      modelId: "test",
      generate: async () => reply(),
      async *stream(): AsyncGenerator<StreamChunk> {
        const response = reply();
        if (response.finishReason === "tool_calls") {
          yield { type: "tool_call_start", toolCall: { id: "effect", name: "effect" } };
          yield { type: "tool_call_delta", toolCallId: "effect", argumentsDelta: "{}" };
        } else yield { type: "text", text: "finished" };
        yield { type: "finish", finishReason: response.finishReason, usage };
      },
    };
    const agent = new Agent({
      name: "observer-test",
      eventBus: bus,
      model,
      tools: [
        defineTool({
          name: "effect",
          description: "synthetic effect",
          parameters: z.object({}),
          execute: async () => {
            effects++;
            return "ok";
          },
        }),
      ],
    });
    try {
      if (streaming) {
        let text = "";
        for await (const chunk of agent.stream("input", { sessionId: "s", userId: "u", tenantId: "t" }))
          if (chunk.type === "text") text += chunk.text;
        expect(text).toBe("finished");
      } else expect((await agent.run("input", { sessionId: "s", userId: "u", tenantId: "t" })).text).toBe("finished");
      expect(effects).toBe(1);
      expect(calls).toBe(2);
      expect(starts).toHaveLength(2);
      expect(ends.map((e) => e.modelCallId)).toEqual(starts.map((e) => e.modelCallId));
      expect(results[0]).toMatchObject({ toolCallId: "effect", status: "success" });
    } finally {
      await agent.close();
    }
  },
);

it("preserves explicit control hook failure independently from observer failure", async () => {
  const generate = vi.fn();
  const agent = new Agent({
    name: "control-hook",
    model: { providerId: "test", modelId: "test", generate, stream: vi.fn() },
    loopHooks: {
      beforeLLMCall: () => {
        throw new Error("control stopped");
      },
    },
  });
  agent.eventBus.on("run.error", () => {
    throw new Error("observer failed");
  });
  try {
    await expect(agent.run("input")).rejects.toThrow("control stopped");
    expect(generate).not.toHaveBeenCalled();
  } finally {
    await agent.close();
  }
});

it("stream cancellation emits explicit terminal status even with a custom abort reason", async () => {
  const controller = new AbortController();
  const errors: any[] = [];
  const agent = new Agent({
    name: "cancel-observed",
    model: {
      providerId: "test",
      modelId: "test",
      generate: vi.fn(),
      async *stream() {
        yield { type: "text", text: "partial" } as const;
        controller.abort(new Error("custom cancellation"));
        throw controller.signal.reason;
      },
    },
  });
  agent.eventBus.on("run.error", (event) => {
    errors.push(event);
  });
  try {
    await expect(
      (async () => {
        for await (const _chunk of agent.stream("input", { signal: controller.signal })) {
          /* consume */
        }
      })(),
    ).rejects.toThrow("custom cancellation");
    expect(errors).toHaveLength(1);
    expect(errors[0].status).toBe("cancelled");
  } finally {
    await agent.close();
  }
});
