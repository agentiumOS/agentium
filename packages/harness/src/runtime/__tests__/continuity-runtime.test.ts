import {
  type ChatMessage,
  EventBus,
  type ModelConfig,
  type ModelProvider,
  type ModelResponse,
  RunContext,
} from "@agentium/core";
import { afterEach, expect, it, vi } from "vitest";
import { currentSessionRecallPolicy, incrementalTaskSummaryPolicy } from "../../continuity-policies.js";
import { type ExecutionDriver, HarnessRuntime, type HarnessRuntimeConfig } from "../driver.js";
import type { RecallBudget, RecallPolicy, RecallResult } from "../recall.js";
import { InMemoryHarnessSessionStore } from "../session-bindings.js";
import { continuityBudget, continuityScope, createContinuityFixture } from "./fixtures/continuity-fixture.js";

const response = (text: string): ModelResponse => ({
  message: { role: "assistant", content: text },
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  finishReason: "stop",
  raw: {},
});
afterEach(() => vi.useRealTimers());
it("summarizes new canonical groups through admitted task prepare and persists exact evidence mappings", async () => {
  const fixture = createContinuityFixture();
  fixture.seedArchive("A", "Use npm");
  const sessions = new InMemoryHarnessSessionStore();
  const lease = await sessions.acquire(continuityScope.identity, continuityScope.sessionId);
  await lease.commit({
    history: [],
    state: {},
    replayable: true,
    archivedHistory: [...fixture.archives],
    memoryScope: continuityScope,
  });
  await lease.release();
  const summaryInputs: { previous?: unknown; additions: { id: string; text: string }[] }[] = [];
  const taskInputs: ChatMessage[][] = [];
  const task: ModelProvider = {
    providerId: "task",
    modelId: "task",
    async generate(messages) {
      taskInputs.push(structuredClone(messages));
      return response("answer");
    },
    async *stream() {},
  };
  const summary: ModelProvider = {
    providerId: "summary",
    modelId: "summary",
    async generate(messages) {
      const input = JSON.parse(String(messages[1]?.content));
      summaryInputs.push(input);
      return response(
        JSON.stringify({
          text: input.additions.map((item: { text: string }) => item.text).join("; "),
          evidenceIds: input.additions.map((item: { id: string }) => item.id),
          uncertainties: [],
        }),
      );
    },
    async *stream() {},
  };
  const policy = incrementalTaskSummaryPolicy({
    id: "summary",
    version: 1,
    modelRole: "summary",
    maxInputBytes: 16384,
    maxOutputBytes: 2048,
    maxTokens: 512,
    maxEvidenceReferences: 8,
    maxUncertainties: 8,
  });
  const runtime = new HarnessRuntime({
    sessionStore: sessions,
    driver: {
      id: "fixture",
      version: 1,
      capabilities: { durable: false, controlledExecution: true, controls: [], policyCoverage: "local" },
      async start(request, services) {
        const messages: ChatMessage[] = [{ role: "user", content: request.input }];
        services.append(messages);
        const result = await services.model(task, messages, { maxTokens: 32 });
        return { text: String(result.message.content) };
      },
    },
    grants: { toolIds: [], modelRoles: ["main", "summary"] },
    models: { summary: { provider: summary, options: ["maxTokens"] } },
    budgets: { maxModelCalls: 2, maxTokens: 10000 },
    residentHistory: { maxMessages: 8, archive: fixture.archive },
    recall: { store: fixture.store, budget: continuityBudget, policy: currentSessionRecallPolicy("recall") },
    taskSummary: {
      policy,
      maxInputBytes: 8192,
      maxSummaryBytes: 2048,
      maxSummaryTokens: 512,
      maxEvidenceReferences: 8,
      maxRecordBytes: 8192,
      maxSummaryRecords: 4,
    },
  });
  const result = await runtime.run("Which package manager?", {
    identity: continuityScope.identity,
    sessionId: continuityScope.sessionId,
    recallScope: { projectId: continuityScope.projectId },
  });
  expect(result.status, JSON.stringify(result)).toBe("completed");
  expect(summaryInputs).toHaveLength(1);
  expect(taskInputs[0]?.some((message) => String(message.content).includes("Use npm"))).toBe(true);
  const read = await sessions.acquire(continuityScope.identity, continuityScope.sessionId);
  expect(read.read().taskSummaries?.main).toMatchObject({
    sourceViewRevision: "1",
    coverage: { throughArchiveId: "A", throughMessage: 1 },
    evidence: [{ id: "A:0", reference: { sourceId: "A" } }],
  });
  await read.release();
  expect(fixture.legacyArchiveReads).toBe(0);
});

async function createRuntimeFixture(
  options: {
    policy?: RecallPolicy;
    recallBudget?: RecallBudget;
    config?: Partial<HarnessRuntimeConfig>;
    onSummary?: (messages: ChatMessage[], config?: ModelConfig) => Promise<void>;
    onTask?: (messages: ChatMessage[], config?: ModelConfig) => Promise<void>;
    driver?: ExecutionDriver["start"];
    summaryEnabled?: boolean;
    maxResidentMessages?: number;
    taskContextWindow?: number;
    summaryRecordCap?: number;
  } = {},
) {
  const fixture = createContinuityFixture();
  fixture.seedArchive("A", "Use npm for this project");
  const sessions = new InMemoryHarnessSessionStore();
  const seed = async () => {
    const lease = await sessions.acquire(continuityScope.identity, continuityScope.sessionId);
    const snapshot = lease.read();
    await lease.commit({ ...snapshot, archivedHistory: [...fixture.archives], memoryScope: continuityScope });
    await lease.release();
  };
  await seed();
  const summaryInputs: {
    previous?: { coverage: { throughArchiveId: string }; draft: { evidenceIds: string[] } };
    additions: { id: string; text: string; reference: { sourceId: string } }[];
  }[] = [];
  const taskInputs: ChatMessage[][] = [];
  const decisions: RecallResult[] = [];
  const defaultPolicy = options.policy ?? currentSessionRecallPolicy("recall");
  const task: ModelProvider = {
    providerId: "task",
    modelId: "task",
    capabilities: { contextWindow: options.taskContextWindow ?? 16384, maxOutputTokens: 512 },
    async generate(messages, config) {
      taskInputs.push(structuredClone(messages));
      await options.onTask?.(messages, config);
      return response("answer");
    },
    async *stream(messages, config) {
      taskInputs.push(structuredClone(messages));
      await options.onTask?.(messages, config);
      yield { type: "text", text: "answer" };
      yield { type: "finish", finishReason: "stop", usage: response("answer").usage };
    },
  };
  const summary: ModelProvider = {
    providerId: "summary",
    modelId: "summary",
    async generate(messages, config) {
      const input = JSON.parse(String(messages[1]?.content));
      summaryInputs.push(input);
      await options.onSummary?.(messages, config);
      return response(
        JSON.stringify({
          text: input.additions.map((item: { text: string }) => item.text).join("; "),
          evidenceIds: [
            ...(input.previous?.draft.evidenceIds ?? []),
            ...input.additions.map((item: { id: string }) => item.id),
          ],
          uncertainties: [],
        }),
      );
    },
    async *stream() {},
  };
  const summaryPolicy = incrementalTaskSummaryPolicy({
    id: "summary",
    version: 1,
    modelRole: "summary",
    maxInputBytes: 16384,
    maxOutputBytes: 4096,
    maxTokens: 512,
    maxEvidenceReferences: 8,
    maxUncertainties: 8,
  });
  const runtime = new HarnessRuntime({
    sessionStore: sessions,
    driver: {
      id: "fixture",
      version: 1,
      capabilities: { durable: false, controlledExecution: true, controls: [], policyCoverage: "local" },
      start:
        options.driver ??
        (async (request, services) => {
          services.append([{ role: "user", content: request.input }]);
          const result = await services.model(task, [...services.history], { maxTokens: 32 });
          return { text: String(result.message.content) };
        }),
    },
    grants: { toolIds: [], modelRoles: ["main", "summary"] },
    models: { summary: { provider: summary, options: ["maxTokens"] } },
    budgets: { maxModelCalls: 3, maxTokens: 10000 },
    residentHistory: { maxMessages: options.maxResidentMessages ?? 16, archive: fixture.archive },
    recall: {
      store: fixture.store,
      budget: options.recallBudget ?? continuityBudget,
      policy: {
        ...defaultPolicy,
        async decide(result, ctx) {
          decisions.push(structuredClone(result));
          return defaultPolicy.decide(result, ctx);
        },
      },
    },
    ...(options.summaryEnabled === false
      ? {}
      : {
          taskSummary: {
            policy: summaryPolicy,
            maxInputBytes: 8192,
            maxSummaryBytes: 4096,
            maxSummaryTokens: 1024,
            maxEvidenceReferences: 8,
            maxRecordBytes: 8192,
            maxSummaryRecords: options.summaryRecordCap ?? 4,
          },
        }),
    ...options.config,
  });
  const start = {
    identity: continuityScope.identity,
    sessionId: continuityScope.sessionId,
    recallScope: { projectId: continuityScope.projectId },
  };
  return {
    ...fixture,
    runtime,
    sessions,
    task,
    summaryInputs,
    taskInputs,
    decisions,
    start,
    seed,
    async snapshot() {
      const lease = await sessions.acquire(continuityScope.identity, continuityScope.sessionId);
      const snapshot = lease.read();
      await lease.release();
      return snapshot;
    },
  };
}

it("adds only B after A across actual runtime calls and keeps immutable appends in the same view epoch", async () => {
  const fixture = await createRuntimeFixture();
  expect((await fixture.runtime.run("first task", fixture.start)).status).toBe("completed");
  fixture.seedArchive("B", "Correction: use pnpm");
  await fixture.seed();
  const result = await fixture.runtime.run("second task", fixture.start);
  expect(result.status, JSON.stringify(result)).toBe("completed");
  expect(fixture.summaryInputs[1]?.additions.map((item) => item.reference.sourceId)).toEqual(["B"]);
  expect(fixture.summaryInputs[1]?.previous?.coverage.throughArchiveId).toBe("A");
  expect((await fixture.snapshot()).taskSummaries?.main).toMatchObject({
    revision: 2,
    sourceViewRevision: "1",
    coverage: { throughArchiveId: "B", throughArchiveOrdinal: 1 },
    evidence: [{ id: "A:0" }, { id: "B:0" }],
  });
  expect(JSON.stringify(fixture.taskInputs[1])).toContain("pnpm");
});

it("keeps the final admitted task call available when summary call allowance is exhausted", async () => {
  const policy: RecallPolicy = {
    ...currentSessionRecallPolicy("continue-with-pending"),
    async decide() {
      return { action: "continue" };
    },
  };
  const fixture = await createRuntimeFixture({ policy, config: { budgets: { maxModelCalls: 1, maxTokens: 10000 } } });
  const result = await fixture.runtime.run("task", fixture.start);
  expect(result.status).toBe("completed");
  expect(fixture.summaryInputs).toHaveLength(0);
  expect(fixture.taskInputs).toHaveLength(1);
  expect(fixture.decisions[0]?.diagnostics).toContainEqual(expect.objectContaining({ code: "pending_summary" }));
  expect((await fixture.snapshot()).taskSummaries?.main).toBeUndefined();
});

it("does not invoke a summarizer during arbitrary history retention", async () => {
  const fixture = await createRuntimeFixture({
    driver: async (_request, services) => {
      services.append([{ role: "user", content: "retention-only" }]);
      await services.retainHistory?.(
        {
          providerId: "retention",
          modelId: "retention",
          async generate() {
            return response("unused");
          },
          async *stream() {},
        },
        [...services.history],
      );
      return { text: "retained" };
    },
  });
  expect((await fixture.runtime.run("task", fixture.start)).status).toBe("completed");
  expect(fixture.summaryInputs).toHaveLength(0);
  expect(fixture.taskInputs).toHaveLength(0);
});

it("cancels in-flight summary work without advancing the frontier or calling the task provider", async () => {
  let enter: (() => void) | undefined;
  let release: (() => void) | undefined;
  let summarySignal: AbortSignal | undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await createRuntimeFixture({
    onSummary: async (_messages, config) => {
      summarySignal = config?.signal;
      enter?.();
      await pending;
    },
  });
  const handle = fixture.runtime.start("task", fixture.start);
  await entered;
  handle.cancel("summary cancellation");
  release?.();
  expect((await handle.result()).status).toBe("cancelled");
  expect(summarySignal?.aborted).toBe(true);
  expect(fixture.taskInputs).toHaveLength(0);
  const snapshot = await fixture.snapshot();
  expect(snapshot.taskSummaries?.main).toBeUndefined();
  expect(snapshot.archivedHistory?.[0]?.id).toBe("A");
  expect(snapshot.history.at(-1)?.content).toBe("task");
});

it("survives summary and task latency longer than source deadlines using fresh validation sessions", async () => {
  vi.useFakeTimers();
  const fixture = await createRuntimeFixture({
    onSummary: async () => {
      await vi.advanceTimersByTimeAsync(150);
    },
    onTask: async () => {
      await vi.advanceTimersByTimeAsync(150);
    },
  });
  const result = await fixture.runtime.run("task", fixture.start);
  expect(result.status, JSON.stringify(result)).toBe("completed");
  expect(fixture.summaryInputs).toHaveLength(1);
  expect(fixture.taskInputs).toHaveLength(1);
  expect(fixture.validations).toHaveLength(3);
  expect(fixture.validations.map((item) => item.session)).toEqual([1, 1, 2]);
  expect(fixture.validations[0]?.limits.deadline).toBe(fixture.opens[0]?.deadline + 100);
  expect(fixture.closes).toEqual([1, 2]);
  expect((await fixture.snapshot()).taskSummaries?.main).toBeDefined();
});

it("drops derived summary at commit after revocation while preserving the canonical single commit", async () => {
  const fixture = await createRuntimeFixture({
    onTask: async () => {
      fixture.revoke();
    },
  });
  const result = await fixture.runtime.run("task", fixture.start);
  expect(result.status).toBe("completed");
  expect(result.cleanupDiagnostics).toContain("summary_invalidated_at_commit");
  const snapshot = await fixture.snapshot();
  expect(snapshot.taskSummaries?.main).toBeUndefined();
  expect(snapshot.archivedHistory?.[0]?.id).toBe("A");
  expect(snapshot.history.at(-1)?.content).toBe("task");
  expect(fixture.opens).toHaveLength(2);
  expect(fixture.closes).toHaveLength(2);
});

it("rejects deletion during summary generation before task submission", async () => {
  const fixture = await createRuntimeFixture({
    onSummary: async () => {
      fixture.deleteSource("A");
    },
  });
  const result = await fixture.runtime.run("task", fixture.start);
  expect(result.status).toBe("stopped");
  expect(fixture.taskInputs).toHaveLength(0);
  expect((await fixture.snapshot()).taskSummaries?.main).toBeUndefined();
  expect(fixture.decisions[0]?.diagnostics).toContainEqual(expect.objectContaining({ code: "revision_changed" }));
});

it("invalidates a previously persisted summary on reuse after correction", async () => {
  const fixture = await createRuntimeFixture();
  await fixture.runtime.run("first", fixture.start);
  fixture.deleteSource("A");
  const result = await fixture.runtime.run("second", fixture.start);
  expect(result.status).toBe("stopped");
  expect(fixture.taskInputs).toHaveLength(1);
  expect((await fixture.snapshot()).taskSummaries?.main).toBeUndefined();
});

it("requires host scope import attestation and rejects project reuse", async () => {
  const fixture = await createRuntimeFixture();
  expect(
    (await fixture.runtime.run("task", { ...fixture.start, recallScope: { projectId: "other" } })).reason?.code,
  ).toBe("memory_scope_mismatch");
  expect(fixture.taskInputs).toHaveLength(0);
  const lease = await fixture.sessions.acquire(continuityScope.identity, continuityScope.sessionId);
  const snapshot = lease.read();
  await lease.commit({ ...snapshot, memoryScope: undefined, history: [{ role: "user", content: "legacy" }] });
  await lease.release();
  expect((await fixture.runtime.run("task", fixture.start)).reason?.code).toBe("memory_scope_attestation_required");
  const result = await fixture.runtime.run("task", { ...fixture.start, attestLegacyMemoryScope: true });
  expect(result.status, JSON.stringify(result)).toBe("completed");
  expect((await fixture.snapshot()).memoryScope).toEqual(continuityScope);
});

it("answers one live clarification within the same admitted task call and canonicalizes the reply", async () => {
  const policy: RecallPolicy = {
    ...currentSessionRecallPolicy("ask"),
    async decide(result) {
      return result.usage.queries === 1
        ? { action: "await_input", question: "Which project decision?" }
        : { action: "continue" };
    },
  };
  const fixture = await createRuntimeFixture({
    policy,
    summaryEnabled: false,
    config: { budgets: { maxModelCalls: 1, maxTokens: 10000 } },
  });
  const handle = fixture.runtime.start("task", fixture.start);
  let questionId: string | undefined;
  for await (const event of handle.events()) {
    if (event.payload.type === "input.requested") {
      questionId = event.payload.request.id;
      await handle.reply(questionId, "Use npm");
      break;
    }
  }
  const result = await handle.result();
  expect(result.status, JSON.stringify(result)).toBe("completed");
  expect(fixture.taskInputs).toHaveLength(1);
  expect(JSON.stringify(fixture.taskInputs[0])).toContain("Use npm");
  expect((await fixture.snapshot()).history.at(-1)).toEqual({ role: "user", content: "Use npm" });
  expect(fixture.discoveries).toHaveLength(2);
  expect(fixture.opens).toHaveLength(2);
});

it("bounds repeated clarification and releases the task reservation", async () => {
  const policy: RecallPolicy = {
    ...currentSessionRecallPolicy("ask"),
    async decide() {
      return { action: "await_input", question: "More?" };
    },
  };
  const fixture = await createRuntimeFixture({ policy, summaryEnabled: false });
  const handle = fixture.runtime.start("task", fixture.start);
  for await (const event of handle.events())
    if (event.payload.type === "input.requested") {
      await handle.reply(event.payload.request.id, "reply");
      break;
    }
  const result = await handle.result();
  expect(result.reason?.code).toBe("clarification_limit");
  expect(result.budget?.modelCalls.reserved).toBe(0);
  expect(result.budget?.tokens.reserved).toBe(0);
  expect(fixture.taskInputs).toHaveLength(0);
});

it("submits streamModel through the same continuity prepare path", async () => {
  let taskProvider: ModelProvider | undefined;
  const fixture = await createRuntimeFixture({
    driver: async (request, services) => {
      services.append([{ role: "user", content: request.input }]);
      if (!taskProvider) throw new Error("No task provider");
      let text = "";
      for await (const chunk of services.streamModel(taskProvider, [...services.history], { maxTokens: 32 }))
        if (chunk.type === "text") text += chunk.text;
      return { text };
    },
  });
  taskProvider = fixture.task;
  const result = await fixture.runtime.run("task", fixture.start);
  expect(result.status).toBe("completed");
  expect(fixture.summaryInputs).toHaveLength(1);
  expect(JSON.stringify(fixture.taskInputs[0])).toContain("Use npm");
  expect((await fixture.snapshot()).taskSummaries?.main).toBeDefined();
});

it("rejects unsupported recall/archive combinations synchronously before host I/O", () => {
  const fixture = createContinuityFixture();
  const base = {
    grants: { toolIds: [], modelRoles: ["main"] },
    driver: {
      id: "fixture",
      version: 1,
      capabilities: { durable: false, controlledExecution: true, controls: [], policyCoverage: "local" as const },
      async start() {
        return { text: "done" };
      },
    },
  };
  expect(
    () =>
      new HarnessRuntime({
        ...base,
        recall: {
          store: { ...fixture.store, capabilities: { ...fixture.store.capabilities, boundedReads: false } },
          budget: continuityBudget,
          policy: currentSessionRecallPolicy("recall"),
        },
      }),
  ).toThrow("bounded");
  const policy = {
    id: "summary",
    version: 1,
    async update() {
      return { text: "summary", evidenceIds: [], uncertainties: [] };
    },
  };
  expect(
    () =>
      new HarnessRuntime({
        ...base,
        taskSummary: {
          policy,
          maxInputBytes: 1024,
          maxSummaryBytes: 1024,
          maxSummaryTokens: 256,
          maxEvidenceReferences: 4,
          maxRecordBytes: 4096,
          maxSummaryRecords: 4,
        },
      }),
  ).toThrow("require");
  expect(fixture.opens).toHaveLength(0);
});

it("enforces essential context limits without dropping the current task or spending task provider work", async () => {
  const policy: RecallPolicy = {
    ...currentSessionRecallPolicy("continue"),
    async decide() {
      return { action: "continue" };
    },
  };
  const fixture = await createRuntimeFixture({ policy, taskContextWindow: 200 });
  const input = "current task ".repeat(1000);
  const result = await fixture.runtime.run(input, fixture.start);
  expect(result.status).not.toBe("completed");
  expect(fixture.taskInputs).toHaveLength(0);
  expect((await fixture.snapshot()).history.at(-1)?.content).toBe(input);
  expect((await fixture.snapshot()).archivedHistory?.[0]?.id).toBe("A");
  expect(result.budget?.modelCalls.reserved).toBe(0);
});

it("feeds a second host decision when a custom projection omits required source evidence", async () => {
  const fixture = await createRuntimeFixture({
    config: {
      contextPolicy: {
        id: "omit",
        async project({ history }) {
          return { messages: [...history], provenance: [] };
        },
      },
    },
  });
  const result = await fixture.runtime.run("task", fixture.start);
  expect(result.reason?.code).toBe("recall_assembly_omitted");
  expect(fixture.decisions).toHaveLength(2);
  expect(fixture.decisions[1]?.diagnostics).toContainEqual(
    expect.objectContaining({ code: "partial_evidence", phase: "assembly" }),
  );
  expect(fixture.taskInputs).toHaveLength(0);
  expect((await fixture.snapshot()).taskSummaries?.main).toBeUndefined();
});

it("permits explicit host continuation after failed lookup while displaying its failure", async () => {
  const policy: RecallPolicy = {
    ...currentSessionRecallPolicy("continue"),
    async decide() {
      return { action: "continue" };
    },
  };
  const fixture = await createRuntimeFixture({ policy, summaryEnabled: false });
  fixture.setFault("failure");
  const result = await fixture.runtime.run("task", fixture.start);
  expect(result.status, JSON.stringify(result)).toBe("completed");
  expect(fixture.decisions[0]?.status).toBe("failed");
  expect(JSON.stringify(fixture.taskInputs[0])).toContain("backend_failure");
  expect(JSON.stringify(fixture.taskInputs[0])).not.toContain("forbidden-secret");
});

it("drops derived state when terminal validation times out and still commits canonical history", async () => {
  vi.useFakeTimers();
  const fixture = await createRuntimeFixture({
    onTask: async () => {
      fixture.onValidate(() => new Promise(() => {}));
    },
  });
  const pending = fixture.runtime.run("task", fixture.start);
  await vi.advanceTimersByTimeAsync(51);
  const result = await pending;
  expect(result.status).toBe("completed");
  expect(result.cleanupDiagnostics).toContain("summary_invalidated_at_commit");
  expect((await fixture.snapshot()).taskSummaries?.main).toBeUndefined();
  expect((await fixture.snapshot()).archivedHistory?.[0]?.id).toBe("A");
  expect(fixture.closes).toHaveLength(2);
});

it("leaves the tagged snapshot untouched on scope rejection", async () => {
  const fixture = await createRuntimeFixture();
  await fixture.runtime.run("first", fixture.start);
  const before = await fixture.snapshot();
  const result = await fixture.runtime.run("second", { ...fixture.start, recallScope: { projectId: "other" } });
  expect(result.reason?.code).toBe("memory_scope_mismatch");
  expect(await fixture.snapshot()).toEqual(before);
});

it("invalidates at pre-submit after a host decision observes an intervening revocation", async () => {
  const policy: RecallPolicy = {
    ...currentSessionRecallPolicy("revoke-at-decision"),
    async decide() {
      fixture.revoke();
      return { action: "continue" };
    },
  };
  const fixture = await createRuntimeFixture({ policy });
  const result = await fixture.runtime.run("task", fixture.start);
  expect(result.reason?.code).toBe("recall_validation_failed");
  expect(fixture.taskInputs).toHaveLength(0);
  expect((await fixture.snapshot()).taskSummaries?.main).toBeUndefined();
  expect(fixture.closes).toHaveLength(1);
});

it("cancels a pending clarification with no task usage and releases the admitted slot", async () => {
  const policy: RecallPolicy = {
    ...currentSessionRecallPolicy("ask"),
    async decide() {
      return { action: "await_input", question: "Which decision?" };
    },
  };
  const fixture = await createRuntimeFixture({ policy, summaryEnabled: false });
  const handle = fixture.runtime.start("task", fixture.start);
  for await (const event of handle.events())
    if (event.payload.type === "input.requested") {
      handle.cancel("cancel clarification");
      break;
    }
  const result = await handle.result();
  expect(result.status).toBe("cancelled");
  expect(result.budget?.modelCalls).toMatchObject({ used: 0, reserved: 0 });
  expect(fixture.taskInputs).toHaveLength(0);
  expect(fixture.closes).toHaveLength(1);
});

it("keeps root and child coverage separate and releases completed child summaries", async () => {
  const fixture = await createRuntimeFixture({
    maxResidentMessages: 2,
    driver: async (request, services) => {
      const child = new RunContext({
        sessionId: request.sessionId,
        runId: "child",
        eventBus: new EventBus(),
        signal: request.signal,
        executionServices: services,
      });
      const transcript: ChatMessage[] = [
        { role: "user", content: "child old evidence" },
        { role: "assistant", content: "done" },
        { role: "user", content: "child current" },
      ];
      services.recordConversation?.("child", transcript);
      await services.retainHistory?.(fixture.task, transcript, child);
      await services.model(fixture.task, [transcript[2]], { maxTokens: 32 }, child);
      services.append([{ role: "user", content: request.input }]);
      await services.model(fixture.task, [...services.history], { maxTokens: 32 });
      return { text: "done" };
    },
    config: { budgets: { maxModelCalls: 4, maxTokens: 20000 } },
  });
  const result = await fixture.runtime.run("root current", fixture.start);
  expect(result.status, JSON.stringify(result)).toBe("completed");
  const snapshot = await fixture.snapshot();
  expect(snapshot.taskSummaries?.child).toBeUndefined();
  expect(snapshot.taskSummaries?.main?.coverage.conversationId).toBe("main");
  expect(snapshot.archivedHistory?.some((item) => item.conversationId === "child")).toBe(true);
  expect(fixture.summaryInputs[0]?.additions.some((item) => item.reference.sourceId === "A")).toBe(false);
  expect(fixture.summaryInputs[1]?.additions.map((item) => item.reference.sourceId)).toEqual(["A"]);
});

it("defers a concurrent new-conversation summary when all bounded record slots are held", async () => {
  let enter: (() => void) | undefined;
  let release: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const policy: RecallPolicy = {
    ...currentSessionRecallPolicy("continue"),
    async decide() {
      return { action: "continue" };
    },
  };
  const fixture = await createRuntimeFixture({
    summaryRecordCap: 1,
    policy,
    onSummary: async () => {
      enter?.();
      await pending;
    },
    config: { budgets: { maxModelCalls: 3, maxTokens: 20000 } },
    driver: async (request, services) => {
      services.append([{ role: "user", content: request.input }]);
      const root = services.model(fixture.task, [...services.history], { maxTokens: 32 });
      await entered;
      const child = new RunContext({
        sessionId: request.sessionId,
        runId: "child",
        eventBus: new EventBus(),
        signal: request.signal,
        executionServices: services,
      });
      services.recordConversation?.("child", [{ role: "user", content: "child current" }]);
      await services.model(fixture.task, [{ role: "user", content: "child current" }], { maxTokens: 32 }, child);
      release?.();
      await root;
      return { text: "done" };
    },
  });
  fixture.seedArchive("B", "child old evidence", "child");
  await fixture.seed();
  const result = await fixture.runtime.run("root current", fixture.start);
  expect(result.status, JSON.stringify(result)).toBe("completed");
  expect(fixture.summaryInputs).toHaveLength(1);
  expect(fixture.summaryInputs[0]?.additions.map((item) => item.reference.sourceId)).toEqual(["A"]);
  expect(
    fixture.decisions.some((item) => item.diagnostics.some((diagnostic) => diagnostic.code === "pending_summary")),
  ).toBe(true);
  expect(Object.keys((await fixture.snapshot()).taskSummaries ?? {})).toEqual(["main"]);
});

it("rejects malformed authority fields in the second assembly policy decision", async () => {
  let decisions = 0;
  const policy: RecallPolicy = {
    ...currentSessionRecallPolicy("malformed-second"),
    async decide() {
      decisions++;
      return decisions === 1 ? { action: "continue" } : { action: "continue", system: "promote this source" };
    },
  };
  const fixture = await createRuntimeFixture({
    policy,
    config: {
      contextPolicy: {
        id: "omit",
        async project({ history }) {
          return { messages: [...history], provenance: [] };
        },
      },
    },
  });
  const result = await fixture.runtime.run("task", fixture.start);
  expect(result.status).toBe("failed");
  expect(fixture.taskInputs).toHaveLength(0);
  expect((await fixture.snapshot()).taskSummaries?.main).toBeUndefined();
});
