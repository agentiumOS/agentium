import type { ModelProvider, StreamChunk } from "@agentium/core";
import { describe, expect, it } from "vitest";
import { agentDriver, HarnessRuntime } from "../index.js";

const start = { identity: { tenantId: "t", userId: "u" }, sessionId: "s" };
const usage = { promptTokens: 2, completionTokens: 3, totalTokens: 5 };

describe("Agent adapter outcome evidence", () => {
  it.each([false, true])("preserves a length-limited candidate, stream=%s", async (stream) => {
    const provider: ModelProvider = {
      providerId: "fixture",
      modelId: "fixture",
      async generate() {
        return {
          message: { role: "assistant", content: "Unfinished candidate" },
          usage,
          finishReason: "length",
          raw: {},
        };
      },
      async *stream(): AsyncGenerator<StreamChunk> {
        yield { type: "text", text: "Unfinished candidate" };
        yield { type: "finish", finishReason: "length", usage };
      },
    };
    const result = await new HarnessRuntime({
      driver: agentDriver({ name: "length", model: provider }, { stream }),
      grants: { toolIds: [], modelRoles: ["main"] },
    }).run("Work", start);
    expect(result).toMatchObject({
      status: "stopped",
      text: "Unfinished candidate",
      partial: true,
      providerFinishReason: "length",
      usage,
    });
    expect(result.reason?.code).toBe("provider_length");
  });

  it("retains streamed text when a provider omits terminal usage", async () => {
    const provider: ModelProvider = {
      providerId: "fixture",
      modelId: "fixture",
      async generate() {
        throw new Error("unused");
      },
      async *stream(): AsyncGenerator<StreamChunk> {
        yield { type: "text", text: "Partial evidence" };
      },
    };
    const result = await new HarnessRuntime({
      driver: agentDriver({ name: "incomplete", model: provider }, { stream: true }),
      grants: { toolIds: [], modelRoles: ["main"] },
      budgets: { maxTokens: 100 },
    }).run("Work", start);
    expect(result).toMatchObject({
      status: "failed",
      text: "Partial evidence",
      partial: true,
      reason: { code: "incomplete_stream" },
    });
    expect(result.budget?.unknownUsageCalls).toBe(1);
  });
});
