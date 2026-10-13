import {
  DurableGraphJournal,
  DurableTaskSupervisor,
  durableDigest,
  InMemoryDurableTaskStore,
  RootExecutionController,
  type RootExecutionLimits,
} from "@agentium/core";
import { describe, expect, it } from "vitest";
import { z } from "zod/v3";
import { validateExecutionPlan } from "../execution-proposal.js";
import type { ExecutionPlan, GraphBinding, ValidatedPlanCommitFrame } from "../graph-contracts.js";
import { commitExecutionPlan, readExecutionPlan } from "../plan-commit.js";

const catalog: GraphBinding[] = [
  {
    id: "tool",
    version: "1",
    kind: "tool",
    input: z.object({ value: z.number() }),
    output: z.number(),
    recovery: "pure",
    tool: {
      name: "tool",
      description: "fixture",
      parameters: z.object({ value: z.number() }),
      execute: async () => "fixture",
    },
  },
];
const validationLimits = { maxBytes: 10000, maxNodes: 20, maxDepth: 20, maxConcurrency: 3, durable: true };
function frame(revision = 1, value = 1, nodes = ["a", "b"]): ValidatedPlanCommitFrame {
  const plan: ExecutionPlan = {
    schemaVersion: 1,
    revision,
    nodes: nodes.map((id) => ({ id, binding: "tool", version: "1", args: { value } })),
  };
  return { baseRevision: revision - 1, validated: validateExecutionPlan(plan, catalog, validationLimits) };
}
async function fixture(limits: RootExecutionLimits = {}) {
  let now = Date.now();
  const key = { tenantId: "tenant", taskId: "task" };
  const store = new InMemoryDurableTaskStore({ now: () => now });
  const supervisor = new DurableTaskSupervisor(store, { leaseMs: 100 });
  await store.create({
    id: "task",
    identity: { tenantId: "tenant", actorId: "actor", sessionId: "session", runId: "run", rootRunId: "root" },
    manifestHash: "manifest",
    inputRef: "input",
    policyRevision: 1,
    grantRefs: [],
    budget: { maxAttempts: 20 },
  });
  const first = await supervisor.claim(key, "first");
  if (!first?.lease) throw new Error("Fixture lease missing");
  const definition = {
    id: "graph",
    version: "1",
    catalogDigest: frame().validated.catalogDigest,
    input: {},
    limits: {},
    deadline: now + 50,
  };
  const journal = new DurableGraphJournal(store, key, first.lease, definition);
  const root = new RootExecutionController(limits);
  const restart = async () => {
    now += 101;
    const claimed = await supervisor.claim(key, "second");
    if (!claimed?.lease) throw new Error("Recovery lease missing");
    return new DurableGraphJournal(store, key, claimed.lease, definition);
  };
  return {
    store,
    supervisor,
    key,
    journal,
    root,
    restart,
    advance: (amount: number) => {
      now += amount;
    },
  };
}

describe("authoritative materialized plan commits", () => {
  it("atomically records the revision and pending incarnations before execution", async () => {
    const f = await fixture();
    expect(await readExecutionPlan(f.journal, "episode")).toBeUndefined();
    const committed = await commitExecutionPlan(f.journal, f.root, "episode", frame());
    const state = await f.journal.snapshot();
    expect(Object.keys(committed.nodeKeys)).toEqual(["a", "b"]);
    expect(committed.nodeKeys.a).not.toBe(committed.nodeKeys.b);
    expect(state.nodes[committed.nodeKeys.a]).toMatchObject({
      status: "pending",
      binding: { id: "tool", version: "1", kind: "tool" },
      attempts: [],
    });
    expect(state.plans["episode/revision/1"]).toBeDefined();
    expect(await readExecutionPlan(f.journal, "episode")).toEqual(committed);
    expect(f.root.snapshot()).toMatchObject({ expandedNodes: 2, planRevisions: 1 });
  });
  it("reuses unchanged node keys while changed and removed pending definitions become tombstones", async () => {
    const f = await fixture();
    const first = await commitExecutionPlan(f.journal, f.root, "episode", frame());
    const secondFrame = frame(2, 1, ["a", "c"]);
    secondFrame.validated.plan.nodes[1].args.value = 2;
    secondFrame.validated = validateExecutionPlan(secondFrame.validated.plan, catalog, validationLimits);
    const second = await commitExecutionPlan(f.journal, f.root, "episode", secondFrame);
    expect(second.nodeKeys.a).toBe(first.nodeKeys.a);
    const third = await commitExecutionPlan(f.journal, f.root, "episode", frame(3, 3, ["a", "c"]));
    expect(third.nodeKeys.a).not.toBe(first.nodeKeys.a);
    expect((await f.journal.snapshot()).nodes[first.nodeKeys.b].status).toBe("superseded");
    expect((await f.journal.snapshot()).nodes[first.nodeKeys.a].status).toBe("superseded");
    expect(f.root.snapshot()).toMatchObject({ expandedNodes: 5, planRevisions: 3 });
  });
  it("returns exact retransmissions without changing current revision or charging again", async () => {
    const f = await fixture();
    const first = await commitExecutionPlan(f.journal, f.root, "episode", frame());
    await commitExecutionPlan(f.journal, f.root, "episode", frame(2));
    expect(await commitExecutionPlan(f.journal, f.root, "episode", frame())).toEqual(first);
    expect((await readExecutionPlan(f.journal, "episode"))?.validated.plan.revision).toBe(2);
    expect(f.root.snapshot()).toMatchObject({ expandedNodes: 2, planRevisions: 2 });
  });
  it("rejects conflicting retransmissions, stale bases and skipped revisions without advancing the pointer", async () => {
    const f = await fixture();
    await commitExecutionPlan(f.journal, f.root, "episode", frame());
    await expect(commitExecutionPlan(f.journal, f.root, "episode", frame(1, 9))).rejects.toThrow();
    await expect(commitExecutionPlan(f.journal, f.root, "episode", frame(3))).rejects.toThrow();
    await expect(commitExecutionPlan(f.journal, f.root, "episode", { ...frame(2), baseRevision: 0 })).rejects.toThrow();
    expect((await readExecutionPlan(f.journal, "episode"))?.validated.plan.revision).toBe(1);
    expect(f.root.snapshot()).toMatchObject({ expandedNodes: 2, planRevisions: 1 });
  });
  it("preserves completed outputs and rejects changes/removal of completed operation definitions", async () => {
    const f = await fixture();
    const first = await commitExecutionPlan(f.journal, f.root, "episode", frame());
    await f.journal.node(first.nodeKeys.a, { id: "tool", version: "1", kind: "tool" }, { value: 1 }, async () => 7);
    await expect(commitExecutionPlan(f.journal, f.root, "episode", frame(2, 2))).rejects.toThrow();
    await expect(commitExecutionPlan(f.journal, f.root, "episode", frame(2, 1, ["b"]))).rejects.toThrow();
    const second = await commitExecutionPlan(f.journal, f.root, "episode", frame(2, 1, ["a", "b", "c"]));
    expect(second.nodeKeys.a).toBe(first.nodeKeys.a);
    expect((await f.journal.snapshot()).nodes[first.nodeKeys.a].output).toBe(7);
  });
  it.each(["prepared", "uncertain", "cancelled"] as const)(
    "protects %s node definitions from replacement",
    async (status) => {
      const f = await fixture();
      const first = await commitExecutionPlan(f.journal, f.root, "episode", frame());
      await f.journal.mutate((state) => {
        state.nodes[first.nodeKeys.a].status = status;
      });
      await expect(commitExecutionPlan(f.journal, f.root, "episode", frame(2, 9))).rejects.toThrow();
      expect(f.root.snapshot().planRevisions).toBe(1);
    },
  );
  it("rejects changing merge semantics after an operation has completed", async () => {
    const f = await fixture();
    const first = await commitExecutionPlan(f.journal, f.root, "episode", frame());
    await f.journal.node(first.nodeKeys.a, { id: "tool", version: "1", kind: "tool" }, { value: 1 }, async () => 7);
    const changed = frame(2);
    changed.validated = validateExecutionPlan(
      { ...changed.validated.plan, merge: "declaration_order" },
      catalog,
      validationLimits,
    );
    await expect(commitExecutionPlan(f.journal, f.root, "episode", changed)).rejects.toThrow();
  });
  it("retains committed materialization across owner restart and fences an old writer", async () => {
    const f = await fixture();
    const first = await commitExecutionPlan(f.journal, f.root, "episode", frame());
    const recovered = await f.restart();
    expect(await readExecutionPlan(recovered, "episode")).toEqual(first);
    await expect(commitExecutionPlan(f.journal, f.root, "episode", frame(2))).rejects.toThrow(/fenc|lease|expir/i);
  });
  it("preserves cumulative allowances when a plan fails expansion after revision reservation", async () => {
    const f = await fixture({ maxExpandedNodes: 1, maxPlanRevisions: 2 });
    await expect(commitExecutionPlan(f.journal, f.root, "episode", frame())).rejects.toThrow(/expansion/i);
    expect(await readExecutionPlan(f.journal, "episode")).toBeUndefined();
    expect(f.root.snapshot()).toMatchObject({ expandedNodes: 0, planRevisions: 1 });
  });
  it("enforces revision allowance before committing additional work", async () => {
    const f = await fixture({ maxPlanRevisions: 1 });
    await commitExecutionPlan(f.journal, f.root, "episode", frame());
    await expect(commitExecutionPlan(f.journal, f.root, "episode", frame(2))).rejects.toThrow(/revision/i);
    expect((await readExecutionPlan(f.journal, "episode"))?.validated.plan.revision).toBe(1);
  });
  it("does not commit after durable cancellation or original deadline exhaustion", async () => {
    for (const mode of ["cancel", "deadline"] as const) {
      const f = await fixture();
      if (mode === "cancel")
        await f.journal.mutate((state) => {
          state.cancellation = { requested: true };
        });
      else f.advance(51);
      await expect(commitExecutionPlan(f.journal, f.root, "episode", frame())).rejects.toThrow(/cancel|deadline/i);
      expect(f.root.snapshot().planRevisions).toBe(0);
    }
  });
  it("rejects mismatched catalog identity and tampered validated digests before admission", async () => {
    const f = await fixture();
    const wrongCatalog = frame();
    wrongCatalog.validated.catalogDigest = durableDigest("wrong");
    const wrongPlan = frame();
    wrongPlan.validated.plan.nodes[0].args.value = 99;
    await expect(commitExecutionPlan(f.journal, f.root, "episode", wrongCatalog)).rejects.toThrow();
    await expect(commitExecutionPlan(f.journal, f.root, "episode", wrongPlan)).rejects.toThrow();
    expect(f.root.snapshot().planRevisions).toBe(0);
  });
  it("detects a corrupted materialization pointer rather than recovering from unverified metadata", async () => {
    const f = await fixture();
    await commitExecutionPlan(f.journal, f.root, "episode", frame());
    await f.journal.mutate((state) => {
      state.metadata["plan:episode"] = { invalid: true };
    });
    await expect(readExecutionPlan(f.journal, "episode")).rejects.toThrow();
  });
  it("rechecks claims after root reservation and retains the winning attempt when a pending edit races dispatch", async () => {
    const f = await fixture();
    const first = await commitExecutionPlan(f.journal, f.root, "episode", frame());
    let finish: ((value: number) => void) | undefined;
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let settlement: Promise<unknown> | undefined;
    const racingRoot = new RootExecutionController(
      {},
      {
        onEvent(event) {
          if (event.type === "revision")
            settlement = f.journal.node(
              first.nodeKeys.a,
              { id: "tool", version: "1", kind: "tool" },
              { value: 1 },
              () => {
                entered?.();
                return new Promise<number>((resolve) => {
                  finish = resolve;
                });
              },
            );
        },
      },
    );
    await expect(commitExecutionPlan(f.journal, racingRoot, "episode", frame(2, 9))).rejects.toThrow(
      /claimed|operation/i,
    );
    await started;
    expect((await readExecutionPlan(f.journal, "episode"))?.validated.plan.revision).toBe(1);
    expect((await f.journal.snapshot()).nodes[first.nodeKeys.a].status).toBe("running");
    expect(racingRoot.snapshot().planRevisions).toBe(1);
    if (!finish || !settlement) throw new Error("Race fixture did not enter its node");
    finish(7);
    expect(await settlement).toBe(7);
  });
  it("arbitrates incompatible simultaneous commits without exposing mixed reservations", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      commitExecutionPlan(f.journal, f.root, "episode", frame(1, 1)),
      commitExecutionPlan(f.journal, f.root, "episode", frame(1, 2)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const state = await f.journal.snapshot();
    expect(Object.keys(state.plans)).toEqual(["episode/revision/1"]);
    expect(Object.values(state.nodes)).toHaveLength(2);
    expect(f.root.snapshot().planRevisions).toBe(2);
  });
});
