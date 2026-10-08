import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../../agent/agent.js";
import type { ModelProvider } from "../../models/provider.js";
import { OpenAIProvider } from "../../models/providers/openai.js";
import type { ModelResponse, StreamChunk } from "../../models/types.js";
import { HashEmbedding } from "../../vector/embeddings/hash.js";
import { InMemoryVectorStore } from "../../vector/in-memory.js";
import { VoicePipeline } from "../../voice/pipeline.js";
import { meteredGenerate } from "../accounting.js";
import type { RunCostSnapshot } from "../accounting-types.js";
import { withAccountingContext } from "../context.js";
import { CostTracker } from "../cost-tracker.js";
import { InMemoryUsageStore } from "../stores/in-memory.js";
import { fixtureCatalog, fixtureContext, fixtureUsage } from "./fixtures.js";

function response(): ModelResponse {
  return {
    message: { role: "assistant", content: "ok" },
    finishReason: "stop",
    raw: {},
    usage: {
      promptTokens: 15000,
      completionTokens: 500,
      totalTokens: 15500,
      accounting: { ...fixtureUsage(), context: fixtureContext },
    },
  };
}
function model(): ModelProvider {
  return {
    providerId: "fixture",
    modelId: "fixture-model",
    generate: vi.fn(async () => response()),
    async *stream() {
      yield { type: "text", text: "ok" };
      yield { type: "finish", finishReason: "stop", usage: response().usage };
    },
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Agent cost accounting DX", () => {
  it("enables accounting once and returns a typed snapshot without per-run wrappers", async () => {
    const agent = new Agent({ name: "example", model: model(), cost: { catalog: fixtureCatalog() }, register: false });
    const result = await agent.run("hello");
    expect(result.costs).toMatchObject({
      status: "available",
      total: "0.072",
      knownSubtotal: "0.072",
      attemptCount: 1,
    });
    if (result.costs?.status === "available") expect(result.costs.asOf).toBeTypeOf("string");
    await agent.close();
  });
  it.each([undefined, false])("leaves the optional snapshot absent when cost=%s", async (cost) => {
    const agent = new Agent({ name: "disabled", model: model(), cost, register: false });
    expect((await agent.run("hello")).costs).toBeUndefined();
    await agent.close();
  });
  it("cost:true keeps unknown prices visibly unknown", async () => {
    const agent = new Agent({ name: "unknown", model: model(), cost: true, register: false });
    expect((await agent.run("hello")).costs).toMatchObject({
      status: "available",
      total: null,
      pricingStatus: "unpriced",
    });
    await agent.close();
  });
  it("rejects conflicting configuration and does not close a borrowed tracker", async () => {
    const tracker = new CostTracker({ catalog: fixtureCatalog() });
    expect(() => new Agent({ name: "conflict", model: model(), cost: true, costTracker: tracker })).toThrow(
      "either cost or costTracker",
    );
    const close = vi.spyOn(tracker, "close");
    const flush = vi.spyOn(tracker, "flush");
    const agent = new Agent({ name: "borrowed", model: model(), costTracker: tracker, register: false });
    expect((await agent.run("hello")).costs?.total).toBe("0.072");
    await agent.close();
    expect(close).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });
  it("closes an owned tracker without closing its borrowed store", async () => {
    const store = new InMemoryUsageStore();
    const closeStore = vi.spyOn(store, "close");
    const closeTracker = vi.spyOn(CostTracker.prototype, "close");
    const agent = new Agent({
      name: "owned",
      model: model(),
      cost: { store, catalog: fixtureCatalog() },
      register: false,
    });
    await agent.run("hello");
    await agent.close();
    expect(closeTracker).toHaveBeenCalledTimes(1);
    expect(closeStore).not.toHaveBeenCalled();
  });
  it("close waits for active owned accounting", async () => {
    let started!: () => void;
    let release!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = model();
    provider.generate = async () => {
      started();
      await gate;
      return response();
    };
    const agent = new Agent({ name: "drain", model: provider, cost: { catalog: fixtureCatalog() }, register: false });
    const run = agent.run("hello");
    await began;
    let closed = false;
    const close = agent.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    expect((await run).costs?.total).toBe("0.072");
    await close;
    expect(closed).toBe(true);
  });
  it("close also waits through a hook gap before later metered work", async () => {
    let reached!: () => void;
    let release!: () => void;
    const began = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = model();
    const agent = new Agent({
      name: "hook-gap",
      model: provider,
      cost: { catalog: fixtureCatalog() },
      register: false,
      hooks: {
        afterRun: async () => {
          reached();
          await gate;
          await meteredGenerate(provider, []);
        },
      },
    });
    const run = agent.run("hello");
    await began;
    let closed = false;
    const close = agent.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    expect((await run).costs?.total).toBe("0.144");
    await close;
    expect(closed).toBe(true);
  });
  it("does not wait for unrelated work on a shared tracker", async () => {
    const tracker = new CostTracker({ catalog: fixtureCatalog() });
    tracker.beginPendingAttempt("unrelated-work");
    const agent = new Agent({ name: "scoped", model: model(), costTracker: tracker, register: false });
    expect((await agent.run("hello")).costs?.total).toBe("0.072");
    await agent.close();
    tracker.endPendingAttempt("unrelated-work");
    await tracker.close();
  });
  it("cost:false inherits parent accounting and cannot bypass its budget", async () => {
    const tracker = new CostTracker({
      catalog: fixtureCatalog(),
      budget: {
        mode: "threshold",
        limits: [
          {
            scope: "tenant",
            amount: "0",
            currency: "USD",
            period: { start: "2020-01-01T00:00:00Z", end: "2099-01-01T00:00:00Z" },
          },
        ],
      },
    });
    const provider = model();
    const child = new Agent({ name: "child", model: provider, cost: false, register: false });
    await expect(
      withAccountingContext({ tracker, tenantId: "tenant", runId: "parent" }, () => child.run("hello")),
    ).rejects.toThrow("Cost budget blocked");
    expect(provider.generate).not.toHaveBeenCalled();
    await child.close();
  });
  it("returns zero new model cost on a semantic cache hit", async () => {
    const provider = model();
    const store = new InMemoryUsageStore();
    const agent = new Agent({
      name: "cache",
      model: provider,
      cost: { catalog: fixtureCatalog(), store },
      register: false,
      semanticCache: { vectorStore: new InMemoryVectorStore(), embedding: new HashEmbedding() },
    });
    const first = await agent.run("same input", { sessionId: "first-session", userId: "first-user" });
    expect(first.costs?.total).toBe("0.072");
    const hit = await agent.run("same input", { sessionId: "next-session", userId: "next-user" });
    expect(hit.runId).not.toBe(first.runId);
    expect(hit.sessionId).toBe("next-session");
    expect(hit.userId).toBe("next-user");
    expect(hit.usage.totalTokens).toBe(0);
    expect(hit.metrics?.totalTokens).toBe(0);
    expect(first.costs?.total).toBe("0.072");
    expect(hit.costs).toMatchObject({ status: "available", total: "0", attemptCount: 0 });
    expect((await store.queryCosts({ runId: first.runId })).total).toBe("0.072");
    expect((await store.queryCosts({ runId: hit.runId })).total).toBe("0");
    expect(provider.generate).toHaveBeenCalledTimes(1);
    const streamed: StreamChunk[] = [];
    for await (const chunk of agent.stream("same input")) streamed.push(chunk);
    expect(streamed.at(-1)).toMatchObject({ type: "finish", usage: { totalTokens: 0 }, costs: { total: "0" } });
    await agent.close();
  });
  it("puts the settled snapshot on the terminal stream finish", async () => {
    const agent = new Agent({ name: "stream", model: model(), cost: { catalog: fixtureCatalog() }, register: false });
    const chunks: StreamChunk[] = [];
    for await (const chunk of agent.stream("hello")) chunks.push(chunk);
    expect(chunks.at(-1)).toMatchObject({
      type: "finish",
      costs: { status: "available", total: "0.072", finality: "final" },
    });
    await agent.close();
  });
  it("retains usage and exposes a cost snapshot on stream cancellation", async () => {
    const provider = model();
    provider.stream = async function* () {
      yield { type: "finish", finishReason: "stop", usage: response().usage };
      yield { type: "text", text: "later" };
    };
    const agent = new Agent({ name: "cancel", model: provider, cost: { catalog: fixtureCatalog() }, register: false });
    let costs: RunCostSnapshot | undefined;
    agent.events.on("run.cancelled", (event) => {
      costs = event.costs;
    });
    for await (const _ of agent.stream("hello")) break;
    expect(costs).toMatchObject({ status: "available", knownSubtotal: "0.072" });
    await agent.close();
  });
  it("returns unavailable cost state when the ledger cannot be read, without retrying the model", async () => {
    const tracker = new CostTracker({ catalog: fixtureCatalog(), currency: "EUR" });
    vi.spyOn(tracker, "queryCosts").mockRejectedValue(new Error("store read failed"));
    const provider = model();
    const agent = new Agent({ name: "storage", model: provider, costTracker: tracker, register: false });
    const result = await agent.run("hello");
    expect(result.text).toBe("ok");
    expect(result.costs).toEqual({
      status: "unavailable",
      currency: "EUR",
      total: null,
      knownSubtotal: null,
      reason: "accounting_unavailable",
    });
    expect(provider.generate).toHaveBeenCalledTimes(1);
    await agent.close();
  });
});

describe("native Agent billing context", () => {
  function native(tier?: string) {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "fixture",
            model: "gpt-6.1-sol",
            ...(tier ? { service_tier: tier } : {}),
            choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
            usage: {
              prompt_tokens: 19,
              completion_tokens: 16,
              total_tokens: 35,
              prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
              completion_tokens_details: { reasoning_tokens: 9 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    return { provider: new OpenAIProvider("gpt-6.1-sol", { apiKey: "fixture-not-a-secret" }), fetch };
  }
  it("uses explicit host tier and region while retaining provider identity", async () => {
    const { provider } = native();
    const tracker = new CostTracker();
    const agent = new Agent({
      name: "native",
      model: provider,
      costTracker: tracker,
      billingContext: { actualServiceTier: "standard", region: "global" },
      register: false,
    });
    const result = await agent.run("hello");
    expect(result.costs?.total).toBe("0.000198");
    const record = (await tracker.queryUsage({ runId: result.runId })).items.find(
      (item) => item.executionStatus === "succeeded",
    );
    expect(record?.context).toMatchObject({
      providerId: "openai",
      billingProviderId: "openai",
      actualServiceTier: "standard",
      region: "global",
      provenance: { actualServiceTier: "configured_contract" },
    });
    await agent.close();
  });
  it("keeps missing tier unpriced and lets response facts override host defaults", async () => {
    const { provider } = native();
    const unknown = new Agent({ name: "missing", model: provider, cost: true, register: false });
    expect((await unknown.run("hello")).costs?.total).toBeNull();
    await unknown.close();
    const second = native("flex");
    const tracker = new CostTracker();
    const output = await withAccountingContext({ tracker }, () =>
      meteredGenerate(second.provider, [{ role: "user", content: "hello" }], {
        billingContext: { actualServiceTier: "standard", region: "global" },
      }),
    );
    expect(output.usage.accounting?.context?.actualServiceTier).toBe("flex");
    expect((await tracker.queryCosts()).total).toBe("0.000099");
  });
  it("rejects forged billing identity before provider dispatch", async () => {
    const { provider, fetch } = native();
    const invalid = { region: "global", providerId: "cheaper-biller" };
    const agent = new Agent({ name: "invalid", model: provider, cost: true, billingContext: invalid, register: false });
    await expect(agent.run("hello")).rejects.toThrow("Invalid model billingContext");
    expect(fetch).not.toHaveBeenCalled();
    await agent.close();
  });
});

describe("file voice pipeline accounting", () => {
  it("records all three paid steps without storing transcript or uploaded audio", async () => {
    const tracker = new CostTracker({ catalog: fixtureCatalog() });
    const pipeline = new VoicePipeline({
      llm: model(),
      apiKey: "fixture-not-a-secret",
      accounting: { tracker, tenantId: "voice", runId: "turn" },
      fetch: vi.fn(async (url) =>
        String(url).endsWith("/audio/transcriptions")
          ? new Response(JSON.stringify({ text: "private transcript", usage: { seconds: 3 } }), { status: 200 })
          : new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
      ),
    });
    expect((await pipeline.turn(Buffer.from([1, 2, 3]))).reply).toBe("ok");
    const records = (await tracker.queryUsage({ tenantId: "voice", runId: "turn" })).items.filter(
      (item) => item.executionStatus === "succeeded",
    );
    expect(records.map((item) => item.purpose).sort()).toEqual([
      "file-speech",
      "file-transcription",
      "voice-pipeline-answer",
    ]);
    expect(JSON.stringify(records)).not.toContain("private transcript");
    expect(records.find((item) => item.purpose === "file-transcription")?.usage.rawUsage).toEqual({ seconds: 3 });
    expect(records.find((item) => item.purpose === "file-speech")?.usage.measurements[0].quantity).toBe("2");
    expect((await tracker.queryCosts({ tenantId: "voice", runId: "turn" })).total).toBeNull();
    await tracker.close();
  });
});
