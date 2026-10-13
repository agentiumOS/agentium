import {
  type ChatMessage,
  DurableGraphJournal,
  DurableRecoveryRequiredError,
  DurableTaskSupervisor,
  EventBus,
  InMemoryDurableTaskStore,
  type ModelConfig,
  type ModelProvider,
  type ModelResponse,
  RootExecutionController,
  RunContext,
  type StreamChunk,
} from "@agentium/core";
import { describe, expect, it } from "vitest";
import { z } from "zod/v3";
import { HarnessBudgetLedger } from "../budget.js";
import type { HarnessExecutionServices } from "../driver.js";
import { generateExecutionPlan, streamExecutionPlans } from "../execution-planner.js";
import { ExecutionPlanValidationError, graphCatalogDigest } from "../execution-proposal.js";
import type { ExecutionGraphProgram, GraphBinding } from "../graph-contracts.js";
import { readExecutionPlan } from "../plan-commit.js";

const limits = { maxBytes: 5000, maxNodes: 10, maxDepth: 20, maxConcurrency: 2, durable: true };
const catalog: GraphBinding[] = [
  {
    id: "read",
    version: "1",
    kind: "tool",
    input: z.object({ value: z.number() }),
    output: z.number(),
    recovery: "pure",
    tool: {
      name: "read",
      description: "fixture",
      parameters: z.object({ value: z.number() }),
      execute: async () => {
        throw new Error("planner cannot dispatch");
      },
    },
  },
];
function plan(revision = 1, value = 1) {
  return { schemaVersion: 1, revision, nodes: [{ id: "a", binding: "read", version: "1", args: { value } }] };
}
const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
function response(content: string, finishReason: ModelResponse["finishReason"] = "stop"): ModelResponse {
  return { message: { role: "assistant", content }, usage, finishReason, raw: null };
}
async function fixture(
  responses: Array<ModelResponse | Error> = [response(JSON.stringify(plan()))],
  streams: Array<StreamChunk[] | Error> = [],
  corrections = 2,
) {
  let now = Date.now();
  const key = { tenantId: "tenant", taskId: "planner" };
  const store = new InMemoryDurableTaskStore({ now: () => now });
  const supervisor = new DurableTaskSupervisor(store, { leaseMs: 100 });
  await store.create({
    id: key.taskId,
    identity: { tenantId: "tenant", actorId: "actor", sessionId: "session", runId: "run", rootRunId: "root" },
    manifestHash: "manifest",
    inputRef: "input",
    policyRevision: 1,
    grantRefs: [],
    budget: { maxAttempts: 20 },
  });
  const claimed = await supervisor.claim(key, "worker");
  if (!claimed?.lease) throw new Error("lease");
  const definition = {
    id: "graph",
    version: "1",
    catalogDigest: graphCatalogDigest(catalog, limits),
    input: {},
    limits: {},
  };
  const journal = new DurableGraphJournal(store, key, claimed.lease, definition);
  await journal.initialize();
  const root = new RootExecutionController({ maxConcurrentWork: 1, maxWorkAttempts: 20 });
  const controller = new AbortController();
  const ctx = new RunContext({
    sessionId: "session",
    eventBus: new EventBus(),
    signal: controller.signal,
    rootExecution: root,
  });
  const requests: Array<{ messages: ChatMessage[]; options?: ModelConfig }> = [];
  let modelCalls = 0;
  let streamCalls = 0;
  const unused = (): never => {
    throw new Error("unauthorized test operation");
  };
  const provider: ModelProvider = {
    providerId: "offline",
    modelId: "fixture",
    generate: async () => unused(),
    stream: unused,
  };
  const services: HarnessExecutionServices = {
    ctx,
    signal: controller.signal,
    rootExecution: root,
    tools: [],
    history: [],
    state: {},
    sessionKey: "session",
    executionPolicy: { decide: unused },
    budget: new HarnessBudgetLedger({}).snapshot(),
    archivedHistory: [],
    async model(_provider, messages, options) {
      requests.push({ messages, options });
      const selected = responses[modelCalls++];
      if (selected instanceof Error) throw selected;
      if (!selected) throw new Error("no fixture response");
      return root.run("model", `call/${modelCalls}`, async () => selected);
    },
    async *streamModel(_provider, messages, options) {
      requests.push({ messages, options });
      const selected = streams[streamCalls++];
      if (selected instanceof Error) throw selected;
      if (!selected) throw new Error("no fixture stream");
      yield* selected;
    },
    runOwned: (fn) => fn(),
    observeTool: async () => {},
    observeToolSettlements: async () => {},
    dispatchEffect: async () => unused(),
    dispatch: async () => unused(),
    recordConversation: () => {},
    retrieveHistory: async () => [],
    finishModel: async () => unused(),
    controlModel: async () => unused(),
    append: () => {},
    emit: () => {},
    requestInput: async () => unused(),
    takeInput: () => undefined,
    resource: async () => unused(),
    putArtifact: unused,
    getArtifact: unused,
  };
  const program: ExecutionGraphProgram = {
    id: "planned",
    version: "1",
    planner: {
      provider,
      hostInstructions: "Use only approved read operations.",
      maxCorrections: corrections,
      maxOutputTokens: 200,
      stream: { maxFrameBytes: 5000, maxTotalBytes: 15000, maxFrames: 5 },
    },
  };
  const options = {
    program,
    scope: "episode",
    input: { request: "compute" },
    catalog,
    limits,
    services,
    journal,
    root,
  };
  return {
    options,
    requests,
    controller,
    counts: () => ({ modelCalls, streamCalls }),
    async restart() {
      now += 101;
      const next = await supervisor.claim(key, "recovery");
      if (!next?.lease) throw new Error("lease");
      options.journal = new DurableGraphJournal(store, key, next.lease, definition);
    },
    async state() {
      return (await options.journal.snapshot()).metadata["planning:episode"];
    },
  };
}
function frame(revision = 1, value = 1): StreamChunk {
  return { type: "text", text: `${JSON.stringify({ baseRevision: revision - 1, plan: plan(revision, value) })}\n` };
}
const finish: StreamChunk = { type: "finish", finishReason: "stop", usage };
describe("durable authorized execution planning", () => {
  it("rejects inherited exhausted episode depth before calling a planner provider", async () => {
    const f = await fixture();
    await expect(generateExecutionPlan({ ...f.options, depth: 21 })).rejects.toBeInstanceOf(
      ExecutionPlanValidationError,
    );
    expect(f.counts().modelCalls).toBe(0);
  });
  it("counts fragmented Unicode as UTF8 bytes across stream chunks", async () => {
    const encoded = `${JSON.stringify({ baseRevision: 0, plan: { ...plan(), nodes: [{ ...plan().nodes[0], id: "😀" }] } })}\n`;
    const split = encoded.indexOf("😀") + 1;
    const f = await fixture(
      [],
      [[{ type: "text", text: encoded.slice(0, split) }, { type: "text", text: encoded.slice(split) }, finish]],
    );
    if (!f.options.program.planner) throw new Error("planner");
    f.options.program.planner.stream.maxTotalBytes = Buffer.byteLength(encoded);
    await streamExecutionPlans(f.options, () => {});
    expect(await f.state()).toMatchObject({ status: "sealed", streamBytes: Buffer.byteLength(encoded) });
  });
  it("rejects concurrent planner attempts under the same active owner", async () => {
    const f = await fixture([response(JSON.stringify(plan())), response(JSON.stringify(plan()))]);
    const original = f.options.services.model;
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.options.services.model = async (...args) => {
      entered?.();
      await gate;
      return original(...args);
    };
    const first = generateExecutionPlan(f.options);
    await started;
    const second = generateExecutionPlan(f.options);
    setTimeout(() => release?.(), 2);
    const results = await Promise.allSettled([first, second]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    expect(f.counts().modelCalls).toBe(1);
  });
  it("does not clear the winning pending reservation when simultaneous calls race admission", async () => {
    const f = await fixture();
    const original = f.options.services.model;
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.options.services.model = async (...args) => {
      entered?.();
      await gate;
      return original(...args);
    };
    const first = generateExecutionPlan(f.options);
    const second = generateExecutionPlan(f.options).then(
      () => null,
      (cause: unknown) => cause,
    );
    await started;
    const rejected = await second;
    const retained = await f.state();
    release?.();
    await first;
    expect(rejected).toBeInstanceOf(ExecutionPlanValidationError);
    expect(retained).toMatchObject({
      status: "planning",
      attempts: 1,
      pending: { index: 0, ownerFence: f.options.journal.fence.fence },
    });
  });
  it("retains exact rejected streamed candidate evidence before parser failure", async () => {
    const f = await fixture([], [[frame(), { type: "text", text: "{bad}\n" }]]);
    await expect(streamExecutionPlans(f.options, () => {})).rejects.toBeInstanceOf(DurableRecoveryRequiredError);
    const state = await f.options.journal.snapshot();
    expect(state.evidence).toContainEqual(
      expect.objectContaining({ type: "planning.proposal", status: "rejected", raw: "{bad}" }),
    );
    expect(await f.state()).toMatchObject({ streamFrames: 2 });
  });
  it("interrupts failed commit admission without spending model correction calls", async () => {
    const f = await fixture([response(JSON.stringify(plan())), response(JSON.stringify(plan()))]);
    f.options.root = new RootExecutionController({ maxPlanRevisions: 0 });
    await expect(generateExecutionPlan(f.options)).rejects.toBeInstanceOf(DurableRecoveryRequiredError);
    expect(f.counts().modelCalls).toBe(1);
  });
  it("uses controlled tool-free calls, commits complete proposals, retains evidence and seals without resampling", async () => {
    const f = await fixture();
    const materialized = await generateExecutionPlan(f.options);
    expect(materialized.validated.plan.revision).toBe(1);
    expect(f.counts()).toEqual({ modelCalls: 1, streamCalls: 0 });
    expect(f.requests[0].options).toMatchObject({ tools: [], maxTokens: 200 });
    expect(f.requests[0].messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("Use only approved"),
    });
    expect(f.requests[0].messages[1]).toMatchObject({ role: "user", content: expect.stringContaining('"catalog"') });
    expect(await f.state()).toMatchObject({ status: "sealed", attempts: 1 });
    expect(
      (await f.options.journal.snapshot()).evidence.some((entry) => JSON.stringify(entry).includes("validated")),
    ).toBe(true);
    await f.restart();
    expect(await generateExecutionPlan(f.options)).toEqual(materialized);
    expect(f.counts().modelCalls).toBe(1);
  });
  it("retains rejected evidence and performs only bounded corrections using a new model index", async () => {
    const f = await fixture([response('{"code":"evil"}'), response(JSON.stringify(plan()))]);
    await generateExecutionPlan(f.options);
    expect(f.counts().modelCalls).toBe(2);
    expect(await f.state()).toMatchObject({ status: "sealed", attempts: 2, corrections: 1 });
    expect(Object.keys((await f.options.journal.snapshot()).models)).toEqual([
      "episode/planner/model/0",
      "episode/planner/model/1",
    ]);
    expect(f.requests[1].messages[1].content).toContain("lastError");
  });
  it("does not reset correction allowance when an interrupted task is resumed", async () => {
    const f = await fixture([response("bad"), response("bad"), response(JSON.stringify(plan()))], [], 1);
    await expect(generateExecutionPlan(f.options)).rejects.toBeInstanceOf(ExecutionPlanValidationError);
    await f.restart();
    await expect(generateExecutionPlan(f.options)).rejects.toBeInstanceOf(ExecutionPlanValidationError);
    expect(f.counts().modelCalls).toBe(2);
    expect(await readExecutionPlan(f.options.journal, "episode")).toBeUndefined();
  });
  it.each(["length", "content_filter", "tool_calls"] as const)(
    "interrupts provider %s rather than treating its JSON as success",
    async (reason) => {
      const f = await fixture([response(JSON.stringify(plan()), reason)], [], 0);
      await expect(generateExecutionPlan(f.options)).rejects.toBeInstanceOf(ExecutionPlanValidationError);
      expect(await f.state()).toMatchObject({ status: "interrupted" });
      expect(await readExecutionPlan(f.options.journal, "episode")).toBeUndefined();
    },
  );
  it("recovers failed model work using a fresh bounded request and original plan observations", async () => {
    const f = await fixture([new Error("transport"), response(JSON.stringify(plan()))]);
    await expect(generateExecutionPlan(f.options)).rejects.toBeInstanceOf(DurableRecoveryRequiredError);
    await f.restart();
    await generateExecutionPlan(f.options);
    expect(f.counts().modelCalls).toBe(2);
    expect(await f.state()).toMatchObject({ status: "sealed", attempts: 2 });
  });
  it("commits each safe streamed prefix before EOF and seals only after terminal stop accounting", async () => {
    const f = await fixture([], [[frame(), frame(2, 2), finish]]);
    const seen: number[] = [];
    await streamExecutionPlans(f.options, (p) => seen.push(p.validated.plan.revision));
    expect(seen).toEqual([1, 2]);
    expect(await f.state()).toMatchObject({ status: "sealed", streamFrames: 2 });
    await streamExecutionPlans(f.options, () => {
      throw new Error("no callback on sealed recovery");
    });
    expect(f.counts().streamCalls).toBe(1);
  });
  it("seals a cached completed stream after recovery at the attempt cap without a fresh model call", async () => {
    const f = await fixture([], [[frame(), finish]], 0);
    await streamExecutionPlans(f.options, () => {});
    await f.options.journal.mutate((graph) => {
      const state = graph.metadata["planning:episode"];
      const input = graph.models["episode/planner/model/0"].input;
      if (!state || typeof state !== "object" || Array.isArray(state) || input === undefined) throw new Error("state");
      state.status = "planning";
      state.pending = { index: 0, ownerFence: f.options.journal.fence.fence, request: input };
    });
    await f.restart();
    await streamExecutionPlans(f.options, () => {});
    expect(f.counts().streamCalls).toBe(1);
    expect(await f.state()).toMatchObject({ status: "sealed", attempts: 1 });
  });
  it.each(
    (
      [
        [frame(), { type: "text", text: "{bad}\n" }],
        [frame()],
        [frame(), { type: "finish", finishReason: "length", usage }],
        [frame(), { type: "tool_call_start", toolCall: { id: "evil", name: "write" } }],
        [frame(), { type: "finish", finishReason: "stop" }],
        [frame(), finish, { type: "text", text: "late" }],
      ] satisfies StreamChunk[][]
    ).map((chunks) => ({ chunks })),
  )("retains prefix but interrupts malformed, unfinished or unauthorized stream %j", async ({ chunks }) => {
    const f = await fixture([], [chunks]);
    await expect(streamExecutionPlans(f.options, () => {})).rejects.toBeInstanceOf(DurableRecoveryRequiredError);
    expect((await readExecutionPlan(f.options.journal, "episode"))?.validated.plan.revision).toBe(1);
    expect(await f.state()).toMatchObject({ status: "interrupted" });
  });
  it("continues an interrupted stream from retained revision without replaying earlier proposals", async () => {
    const f = await fixture([], [[frame()], [frame(2, 2), finish]]);
    await expect(streamExecutionPlans(f.options, () => {})).rejects.toBeInstanceOf(DurableRecoveryRequiredError);
    await f.restart();
    await streamExecutionPlans(f.options, () => {});
    expect(f.requests[1].messages[1].content).toContain('"currentRevision":1');
    expect(f.requests[1].messages[1].content).toContain('"currentPlan"');
    expect(f.counts().streamCalls).toBe(2);
    expect(await f.state()).toMatchObject({ status: "sealed", streamFrames: 2, attempts: 2 });
  });
  it("retains cumulative stream caps across recovery and never seals an empty stream", async () => {
    const f = await fixture([], [[frame()], [frame(2), finish]], 2);
    if (!f.options.program.planner) throw new Error("planner");
    f.options.program.planner.stream.maxFrames = 1;
    await expect(streamExecutionPlans(f.options, () => {})).rejects.toBeInstanceOf(DurableRecoveryRequiredError);
    await f.restart();
    await expect(streamExecutionPlans(f.options, () => {})).rejects.toBeInstanceOf(DurableRecoveryRequiredError);
    expect((await readExecutionPlan(f.options.journal, "episode"))?.validated.plan.revision).toBe(1);
    const empty = await fixture([], [[finish]], 0);
    await expect(streamExecutionPlans(empty.options, () => {})).rejects.toBeInstanceOf(ExecutionPlanValidationError);
  });
});
