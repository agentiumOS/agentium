import { describe, expect, it, vi } from "vitest";
import { Agent } from "../../agent/agent.js";
import { ReflectionManager } from "../../agent/reflection.js";
import { CompressionManager } from "../../compression/compression-manager.js";
import { ContextCompactor } from "../../context/context-compactor.js";
import { EventBus } from "../../events/event-bus.js";
import { Summaries } from "../../memory/stores/summaries.js";
import { FallbackProvider } from "../../models/fallback-provider.js";
import type { ModelProvider } from "../../models/provider.js";
import type { ModelResponse } from "../../models/types.js";
import { providerTokenUsage } from "../../models/usage-normalizers.js";
import { InMemoryStorage } from "../../storage/in-memory.js";
import { Team } from "../../team/team.js";
import { TeamMode } from "../../team/types.js";
import { Workflow } from "../../workflow/workflow.js";
import { meteredGenerate, meteredOperation, meteredStream } from "../accounting.js";
import type { UsageRecordInput } from "../accounting-types.js";
import { captureRetryFailure, captureUsage, withAccountingContext, withAccountingStream } from "../context.js";
import { CostTracker } from "../cost-tracker.js";
import { fixtureCatalog, fixtureContext, fixtureUsage } from "./fixtures.js";

const usage = (output = 16) =>
  providerTokenUsage("openai", "responses", {
    input_tokens: 19,
    output_tokens: output,
    total_tokens: 19 + output,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 9 },
  });
const response = (value = usage()): ModelResponse => ({
  message: { role: "assistant", content: "ok" },
  finishReason: "stop",
  usage: value,
  raw: {},
});
function fixture() {
  const records: UsageRecordInput[] = [];
  const tracker = {
    startAttempt: vi.fn(async (_input: Parameters<CostTracker["startAttempt"]>[0]) => {}),
    beginPendingAttempt: vi.fn(),
    endPendingAttempt: vi.fn(),
    checkBudget: vi.fn(async () => ({ status: "allowed", scopes: [] })),
    checkBudgetAfterUsage: vi.fn(async () => ({ status: "allowed", scopes: [] })),
    recordUsage: vi.fn(async (input: UsageRecordInput) => {
      records.push(input);
      return { usageRevision: 1, usageStatus: "complete", ...input };
    }),
    queryCosts: vi.fn(async () => ({ total: null, currency: "USD" })),
    queryRunUsage: vi.fn(async () => usage()),
  };
  return {
    records,
    tracker,
    context: { tracker: tracker as unknown as CostTracker, tenantId: "a", runId: "run", eventBus: new EventBus() },
  };
}
function provider(generate: ModelProvider["generate"] = async () => response()): ModelProvider {
  return {
    providerId: "openai",
    modelId: "gpt-test",
    generate,
    async *stream() {
      yield { type: "finish", finishReason: "stop", usage: usage() };
    },
  };
}

describe("attempt accounting lifecycle", () => {
  it("records one inclusive output and preserves unknown physical retries", async () => {
    const f = fixture();
    const output = await withAccountingContext(f.context, () => meteredGenerate(provider(), []));
    expect(output.usage.totalTokens).toBe(35);
    expect(f.records).toHaveLength(1);
    expect(f.records[0].attemptVisibility).toBe("opaque");
    expect(f.records[0].usage.tokens?.output.total).toBe(16);
    expect(f.records[0].usage.tokens?.output.reasoning).toBe(9);
  });
  it("does not mutate a frozen custom adapter usage object when merging billing context", async () => {
    const f = fixture();
    const supplied = usage();
    Object.freeze(supplied.accounting);
    Object.freeze(supplied);
    const output = await withAccountingContext(f.context, () =>
      meteredGenerate(
        provider(async () => response(supplied)),
        [],
        { billingContext: { region: "us" } },
      ),
    );
    expect(output.usage.accounting?.context?.region).toBe("us");
    expect(supplied.accounting?.context?.region).not.toBe("us");
    expect(f.records[0].executionStatus).toBe("succeeded");
  });
  it("isolates parallel tenant scopes on a shared provider", async () => {
    const f = fixture();
    const shared = provider(async () => {
      await Promise.resolve();
      return response();
    });
    await Promise.all(
      ["a", "b"].map((tenantId) =>
        withAccountingContext({ ...f.context, tenantId }, () => meteredGenerate(shared, [])),
      ),
    );
    expect(f.records.map((item) => item.tenantId).sort()).toEqual(["a", "b"]);
    expect(new Set(f.records.map((item) => item.attemptId)).size).toBe(2);
  });
  it("retains ancestry through intermediate scopes with no paid work", async () => {
    const f = fixture();
    await withAccountingContext({ ...f.context, runId: "root", rootRunId: "root" }, () =>
      withAccountingContext({ ...f.context, runId: "empty-parent", rootRunId: "root" }, () =>
        withAccountingContext({ ...f.context, runId: "leaf", rootRunId: "root" }, () =>
          meteredGenerate(provider(), []),
        ),
      ),
    );
    expect(f.records[0].ancestorRunIds).toEqual(["root", "empty-parent"]);
    expect(f.tracker.startAttempt.mock.calls[0][0]).toMatchObject({ ancestorRunIds: ["root", "empty-parent"] });
  });
  it("settles provider evidence before a failed output hook", async () => {
    const f = fixture();
    await expect(
      withAccountingContext(f.context, async () => {
        await meteredGenerate(provider(), []);
        throw new Error("hook failed");
      }),
    ).rejects.toThrow("hook failed");
    expect(f.records).toHaveLength(1);
    expect(f.records[0].executionStatus).toBe("succeeded");
  });
  it("preserves captured evidence on parse failure", async () => {
    const f = fixture();
    await expect(
      withAccountingContext(f.context, () =>
        meteredGenerate(
          provider(async () => {
            captureUsage(usage());
            throw new Error("invalid output");
          }),
          [],
        ),
      ),
    ).rejects.toThrow("invalid output");
    expect(f.records[0].executionStatus).toBe("failed");
    expect(f.records[0].usage.tokens?.total).toBe(35);
  });
  it("waits through duplicate content finish and late usage snapshots", async () => {
    const f = fixture();
    const p = provider();
    p.stream = async function* () {
      yield { type: "finish", finishReason: "stop" };
      yield { type: "finish", finishReason: "stop", usage: usage(10) };
      yield { type: "finish", finishReason: "stop", usage: usage() };
      yield { type: "finish", finishReason: "stop", usage: usage() };
    };
    for await (const _ of withAccountingStream(f.context, () => meteredStream(p, []))) {
      /* drain */
    }
    expect(f.records).toHaveLength(3);
    expect(f.records.at(-1)?.usage.tokens?.total).toBe(35);
    expect(f.records[0].finality).toBe("provisional");
  });
  it("persists changed snapshots before close and keeps flush pending", async () => {
    const tracker = new CostTracker();
    const context = { tracker, tenantId: "live", runId: "stream" };
    const stream = withAccountingStream(context, () => meteredStream(provider(), []));
    await stream.next();
    const recorded = (await tracker.queryUsage(context)).items.filter((item) => item.sequence > 0);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ finality: "provisional", executionStatus: "unknown" });
    expect(recorded[0].usage.tokens?.total).toBe(35);
    expect((await tracker.queryCosts(context)).finality).toBe("provisional");
    let flushed = false;
    const flush = tracker.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);
    await stream.next();
    await flush;
    expect(flushed).toBe(true);
    expect((await tracker.queryUsage(context)).items.at(-1)?.executionStatus).toBe("succeeded");
  });
  it("does not count an active reservation twice when checking provisional usage", async () => {
    const tracker = new CostTracker({
      catalog: fixtureCatalog(),
      budget: {
        mode: "reservation",
        conservativeBound: "0.1",
        limits: [
          {
            scope: "run",
            amount: "0.1",
            currency: "USD",
            period: { start: "2020-01-01T00:00:00.000Z", end: "2099-01-01T00:00:00.000Z" },
          },
        ],
      },
    });
    const context = { tracker, tenantId: "stream-tenant", runId: "reserved-stream" };
    const p = provider();
    p.stream = async function* () {
      yield {
        type: "finish",
        finishReason: "stop",
        usage: {
          promptTokens: 15000,
          completionTokens: 500,
          totalTokens: 15500,
          accounting: { ...fixtureUsage(), context: fixtureContext },
        },
      };
    };
    const stream = withAccountingStream(context, () => meteredStream(p, []));
    expect((await stream.next()).done).toBe(false);
    expect((await tracker.queryCosts(context)).knownSubtotal).toBe("0.072");
    expect((await stream.next()).done).toBe(true);
    expect((await tracker.queryCosts(context)).total).toBe("0.072");
    await tracker.flush();
  });
  it("adds explicit delta events once even when the normalizer captures a duplicate", async () => {
    const f = fixture();
    const p = provider();
    p.stream = async function* () {
      for (const sequence of [1, 2, 2]) {
        const delta = usage();
        captureUsage(delta);
        yield {
          type: "finish",
          finishReason: "stop",
          usage: delta,
          usageObservation: { kind: "delta", id: `delta-${sequence}`, sequence },
        };
      }
    };
    const counts: number[] = [];
    for await (const chunk of withAccountingStream(f.context, () => meteredStream(p, [])))
      if (chunk.type === "finish") counts.push(chunk.usage?.totalTokens ?? 0);
    expect(counts).toEqual([35, 70, 70]);
    expect(f.records).toHaveLength(3);
    expect(f.records.at(-1)?.usage.tokens?.total).toBe(70);
    expect(f.records.at(-1)?.sequence).toBe(3);
  });
  it("stops after a usage budget denial without replaying the provider", async () => {
    const f = fixture();
    f.tracker.checkBudgetAfterUsage.mockResolvedValue({ status: "blocked", scopes: [] });
    const close = vi.fn();
    const p = provider();
    const stream = vi.fn(async function* () {
      try {
        yield { type: "finish" as const, finishReason: "stop" as const, usage: usage() };
        throw new Error("provider must be closed before another chunk");
      } finally {
        close();
      }
    });
    p.stream = stream;
    await expect(async () => {
      for await (const _ of withAccountingStream(f.context, () => meteredStream(p, []))) {
        /* drain */
      }
    }).rejects.toThrow("Cost budget blocked");
    expect(stream).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(f.records.at(-1)?.usage.tokens?.total).toBe(35);
    expect(f.records.at(-1)?.executionStatus).toBe("failed");
  });
  it("preserves transport and cleanup failures and settles the captured usage", async () => {
    const f = fixture();
    const transport = new Error("transport failed");
    const cleanup = new Error("cleanup failed");
    const p = provider();
    p.stream = () => ({
      next: async () => {
        captureUsage(usage());
        throw transport;
      },
      return: async () => {
        throw cleanup;
      },
      throw: async () => {
        throw transport;
      },
      async [Symbol.asyncDispose]() {},
      [Symbol.asyncIterator]() {
        return this;
      },
    });
    let error: unknown;
    try {
      for await (const _ of withAccountingStream(f.context, () => meteredStream(p, []))) {
        /* drain */
      }
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({ errors: [transport, cleanup], cause: transport });
    expect(f.records.at(-1)?.executionStatus).toBe("failed");
    expect(f.records.at(-1)?.usage.tokens?.total).toBe(35);
  });
  it("retains partial usage when the consumer cancels after a finish chunk", async () => {
    const f = fixture();
    for await (const _ of withAccountingStream(f.context, () => meteredStream(provider(), []))) break;
    expect(f.records.at(-1)?.executionStatus).toBe("cancelled");
    expect(f.records[0].usage.tokens?.total).toBe(35);
  });
  it("records failed and successful fallback leaves without charging the composite", async () => {
    const f = fixture();
    const p = new FallbackProvider({
      providers: [
        provider(async () => {
          throw Object.assign(new Error("unavailable"), { status: 503 });
        }),
        { ...provider(), modelId: "fallback-model" },
      ],
    });
    await withAccountingContext(f.context, () => meteredGenerate(p, []));
    expect(f.records).toHaveLength(2);
    expect(f.records.map((r) => r.executionStatus)).toEqual(["failed", "succeeded"]);
    expect(f.records[1].context.modelId).toBe("fallback-model");
    expect(f.records.every((r) => r.context.providerId !== "fallback")).toBe(true);
  });
  it("does not turn a persistence error into another provider call", async () => {
    const f = fixture();
    f.tracker.recordUsage.mockRejectedValue(new Error("storage down"));
    const call = vi.fn(async () => response());
    const errors: unknown[] = [];
    f.context.eventBus.on("accounting.error", (event) => errors.push(event));
    await expect(withAccountingContext(f.context, () => meteredGenerate(provider(call), []))).resolves.toMatchObject({
      finishReason: "stop",
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
  });
  it("writes durable start intent before submission and blocks on failure", async () => {
    const f = fixture();
    f.tracker.startAttempt.mockRejectedValue(new Error("intent storage failed"));
    const call = vi.fn(async () => response());
    await expect(withAccountingContext(f.context, () => meteredGenerate(provider(call), []))).rejects.toThrow(
      "intent storage failed",
    );
    expect(call).not.toHaveBeenCalled();
    expect(f.records).toHaveLength(0);
  });
  it("keeps warning admission separate from blocked admission", async () => {
    const f = fixture();
    f.tracker.checkBudget.mockResolvedValueOnce({ status: "warned", scopes: [] });
    const call = vi.fn(async () => response());
    await withAccountingContext(f.context, () => meteredGenerate(provider(call), []));
    f.tracker.checkBudget.mockResolvedValueOnce({ status: "blocked", scopes: [] });
    await expect(withAccountingContext(f.context, () => meteredGenerate(provider(call), []))).rejects.toThrow(
      "Cost budget blocked",
    );
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("preserves requested reasoning mode without applying a guessed price multiplier", async () => {
    const f = fixture();
    await withAccountingContext(f.context, () =>
      meteredGenerate(provider(), [], { reasoning: { enabled: true, mode: "pro", effort: "high" } }),
    );
    expect(f.records[0].context).toMatchObject({ reasoningMode: "pro", reasoningEffort: "high" });
    expect(f.records[0].usage.tokens?.total).toBe(35);
  });
  it("flush drains in-flight provider work and unmatched start intents stay incomplete", async () => {
    const tracker = new CostTracker();
    const context = { tracker, tenantId: "tenant", runId: "drain" };
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const call = withAccountingContext(context, () =>
      meteredGenerate(
        provider(async () => {
          started?.();
          await gate;
          return response();
        }),
        [],
      ),
    );
    await began;
    expect((await tracker.queryCosts(context)).total).toBeNull();
    expect((await tracker.queryCosts(context)).finality).toBe("provisional");
    let flushed = false;
    const flush = tracker.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);
    release?.();
    await call;
    await flush;
    expect(flushed).toBe(true);
    expect(
      (await tracker.queryUsage(context)).items.filter((item) => item.executionStatus === "succeeded"),
    ).toHaveLength(1);
  });
  it("emits complete legacy run totals as replacements and cache read/write are explicit", async () => {
    const tracker = new CostTracker({
      catalog: {
        id: "fixture",
        version: "1",
        rules: ["token.input", "token.cache_read", "token.cache_write", "token.output"].map((meter) => ({
          id: meter,
          version: "1",
          meter,
          unit: "token",
          currency: "USD",
          match: {
            providerId: "openai",
            billingProviderId: "openai",
            modelId: "gpt-test",
            api: "responses",
            actualServiceTier: "*",
            region: "*",
            reasoningMode: "*",
            reasoningEffort: "*",
            contractId: "*",
            modality: "*",
          },
          verifiedAt: "2026-10-08T00:00:00Z",
          effectiveFrom: "2020-01-01T00:00:00Z",
          sourceUrl: "https://example.com/fixture",
          rate: { kind: "unit" as const, amount: "1", per: "1000" },
        })),
      },
    });
    const eventBus = new EventBus();
    const totals: number[] = [];
    const tokens: number[] = [];
    eventBus.on("cost.tracked", (event) => {
      totals.push(event.cost ?? 0);
      tokens.push(event.usage.totalTokens);
    });
    await withAccountingContext({ tracker, runId: "complete", agentName: "test", eventBus }, async () => {
      await meteredGenerate(provider(), []);
      await meteredGenerate(provider(), []);
    });
    expect(totals).toEqual([0.035, 0.07]);
    expect(tokens).toEqual([35, 70]);
  });
  it("records each explicit local retry callback once while SDK internals stay opaque", async () => {
    const f = fixture();
    await withAccountingContext(f.context, () =>
      meteredGenerate(
        provider(async () => {
          await captureRetryFailure(new Error("first SDK invocation failed"));
          await captureRetryFailure(new Error("second SDK invocation failed"));
          return response();
        }),
        [],
      ),
    );
    expect(f.records.map((item) => item.executionStatus)).toEqual(["failed", "failed", "succeeded"]);
    expect(new Set(f.records.map((item) => item.attemptId)).size).toBe(3);
    expect(new Set(f.records.map((item) => item.operationId)).size).toBe(1);
  });
  it("keeps one logical operation across agent retries", async () => {
    const tracker = new CostTracker();
    let calls = 0;
    const model = provider(async () => {
      if (++calls < 3) throw Object.assign(new Error("overloaded"), { status: 503 });
      return response();
    });
    const agent = new Agent({
      name: "retries",
      model,
      costTracker: tracker,
      register: false,
      retry: { maxRetries: 2, initialDelayMs: 0, maxDelayMs: 0 },
    });
    await agent.run("work", { tenantId: "retry-tenant", runId: "retry-run" });
    const scope = { tenantId: "retry-tenant", runId: "retry-run" };
    const terminal = (await tracker.queryUsage(scope)).items.filter((item) => item.sequence > 0);
    expect(calls).toBe(3);
    expect(terminal.map((item) => item.executionStatus).sort()).toEqual(["failed", "failed", "succeeded"]);
    expect(new Set(terminal.map((item) => item.operationId)).size).toBe(1);
    expect(new Set(terminal.map((item) => item.attemptId)).size).toBe(3);
    expect((await tracker.queryCosts(scope)).operationCount).toBe(1);
    await agent.close();
  });
  it("meters reflection, compression, compaction, and memory under the owning scope", async () => {
    const f = fixture();
    const model = provider();
    await withAccountingContext(f.context, async () => {
      await new ReflectionManager({ enabled: true }, model).critiqueOutput(
        { text: "answer", toolCalls: [], usage: usage() },
        "query",
        [],
      );
      const compression = new CompressionManager({ model, compressAfter: 1 });
      compression.trackToolResult();
      await compression.process([{ role: "tool", content: "long output ".repeat(100) }]);
      await new ContextCompactor({
        strategy: "summarize",
        maxContextTokens: 100,
        reserveTokens: 0,
        summarizeModel: model,
      }).compact([
        { role: "user", content: "old long context ".repeat(100) },
        { role: "assistant", content: "prior response" },
        { role: "user", content: "new question" },
      ]);
      await new Summaries(new InMemoryStorage(), { model }).summarize("session", [
        { role: "user", content: "remember" },
      ]);
    });
    expect(f.records.map((item) => item.purpose)).toEqual([
      "reflection",
      "compression",
      "compaction",
      "memory-summaries",
    ]);
    expect(f.records.every((item) => item.tenantId === "a" && item.runId === "run")).toBe(true);
  });
  it("meters standalone team orchestration and workflow child work", async () => {
    const tracker = new CostTracker();
    const member = new Agent({ name: "member", model: provider(), register: false });
    const team = new Team({
      name: "team",
      mode: TeamMode.Broadcast,
      model: provider(),
      members: [member],
      costTracker: tracker,
      register: false,
    });
    await team.run("work", { tenantId: "team-tenant", runId: "team-run" });
    const teamRecords = (await tracker.queryUsage({ tenantId: "team-tenant", rootRunId: "team-run" })).items.filter(
      (item) => item.executionStatus === "succeeded",
    );
    expect(teamRecords.map((item) => item.purpose).sort()).toEqual(["answer", "team-orchestration"]);
    expect(new Set(teamRecords.map((item) => item.runId)).size).toBe(2);
    const workflow = new Workflow({
      name: "flow",
      initialState: {},
      steps: [{ name: "member-step", agent: member }],
      costTracker: tracker,
      register: false,
    });
    await workflow.run({ tenantId: "flow-tenant", runId: "flow-run" });
    const flowRecords = (await tracker.queryUsage({ tenantId: "flow-tenant", rootRunId: "flow-run" })).items.filter(
      (item) => item.executionStatus === "succeeded",
    );
    expect(flowRecords).toHaveLength(1);
    expect(flowRecords[0].parentRunId).toBe("flow-run");
    await member.close();
  });
  it("stores missing custom operation billing as unknown", async () => {
    const f = fixture();
    await withAccountingContext(f.context, () =>
      meteredOperation(
        {
          context: {
            providerId: "custom",
            billingProviderId: "custom",
            modelId: "search",
            api: "search",
            occurredAt: "2026-10-08T00:00:00Z",
          },
        },
        async () => "ok",
      ),
    );
    expect(f.records[0].usage.tokens).toBeNull();
    expect(f.records[0].usage.coverage.requiredMeters).toEqual(["operation.unknown"]);
  });
});
