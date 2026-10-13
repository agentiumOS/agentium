import { EventBus, RunContext } from "@agentium/core";
import { afterEach, expect, it, vi } from "vitest";
import { openRecallCycle } from "../recall.js";
import {
  advanceTaskSummaryCoverage,
  readTaskSummaryAdditions,
  type TaskSummaryConfig,
  type TaskSummaryPolicy,
  updateTaskSummary,
  validateTaskSummaryRecord,
} from "../task-summary.js";
import { continuityBudget, continuityScope, createContinuityFixture } from "./fixtures/continuity-fixture.js";

afterEach(() => vi.useRealTimers());
const policy: TaskSummaryPolicy = {
  id: "summary",
  version: 1,
  async update(input) {
    return {
      text: input.additions.map((item) => item.text).join("; "),
      evidenceIds: [...(input.previous?.draft.evidenceIds ?? []), ...input.additions.map((item) => item.id)],
      uncertainties: [],
    };
  },
};
const config: TaskSummaryConfig = {
  policy,
  maxInputBytes: 8192,
  maxSummaryBytes: 2048,
  maxSummaryTokens: 512,
  maxEvidenceReferences: 8,
  maxRecordBytes: 8192,
  maxSummaryRecords: 4,
};
const context = (signal = new AbortController().signal) =>
  new RunContext({ sessionId: continuityScope.sessionId, eventBus: new EventBus(), signal });

it("reads exact contiguous complete groups, preserving negation and correction context", async () => {
  const fixture = createContinuityFixture();
  fixture.seedArchive("A", ["Use npm", "Correction: do not use npm; use pnpm"]);
  const cycle = await openRecallCycle({
    store: fixture.store,
    scope: continuityScope,
    budget: continuityBudget,
    signal: new AbortController().signal,
  });
  const batch = await readTaskSummaryAdditions(cycle, {
    archives: fixture.archives,
    conversationId: "main",
    maxInputBytes: 8192,
  });
  expect(batch.additions.map((entry) => entry.text)).toEqual(["Use npm", "Correction: do not use npm; use pnpm"]);
  expect(batch.coverage).toMatchObject({ throughArchiveOrdinal: 0, throughArchiveId: "A", throughMessage: 2 });
  await cycle.close();
});

it("updates incrementally from previous record plus new archive and retains citation IDs", async () => {
  const fixture = createContinuityFixture();
  fixture.seedArchive("A", "Use npm");
  const update = vi.fn(policy.update);
  const first = await openRecallCycle({
    store: fixture.store,
    scope: continuityScope,
    budget: continuityBudget,
    signal: new AbortController().signal,
  });
  const a = await readTaskSummaryAdditions(first, {
    archives: fixture.archives,
    conversationId: "main",
    maxInputBytes: 8192,
  });
  expect(a.coverage).toBeDefined();
  if (!a.coverage) throw new Error("Missing A coverage");
  const one = await updateTaskSummary({
    additions: a.additions,
    coverage: a.coverage,
    archives: fixture.archives,
    scope: continuityScope,
    config: { ...config, policy: { ...policy, update } },
    ctx: context(),
    cycle: first,
    taskTokenFloor: 100,
    remainingTokens: 10000,
  });
  await first.close();
  expect(one.updated).toBe(true);
  expect(one.record?.evidence).toMatchObject([{ id: "A:0", reference: { sourceId: "A" } }]);
  fixture.seedArchive("B", "Correction: use pnpm");
  const second = await openRecallCycle({
    store: fixture.store,
    scope: continuityScope,
    budget: continuityBudget,
    signal: new AbortController().signal,
  });
  const b = await readTaskSummaryAdditions(second, {
    previous: one.record,
    archives: fixture.archives,
    conversationId: "main",
    maxInputBytes: 8192,
  });
  if (!b.coverage) throw new Error("Missing B coverage");
  const two = await updateTaskSummary({
    previous: one.record,
    additions: b.additions,
    coverage: b.coverage,
    archives: fixture.archives,
    scope: continuityScope,
    config: { ...config, policy: { ...policy, update } },
    ctx: context(),
    cycle: second,
    taskTokenFloor: 100,
    remainingTokens: 10000,
  });
  expect(update.mock.calls[1]?.[0].additions.map((item) => item.reference.sourceId)).toEqual(["B"]);
  expect(update.mock.calls[1]?.[0].previous?.coverage.throughArchiveId).toBe("A");
  expect(two.record).toMatchObject({
    revision: 2,
    previousRevision: 1,
    coverage: { throughArchiveOrdinal: 1, throughArchiveId: "B", throughMessage: 1 },
    evidence: [{ id: "A:0" }, { id: "B:0" }],
  });
  expect(fixture.sourceReads.map((item) => item.reference.sourceId)).toEqual(["A", "B"]);
  await second.close();
});

it("stops contiguous reconstruction at a deleted archive while later evidence remains independently queryable", async () => {
  const fixture = createContinuityFixture();
  fixture.seedArchive("A", "first");
  fixture.seedArchive("B", "missing");
  fixture.seedArchive("C", "independently relevant");
  fixture.deleteSource("B");
  const cycle = await openRecallCycle({
    store: fixture.store,
    scope: continuityScope,
    budget: continuityBudget,
    signal: new AbortController().signal,
  });
  const batch = await readTaskSummaryAdditions(cycle, {
    archives: fixture.archives,
    conversationId: "main",
    maxInputBytes: 8192,
  });
  expect(batch.coverage?.throughArchiveId).toBe("A");
  expect(batch.additions.map((item) => item.reference.sourceId)).toEqual(["A"]);
  expect(batch.diagnostics).toMatchObject([{ code: "unavailable_coverage" }]);
  const query = await cycle.query("independently");
  expect(query.excerpts.map((item) => item.reference.sourceId)).toEqual(["C"]);
  await cycle.close();
});

it("rejects gaps, overlap and partial correction context rather than inventing archive coverage", async () => {
  const fixture = createContinuityFixture();
  fixture.seedArchive("A", ["first", "second"]);
  const cycle = await openRecallCycle({
    store: fixture.store,
    scope: continuityScope,
    budget: continuityBudget,
    signal: new AbortController().signal,
  });
  const batch = await readTaskSummaryAdditions(cycle, {
    archives: fixture.archives,
    conversationId: "main",
    maxInputBytes: 8192,
  });
  expect(advanceTaskSummaryCoverage(undefined, batch.additions.slice(1), fixture.archives, "main")).toBeUndefined();
  expect(
    advanceTaskSummaryCoverage(undefined, [batch.additions[0], batch.additions[0]], fixture.archives, "main"),
  ).toBeUndefined();
  expect(
    advanceTaskSummaryCoverage(
      undefined,
      batch.additions.map((item) => ({ ...item, completeness: "partial", omissions: ["correction_context"] })),
      fixture.archives,
      "main",
    ),
  ).toBeUndefined();
  await cycle.close();
});

it("isolates archive ordinals and coverage between root and child conversations", async () => {
  const fixture = createContinuityFixture();
  fixture.seedArchive("A", "root", "main");
  fixture.seedArchive("B", "child", "child");
  fixture.seedArchive("C", "root next", "main");
  const cycle = await openRecallCycle({
    store: fixture.store,
    scope: continuityScope,
    budget: continuityBudget,
    signal: new AbortController().signal,
  });
  const batch = await readTaskSummaryAdditions(cycle, {
    archives: fixture.archives,
    conversationId: "child",
    maxInputBytes: 8192,
  });
  expect(batch.coverage).toMatchObject({ conversationId: "child", throughArchiveOrdinal: 0, throughArchiveId: "B" });
  expect(batch.additions.map((item) => item.text)).toEqual(["child"]);
  await cycle.close();
});

it("skips derived work under the explicit advisory task floor and record-count cap", async () => {
  const fixture = createContinuityFixture();
  fixture.seedArchive("A", "first");
  const update = vi.fn(policy.update);
  const cycle = await openRecallCycle({
    store: fixture.store,
    scope: continuityScope,
    budget: continuityBudget,
    signal: new AbortController().signal,
  });
  const batch = await readTaskSummaryAdditions(cycle, {
    archives: fixture.archives,
    conversationId: "main",
    maxInputBytes: 8192,
  });
  if (!batch.coverage) throw new Error("Missing coverage");
  const base = {
    additions: batch.additions,
    coverage: batch.coverage,
    archives: fixture.archives,
    scope: continuityScope,
    config: { ...config, policy: { ...policy, update } },
    ctx: context(),
    cycle,
    taskTokenFloor: 100,
    remainingTokens: 10000,
  };
  expect(await updateTaskSummary({ ...base, remainingTokens: 200 })).toMatchObject({
    updated: false,
    diagnostics: [{ code: "pending_summary" }],
  });
  expect(await updateTaskSummary({ ...base, recordCount: config.maxSummaryRecords })).toMatchObject({
    updated: false,
    diagnostics: [{ code: "pending_summary" }],
  });
  expect(update).not.toHaveBeenCalled();
  await cycle.close();
});

it("rejects unknown/duplicate citations and serialized record overflow without advancing a frontier", async () => {
  for (const failure of ["unknown", "duplicate", "record"] as const) {
    const fixture = createContinuityFixture();
    fixture.seedArchive("A", "first");
    const cycle = await openRecallCycle({
      store: fixture.store,
      scope: continuityScope,
      budget: continuityBudget,
      signal: new AbortController().signal,
    });
    const batch = await readTaskSummaryAdditions(cycle, {
      archives: fixture.archives,
      conversationId: "main",
      maxInputBytes: 8192,
    });
    if (!batch.coverage) throw new Error("Missing coverage");
    const currentPolicy: TaskSummaryPolicy = {
      ...policy,
      async update() {
        return {
          text: "derived",
          evidenceIds: failure === "unknown" ? ["missing"] : failure === "duplicate" ? ["A:0", "A:0"] : ["A:0"],
          uncertainties: [],
        };
      },
    };
    const result = await updateTaskSummary({
      additions: batch.additions,
      coverage: batch.coverage,
      archives: fixture.archives,
      scope: continuityScope,
      config: { ...config, policy: currentPolicy, ...(failure === "record" ? { maxRecordBytes: 100 } : {}) },
      ctx: context(),
      cycle,
      taskTokenFloor: 100,
      remainingTokens: 10000,
    });
    expect(result.updated).toBe(false);
    expect(result.record).toBeUndefined();
    await cycle.close();
  }
});

it("rejects an in-flight refresh after deletion and uses a fresh validation deadline after model latency", async () => {
  vi.useFakeTimers();
  const fixture = createContinuityFixture();
  fixture.seedArchive("A", "first");
  const cycle = await openRecallCycle({
    store: fixture.store,
    scope: continuityScope,
    budget: continuityBudget,
    signal: new AbortController().signal,
  });
  const batch = await readTaskSummaryAdditions(cycle, {
    archives: fixture.archives,
    conversationId: "main",
    maxInputBytes: 8192,
  });
  if (!batch.coverage) throw new Error("Missing coverage");
  const delayed: TaskSummaryPolicy = {
    ...policy,
    async update(input, ctx) {
      await vi.advanceTimersByTimeAsync(150);
      fixture.deleteSource("A");
      return policy.update(input, ctx);
    },
  };
  const result = await updateTaskSummary({
    additions: batch.additions,
    coverage: batch.coverage,
    archives: fixture.archives,
    scope: continuityScope,
    config: { ...config, policy: delayed },
    ctx: context(),
    cycle,
    taskTokenFloor: 100,
    remainingTokens: 10000,
  });
  expect(result).toMatchObject({ updated: false, diagnostics: [{ code: "revision_changed" }] });
  expect(result.record).toBeUndefined();
  expect(fixture.validations[0]?.limits.deadline).toBe(Date.now() + 50);
  await cycle.close();
});

it("rejects scope/policy/frontier corruption on snapshot reuse", async () => {
  const fixture = createContinuityFixture();
  fixture.seedArchive("A", "first");
  const cycle = await openRecallCycle({
    store: fixture.store,
    scope: continuityScope,
    budget: continuityBudget,
    signal: new AbortController().signal,
  });
  const batch = await readTaskSummaryAdditions(cycle, {
    archives: fixture.archives,
    conversationId: "main",
    maxInputBytes: 8192,
  });
  if (!batch.coverage) throw new Error("Missing coverage");
  const result = await updateTaskSummary({
    additions: batch.additions,
    coverage: batch.coverage,
    archives: fixture.archives,
    scope: continuityScope,
    config,
    ctx: context(),
    cycle,
    taskTokenFloor: 100,
    remainingTokens: 10000,
  });
  const base = { scope: continuityScope, policy, archives: fixture.archives, config, viewRevision: "1" };
  expect(validateTaskSummaryRecord(result.record, base)).toBeDefined();
  expect(
    validateTaskSummaryRecord(result.record, { ...base, scope: { ...continuityScope, projectId: "other" } }),
  ).toBeUndefined();
  expect(validateTaskSummaryRecord(result.record, { ...base, policy: { ...policy, version: 2 } })).toBeUndefined();
  expect(
    validateTaskSummaryRecord({ ...result.record, coverage: { ...result.record?.coverage, throughMessage: 2 } }, base),
  ).toBeUndefined();
  expect(validateTaskSummaryRecord({ ...result.record, evidence: [] }, base)).toBeUndefined();
  await cycle.close();
});

it("distinguishes a host conditional publication fence from read-fence-only storage", () => {
  const protectedStore = createContinuityFixture({ conditionalPublication: true });
  const readFenceOnly = createContinuityFixture();
  const epoch = protectedStore.viewRevision;
  protectedStore.revoke();
  readFenceOnly.revoke();
  const protectedWrite = vi.fn();
  const unguardedWrite = vi.fn();
  expect(protectedStore.publishIfCurrent(epoch, protectedWrite)).toBe(false);
  expect(protectedWrite).not.toHaveBeenCalled();
  expect(readFenceOnly.publishIfCurrent(epoch, unguardedWrite)).toBe(true);
  expect(unguardedWrite).toHaveBeenCalledOnce();
});
