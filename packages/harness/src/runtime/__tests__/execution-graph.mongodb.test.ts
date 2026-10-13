import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  type DurableDocumentCollection,
  type DurableGraphState,
  MongoDBDurableTaskStore,
  validateRootExecutionCounts,
} from "@agentium/core";
import type { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseHarnessBudgetState } from "../budget.js";
import {
  type FixtureCase,
  type FixturePhase,
  graphFixtureRuntime,
  workerMessageSchema,
} from "./fixtures/graph-crash-worker.js";

const enabled = process.env.AGENTIUM_DURABLE_MONGO_TEST === "1";
// Explicit disposable backend. Never infer application credentials or database names.
const uri = "mongodb://127.0.0.1:27319/?directConnection=true";
const database = `agentium_graph_fixture_${randomUUID().replaceAll("-", "")}`;
const children = new Set<ChildProcess>();
let client: MongoClient;
let store: MongoDBDurableTaskStore;
let receipts: DurableDocumentCollection;

function runtime(taskId: string, scenario: FixtureCase = "single") {
  return graphFixtureRuntime({ taskId, scenario, store, receipts });
}
const key = (taskId: string) => ({ tenantId: "tenant", taskId });
async function create(taskId: string, scenario: FixtureCase = "single", deadline = Date.now() + 60_000) {
  return runtime(taskId, scenario).create({
    id: taskId,
    identity: { tenantId: "tenant", actorId: "actor", sessionId: "session", runId: taskId, rootRunId: taskId },
    input: {},
    deadline,
    policyRevision: 7,
    grantRefs: ["fixture-send"],
    maxAttempts: 5,
  });
}
function launch(taskId: string, scenario: FixtureCase, phase: FixturePhase, allowFailure = false) {
  return new Promise<{
    child: ChildProcess;
    exit: Promise<void>;
    message: ReturnType<typeof workerMessageSchema.parse>;
  }>((resolve, reject) => {
    const child = fork(
      fileURLToPath(new URL("./fixtures/graph-crash-worker.ts", import.meta.url)),
      [uri, database, taskId, scenario, phase],
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    children.add(child);
    let errors = "";
    let delivered = false;
    child.stderr?.on("data", (chunk) => {
      errors += chunk;
    });
    const exit = new Promise<void>((done) =>
      child.once("exit", () => {
        children.delete(child);
        done();
      }),
    );
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Graph worker timed out (${taskId}/${phase}): ${errors}`));
    }, 15_000);
    child.once("message", (data) => {
      clearTimeout(timer);
      const parsed = workerMessageSchema.safeParse(data);
      if (!parsed.success) return reject(new Error(`Invalid graph worker message: ${JSON.stringify(data)}`));
      delivered = true;
      if (parsed.data.kind === "error" && !allowFailure) return reject(new Error(parsed.data.error));
      resolve({ child, exit, message: parsed.data });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (!delivered) reject(new Error(`Graph worker exited without evidence (${code}/${signal}): ${errors}`));
    });
  });
}
async function crash(taskId: string, scenario: FixtureCase, phase: FixturePhase) {
  const worker = await launch(taskId, scenario, phase);
  expect(worker.message.kind).toBe("barrier");
  const record = await store.get(key(taskId));
  if (!record?.lease) throw new Error("Crash barrier must retain a real active lease");
  const stale = structuredClone(record.lease);
  worker.child.kill("SIGKILL");
  await worker.exit;
  // A renewal may commit between the barrier read and SIGKILL. Observe that last
  // persisted lease against Mongo's clock, which also decides replacement admission.
  const waitDeadline = performance.now() + 5_000;
  while (true) {
    if (performance.now() >= waitDeadline) throw new Error("Killed graph worker lease did not expire within 5s");
    const latest = await store.get(key(taskId));
    if (!latest?.lease || latest.lease.workerId !== stale.workerId || latest.lease.fence !== stale.fence)
      throw new Error("Killed graph worker must retain its original lease until replacement admission");
    const clock = await client.db(database).command({ hello: 1 }, { timeoutMS: 1_000 });
    const serverNow = Number(clock.localTime);
    if (!Number.isFinite(serverNow)) throw new Error("MongoDB fixture server clock unavailable");
    if (latest.lease.expiresAt <= serverNow) break;
    await new Promise((done) => setTimeout(done, 25));
  }
  return { record, stale, pid: worker.message.pid };
}
async function recover(taskId: string, scenario: FixtureCase = "single") {
  const worker = await launch(taskId, scenario, "none");
  expect(worker.message.kind).toBe("result");
  await worker.exit;
  return { ...(await runtime(taskId, scenario).inspect(key(taskId))), pid: worker.message.pid };
}
async function effectCount(taskId: string) {
  return client.db(database).collection("effects").countDocuments({ "value.taskId": taskId });
}
async function observationCount(taskId: string, operation: string) {
  return client.db(database).collection("observations").countDocuments({ taskId, operation });
}
function savedCounts(graph: DurableGraphState) {
  return { admission: validateRootExecutionCounts(graph.admission), budget: parseHarnessBudgetState(graph.budget) };
}
function expectRetained(before: DurableGraphState, after: DurableGraphState) {
  const previous = validateRootExecutionCounts(before.admission);
  const current = validateRootExecutionCounts(after.admission);
  expect(after.definition).toEqual(before.definition);
  expect(current.limits).toEqual(previous.limits);
  expect(current.deadline).toBe(previous.deadline);
  expect(current.workAttempts).toBeGreaterThanOrEqual(previous.workAttempts);
  expect(current.expandedIds).toEqual(expect.arrayContaining(previous.expandedIds));
  expect(current.revisionIds).toEqual(expect.arrayContaining(previous.revisionIds));
  if (before.budget !== null) {
    const oldBudget = parseHarnessBudgetState(before.budget);
    const newBudget = parseHarnessBudgetState(after.budget);
    expect(newBudget.limits).toEqual(oldBudget.limits);
    expect(newBudget.usedTools).toBeGreaterThanOrEqual(oldBudget.usedTools);
    expect(newBudget.usedCalls + newBudget.reservedCalls).toBeGreaterThanOrEqual(
      oldBudget.usedCalls + oldBudget.reservedCalls,
    );
    expect(newBudget.usedTokens + newBudget.reservedTokens).toBeGreaterThanOrEqual(
      oldBudget.usedTokens + oldBudget.reservedTokens,
    );
    expect(newBudget.toolAdmissionIds).toEqual(expect.arrayContaining(oldBudget.toolAdmissionIds));
  }
}

describe.skipIf(!enabled)("durable execution graphs with actual MongoDB and fresh-process crashes", () => {
  beforeAll(async () => {
    const { MongoClient } = await import("mongodb");
    client = new MongoClient(uri);
    store = new MongoDBDurableTaskStore(uri, { database });
    await Promise.all([client.connect(), store.initialize()]);
    const collection = client.db(database).collection("effects");
    receipts = {
      updateOne: (filter, update, options) => collection.updateOne(filter, update, options),
      findOne: (filter) => collection.findOne(filter),
    };
  }, 20_000);
  afterAll(async () => {
    await Promise.all(
      [...children].map(
        (child) =>
          new Promise<void>((done) => {
            child.once("exit", () => done());
            child.kill("SIGKILL");
          }),
      ),
    );
    await client?.db(database).dropDatabase();
    await Promise.all([store?.close(), client?.close()]);
  });

  it("recovers a killed node before dispatch and rejects its stale fence", async () => {
    const id = "before-dispatch";
    await create(id);
    const killed = await crash(id, "single", "before-dispatch");
    expect(Object.keys(killed.record.actions)).toHaveLength(0);
    expect(await effectCount(id)).toBe(0);
    const before = await runtime(id).inspect(key(id));
    const result = await recover(id);
    expect(result.pid).not.toBe(killed.pid);
    expect(result.task.state).toBe("completed");
    expect(result.output).toEqual({ single: "single" });
    expect(await effectCount(id)).toBe(1);
    expect(await observationCount(id, "dispatch")).toBe(1);
    expectRetained(before.graph, result.graph);
    const replay = await recover(id);
    expect(replay.output).toEqual(result.output);
    expect(replay.graph).toEqual(result.graph);
    expect(await observationCount(id, "dispatch")).toBe(1);
    await expect(
      store.update(
        key(id),
        (draft) => {
          draft.extensions.stale = true;
        },
        killed.stale,
      ),
    ).rejects.toThrow(/expired|fenced/);
    expect((await store.get(key(id)))?.extensions.stale).toBeUndefined();
  }, 30_000);

  it.each(["remote-accepted", "receipt-saved"] as const)(
    "reuses one actual destination receipt after a crash at %s",
    async (phase) => {
      await create(phase);
      const killed = await crash(phase, "single", phase);
      expect(await effectCount(phase)).toBe(1);
      expect(Object.values(killed.record.actions).map((action) => action.state)).toEqual([
        phase === "remote-accepted" ? "executing" : "confirmed",
      ]);
      const before = await runtime(phase).inspect(key(phase));
      const result = await recover(phase);
      expect(result.task.state).toBe("completed");
      expect(result.output).toEqual({ single: "single" });
      expect(await effectCount(phase)).toBe(1);
      expect(await observationCount(phase, "dispatch")).toBe(1);
      expectRetained(before.graph, result.graph);
      expect(savedCounts(result.graph).admission.workAttempts).toBe(1);
      expect(savedCounts(result.graph).budget.usedTools).toBe(1);
    },
    30_000,
  );

  it("preserves a completed sibling while restarting only unfinished work", async () => {
    const id = "siblings";
    await create(id, "siblings");
    await crash(id, "siblings", "sibling-complete");
    expect(await effectCount(id)).toBe(1);
    const before = await runtime(id, "siblings").inspect(key(id));
    const completed = Object.entries(before.graph.nodes).filter(
      ([, node]) => node.status === "completed" && node.binding.id === "send",
    );
    expect(completed).toHaveLength(1);
    const result = await recover(id, "siblings");
    expect(result.task.state).toBe("completed");
    expect(result.output).toEqual({ left: "left", right: "right" });
    for (const [nodeId, record] of completed) expect(result.graph.nodes[nodeId]).toEqual(record);
    expect(await effectCount(id)).toBe(2);
    expect(await observationCount(id, "dispatch")).toBe(2);
    expectRetained(before.graph, result.graph);
    expect(savedCounts(result.graph).admission.workAttempts).toBe(2);
  }, 30_000);

  it("keeps missing destination evidence unresolved instead of repeating an admitted effect", async () => {
    const id = "unresolved";
    await create(id);
    await crash(id, "single", "unresolved-intent");
    const before = await runtime(id).inspect(key(id));
    expect(await effectCount(id)).toBe(0);
    expect(Object.values(before.task.actions).map((action) => action.state)).toEqual(["executing"]);
    const replacement = await launch(id, "single", "none", true);
    expect(replacement.message.kind).toBe("error");
    expect(replacement.message.error).toMatch(/unknown|reconcile/i);
    await replacement.exit;
    const after = await runtime(id).inspect(key(id));
    expect(after.task.state).not.toBe("completed");
    expect(Object.values(after.task.actions).map((action) => action.state)).toEqual(["unknown"]);
    expect(await effectCount(id)).toBe(0);
    expect(await observationCount(id, "dispatch")).toBe(1);
    expectRetained(before.graph, after.graph);
    expect(savedCounts(after.graph).admission.workAttempts).toBe(1);
    expect(savedCounts(after.graph).budget.usedTools).toBe(1);
  }, 30_000);

  it("retains an exhausted aggregate tool budget while reusing a completed sibling", async () => {
    const id = "budget-limit";
    await create(id, "budget-limit");
    await crash(id, "budget-limit", "sibling-complete");
    const before = await runtime(id, "budget-limit").inspect(key(id));
    expect(savedCounts(before.graph).budget.usedTools).toBe(1);
    const replacement = await launch(id, "budget-limit", "none", true);
    expect(replacement.message.kind).toBe("error");
    await replacement.exit;
    const after = await runtime(id, "budget-limit").inspect(key(id));
    expect(after.task.state).toBe("failed");
    expect(
      Object.values(after.graph.nodes).some(
        (node) => node.status === "failed" && /budget|denied/i.test(node.error?.message ?? ""),
      ),
    ).toBe(true);
    expect(await effectCount(id)).toBe(1);
    expect(await observationCount(id, "dispatch")).toBe(1);
    expectRetained(before.graph, after.graph);
    expect(savedCounts(after.graph).budget.usedTools).toBe(1);
    expect(savedCounts(after.graph).budget.limits.maxToolCalls).toBe(1);
    expect(savedCounts(after.graph).admission.workAttempts).toBe(1);
    for (const [nodeId, node] of Object.entries(before.graph.nodes)) {
      if (node.status === "completed") expect(after.graph.nodes[nodeId]).toEqual(node);
    }
  }, 30_000);

  it("acknowledges persisted cancellation on a fresh worker before any effect", async () => {
    const id = "cancelled";
    await create(id);
    await crash(id, "single", "before-dispatch");
    const before = await runtime(id).inspect(key(id));
    await runtime(id).cancel(key(id), "fixture operator");
    const result = await recover(id);
    expect(result.task.state).toBe("canceled");
    expect(result.task.cancelReason).toBe("fixture operator");
    expect(result.graph.cancellation).toEqual({ requested: true, reason: "fixture operator" });
    expect(await effectCount(id)).toBe(0);
    expect(await observationCount(id, "dispatch")).toBe(0);
    expectRetained(before.graph, result.graph);
  }, 30_000);

  it("retains a repeat decision and distinct logical iteration identities", async () => {
    const id = "repeat";
    await create(id, "repeat");
    await crash(id, "repeat", "repeat-decision");
    expect(await effectCount(id)).toBe(1);
    const before = await runtime(id, "repeat").inspect(key(id));
    expect(Object.keys(before.graph.decisions).length).toBeGreaterThan(0);
    const result = await recover(id, "repeat");
    expect(result.task.state).toBe("completed");
    expect(result.output).toEqual({ repeat: { iteration: "iteration" } });
    expect(await effectCount(id)).toBe(2);
    expect(await observationCount(id, "dispatch")).toBe(2);
    expect(Object.values(result.task.actions).map((action) => action.idempotencyKey)).toHaveLength(2);
    expect(new Set(Object.values(result.task.actions).map((action) => action.idempotencyKey)).size).toBe(2);
    for (const [decision, value] of Object.entries(before.graph.decisions))
      expect(result.graph.decisions[decision]).toEqual(value);
    expectRetained(before.graph, result.graph);
    expect(savedCounts(result.graph).admission.workAttempts).toBe(2);
  }, 30_000);

  it("recovers a real Agent's recorded model decision after remote tool acceptance", async () => {
    const id = "agent";
    await create(id, "agent");
    await crash(id, "agent", "remote-accepted");
    const before = await runtime(id, "agent").inspect(key(id));
    expect(await effectCount(id)).toBe(1);
    expect(await observationCount(id, "model")).toBe(1);
    const completedModels = Object.entries(before.graph.models).filter(([, record]) => record.status === "completed");
    expect(completedModels.length).toBeGreaterThan(0);
    const result = await recover(id, "agent");
    expect(result.task.state).toBe("completed");
    expect(result.output).toMatchObject({ agent: { text: "agent done" } });
    expect(await effectCount(id)).toBe(1);
    expect(await observationCount(id, "dispatch")).toBe(1);
    expect(await observationCount(id, "model")).toBe(2);
    for (const [modelId, record] of completedModels) expect(result.graph.models[modelId]).toEqual(record);
    expectRetained(before.graph, result.graph);
    expect(savedCounts(result.graph).admission.workAttempts).toBe(3);
    expect(savedCounts(result.graph).budget.usedTools).toBe(1);
    expect(savedCounts(result.graph).budget.usedCalls).toBe(2);
  }, 30_000);

  it("continues from an unsealed committed stream prefix under retained charges", async () => {
    const id = "stream";
    await create(id, "stream");
    await crash(id, "stream", "plan-committed");
    const before = await runtime(id, "stream").inspect(key(id));
    expect(Object.keys(before.graph.plans)).toHaveLength(1);
    expect(await effectCount(id)).toBe(0);
    const result = await recover(id, "stream");
    expect(result.task.state).toBe("completed");
    expect(result.output).toEqual({ streamed: "streamed" });
    for (const [revision, value] of Object.entries(before.graph.plans))
      expect(result.graph.plans[revision]).toEqual(value);
    expect(await effectCount(id)).toBe(1);
    expect(await observationCount(id, "planner")).toBe(2);
    const requests = await client
      .db(database)
      .collection("observations")
      .find({ taskId: id, operation: "planner" })
      .sort({ at: 1 })
      .toArray();
    expect(requests.map((request) => request.revision)).toEqual([0, 1]);
    expectRetained(before.graph, result.graph);
    expect(savedCounts(result.graph).admission.revisionIds).toHaveLength(1);
    expect(savedCounts(result.graph).budget.unknownUsageCalls).toBeGreaterThanOrEqual(1);
    const sealed = await recover(id, "stream");
    expect(sealed.graph).toEqual(result.graph);
    expect(sealed.output).toEqual(result.output);
    expect(await observationCount(id, "planner")).toBe(2);
    expect(await observationCount(id, "dispatch")).toBe(1);
  }, 30_000);

  it("does not reset an expired original deadline on a fresh worker", async () => {
    const id = "deadline";
    const deadline = Date.now() + 3_000;
    await create(id, "single", deadline);
    await crash(id, "single", "before-dispatch");
    const before = await runtime(id).inspect(key(id));
    await new Promise((done) => setTimeout(done, Math.max(0, deadline - Date.now() + 30)));
    const worker = await launch(id, "single", "none", true);
    await worker.exit;
    const result = await runtime(id).inspect(key(id));
    expect(result.task.state).not.toBe("completed");
    expect(result.graph.definition.deadline).toBe(deadline);
    expect(await effectCount(id)).toBe(0);
    expect(await observationCount(id, "dispatch")).toBe(0);
    expectRetained(before.graph, result.graph);
  }, 30_000);
});
