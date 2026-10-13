import { describe, expect, it, vi } from "vitest";
import type { ModelProvider } from "../../models/provider.js";
import { Agent } from "../agent.js";

describe("reflection candidate outcomes", () => {
  it.each(["length", "content_filter"] as const)("does not accept or critique a %s revision", async (finishReason) => {
    let calls = 0;
    const model: ModelProvider = {
      providerId: "fixture",
      modelId: "fixture",
      generate: vi.fn<ModelProvider["generate"]>(async () => ({
        message: { role: "assistant", content: calls++ ? "Unfinished revision" : "Draft" },
        finishReason: calls === 1 ? "stop" : finishReason,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        raw: {},
      })),
      async *stream() {},
    };
    const critic: ModelProvider = {
      providerId: "fixture",
      modelId: "critic",
      generate: vi.fn<ModelProvider["generate"]>(async () => ({
        message: { role: "assistant", content: '{"pass":false,"score":0,"feedback":"Needs revision"}' },
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        raw: {},
      })),
      async *stream() {},
    };
    const agent = new Agent({
      name: "reflection-outcome",
      model,
      reflection: { enabled: true, critic, maxReflections: 2 },
      register: false,
    });
    const output = await agent.run("Work");
    expect(output).toMatchObject({
      text: "Unfinished revision",
      status: "stopped",
      partial: true,
      providerFinishReason: finishReason,
      reason: { code: `provider_${finishReason}` },
      usage: { totalTokens: 4 },
    });
    expect(model.generate).toHaveBeenCalledTimes(2);
    expect(critic.generate).toHaveBeenCalledTimes(1);
    expect(output.publicMessages?.filter((message) => message.phase === "final").at(-1)?.text).toBe(
      "Unfinished revision",
    );
    await agent.close();
  });
});
