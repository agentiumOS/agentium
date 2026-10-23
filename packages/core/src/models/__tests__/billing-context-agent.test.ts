import { beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../../agent/agent.js";
import { CostTracker } from "../../cost/cost-tracker.js";
import type { ModelProvider } from "../provider.js";
import { CohereProvider } from "../providers/cohere.js";
import { GoogleProvider } from "../providers/google.js";
import { MistralProvider } from "../providers/mistral.js";

const native = vi.hoisted(() => ({
  google: vi.fn<(params: Record<string, unknown>) => Promise<unknown>>(),
  googleStream: vi.fn<(params: Record<string, unknown>) => Promise<AsyncIterable<unknown>>>(),
  cohere: vi.fn<(params: Record<string, unknown>) => Promise<unknown>>(),
  mistral: vi.fn<(params: Record<string, unknown>) => Promise<unknown>>(),
}));
vi.mock("node:module", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:module")>();
  return {
    ...original,
    createRequire: (filename: string | URL) => {
      const require = original.createRequire(filename);
      const mocked = (id: string) => {
        if (id === "@google/genai")
          return {
            GoogleGenAI: class {
              models = { generateContent: native.google, generateContentStream: native.googleStream };
            },
          };
        if (id === "cohere-ai")
          return {
            CohereClientV2: class {
              chat = native.cohere;
            },
          };
        if (id === "@mistralai/mistralai")
          return {
            Mistral: class {
              chat = { complete: native.mistral };
            },
          };
        return require(id);
      };
      return Object.assign(mocked, require);
    },
  };
});

beforeEach(() => {
  native.googleStream.mockReset();
  native.google.mockReset().mockResolvedValue({
    modelVersion: "gemini-3.8-flash",
    candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    usageMetadata: {
      promptTokenCount: 1000,
      cachedContentTokenCount: 800,
      candidatesTokenCount: 100,
      thoughtsTokenCount: 20,
      totalTokenCount: 1120,
    },
  });
  native.cohere.mockReset().mockResolvedValue({
    model: "command-a-03-2025",
    message: { content: [{ text: "ok" }] },
    finishReason: "COMPLETE",
    usage: { tokens: { inputTokens: 71, outputTokens: 20 }, billedUnits: { inputTokens: 5, outputTokens: 10 } },
  });
  native.mistral.mockReset().mockResolvedValue({
    model: "mistral-small-2603",
    choices: [{ message: { content: "ok" }, finishReason: "stop" }],
    usage: { promptTokens: 1013, completionTokens: 30, totalTokens: 1043, promptTokensDetails: { cachedTokens: 1008 } },
  });
});
const providers: Array<{
  name: string;
  create: () => ModelProvider;
  amount: string;
  dimensions: Record<string, string>;
}> = [
  {
    name: "Google",
    create: () => new GoogleProvider("gemini-3.8-flash", { apiKey: "fixture-only" }),
    amount: "0.00066",
    dimensions: { pricePlan: "paid" },
  },
  {
    name: "Cohere",
    create: () => new CohereProvider("command-a-03-2025", { apiKey: "fixture-only" }),
    amount: "0.0001125",
    dimensions: { pricePlan: "paid", modality: "text" },
  },
  {
    name: "Mistral",
    create: () => new MistralProvider("mistral-small-2603", { apiKey: "fixture-only" }),
    amount: "0.00003387",
    dimensions: { pricePlan: "paid" },
  },
];

describe("native Agent billing context", () => {
  it.each(["generate", "stream"])("retains requested and returned Google models through Agent %s", async (mode) => {
    native.googleStream.mockResolvedValue(
      (async function* () {
        yield {
          modelVersion: "gemini-3.8-flash",
          responseId: "served-42",
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
        };
        yield {
          usageMetadata: {
            promptTokenCount: 1000,
            cachedContentTokenCount: 800,
            candidatesTokenCount: 100,
            thoughtsTokenCount: 20,
            totalTokenCount: 1120,
          },
        };
      })(),
    );
    const tracker = new CostTracker();
    const agent = new Agent({
      name: "returned-model",
      model: new GoogleProvider("gemini-retired-request", { apiKey: "fixture-only" }),
      register: false,
      costTracker: tracker,
      billingContext: { actualServiceTier: "standard", region: "global", dimensions: { pricePlan: "paid" } },
    });
    try {
      if (mode === "stream") {
        let text = "";
        for await (const chunk of agent.stream("hello", { tenantId: "google-identity", runId: "run" })) {
          if (chunk.type === "text") text += chunk.text;
        }
        expect(text).toBe("ok");
      } else await agent.run("hello", { tenantId: "google-identity", runId: "run" });
      const records = (await tracker.queryUsage({ tenantId: "google-identity", runId: "run" })).items.filter(
        (item) => item.executionStatus === "succeeded",
      );
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        executionStatus: "succeeded",
        context: {
          requestedModelId: "gemini-retired-request",
          modelId: "gemini-3.8-flash",
          provenance: { modelId: "response" },
        },
        usage: { tokens: { total: 1120 } },
      });
    } finally {
      await agent.close();
    }
  });

  it.each(providers)("prices $name native usage with explicit host facts", async ({ create, amount, dimensions }) => {
    const agent = new Agent({
      name: "native-paid",
      model: create(),
      register: false,
      cost: true,
      billingContext: { actualServiceTier: "standard", region: "global", dimensions },
    });
    try {
      const result = await agent.run("hello");
      expect(result.costs).toMatchObject({
        status: "available",
        total: amount,
        pricingStatus: "complete",
        attemptCount: 1,
      });
      // Billing metadata is consumed locally and does not configure the remote request.
      for (const call of [...native.google.mock.calls, ...native.cohere.mock.calls, ...native.mistral.mock.calls]) {
        expect(call[0]).not.toHaveProperty("billingContext");
        expect(call[0]).not.toHaveProperty("actualServiceTier");
        expect(call[0]).not.toHaveProperty("pricePlan");
      }
    } finally {
      await agent.close();
    }
  });
  it.each(providers)("keeps $name unpriced when host account context is absent", async ({ create }) => {
    const agent = new Agent({ name: "native-unknown", model: create(), register: false, cost: true });
    try {
      expect((await agent.run("hello")).costs?.total).toBeNull();
    } finally {
      await agent.close();
    }
  });
  it("does not infer a zero charge for a declared free account", async () => {
    const agent = new Agent({
      name: "native-free",
      model: providers[0].create(),
      register: false,
      cost: true,
      billingContext: { actualServiceTier: "standard", region: "global", dimensions: { pricePlan: "free" } },
    });
    try {
      expect((await agent.run("hello")).costs?.total).toBeNull();
    } finally {
      await agent.close();
    }
  });
});
