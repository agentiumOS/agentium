import { describe, expect, it } from "vitest";
import { ModelRegistry } from "../registry.js";

describe("ModelRegistry", () => {
  it("registers and resolves providers", () => {
    const reg = new ModelRegistry();
    reg.register("test", (_id: string, _cfg?: any) => ({
      providerId: "test",
      modelId: _id,
      generate: async () => ({
        message: { role: "assistant" as const, content: "ok" },
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: "stop" as const,
      }),
      stream: async function* () {},
    }));

    const provider = reg.resolve("test", "test-model");
    expect(provider.providerId).toBe("test");
    expect(provider.modelId).toBe("test-model");
    expect(reg.has("test")).toBe(true);
  });

  it("throws for unregistered provider", () => {
    const reg = new ModelRegistry();
    expect(() => reg.resolve("unknown", "model")).toThrow(/unknown/i);
  });
});
