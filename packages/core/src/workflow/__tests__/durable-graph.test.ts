import { describe, expect, it, vi } from "vitest";
import { DurableActionLedger } from "../../durable/actions.js";
import { InMemoryDurableTaskStore } from "../../durable/store.js";
import { DurableTaskSupervisor } from "../../durable/supervisor.js";
import { DurableLeaseError, DurableRecoveryRequiredError, type DurableTaskInput } from "../../durable/types.js";
import { type DurableGraphDefinition, DurableGraphJournal } from "../durable-graph.js";

const key = { tenantId: "tenant", taskId: "graph" };
const binding = { id: "approved", version: "1", kind: "pure" };
const definition: DurableGraphDefinition = {
  id: "graph-definition",
  version: "1",
  catalogDigest: "catalog:one",
  input: { question: "hello" },
  limits: { maxExpandedNodes: 10, maxModelCalls: 4 },
  deadline: 5000,
};
const taskInput: DurableTaskInput = {
  id: "graph",
  identity: { tenantId: "tenant", actorId: "actor", sessionId: "session", runId: "run", rootRunId: "root" },
  manifestHash: "manifest:one",
  inputRef: "input:one",
  policyRevision: 1,
  grantRefs: ["grant:write"],
  budget: { maxAttempts: 20 },
};
async function fixture() {
  let now = 1000;
  const store = new InMemoryDurableTaskStore({ now: () => now });
  const supervisor = new DurableTaskSupervisor(store, { leaseMs: 100 });
  await store.create(taskInput);
  const first = await supervisor.claim(key, "worker-one");
  if (!first?.lease) throw new Error("Fixture did not obtain a lease");
  const journal = new DurableGraphJournal(store, key, first.lease, definition);
  const restart = async () => {
    now += 101;
    const next = await supervisor.claim(key, "worker-two");
    if (!next?.lease) throw new Error("Fixture did not obtain replacement lease");
    return new DurableGraphJournal(store, key, next.lease, definition);
  };
  return { store, supervisor, journal, fence: first.lease, restart, advance: (ms: number) => (now += ms) };
}

describe("fenced durable graph journal", () => {
  it("inspects active, killed-owner and terminal records without a lease or a write", async () => {
    const f = await fixture();
    await f.journal.initialize();
    await f.journal.node("complete", binding, {}, async () => "saved");
    const inspection = new DurableGraphJournal(f.store, key, { workerId: "inspection", fence: 0 }, definition);
    const before = await f.store.get(key);
    expect((await inspection.snapshot()).nodes.complete.output).toBe("saved");
    expect((await f.store.get(key))?.revision).toBe(before?.revision);
    f.advance(101);
    expect((await inspection.snapshot()).nodes.complete.output).toBe("saved");
    await f.store.update(key, (task) => {
      task.state = "completed";
      delete task.lease;
    });
    const terminal = await f.store.get(key);
    expect((await inspection.snapshot()).nodes.complete.output).toBe("saved");
    expect((await f.store.get(key))?.revision).toBe(terminal?.revision);
    await expect(
      inspection.mutate((state) => {
        state.metadata.invalid = true;
      }),
    ).rejects.toBeInstanceOf(DurableLeaseError);
  });
  it("initializes once and retains full limits, budget, admission, cancellation and materialized decisions", async () => {
    const f = await fixture();
    await f.journal.initialize();
    await f.journal.mutate((state) => {
      state.plans.episode = { revision: 1, nodes: ["a", "b"] };
      state.budget = { usedCalls: 2, reservedTokens: 40, finishingCalls: 1 };
      state.admission = { expandedNodes: 2, workAttempts: 3 };
      state.cancellation = { requested: true, reason: "operator" };
      state.metadata.currentIteration = 3;
    });
    const resumed = await f.restart();
    const state = await resumed.initialize();
    expect(state.definition).toEqual(definition);
    expect(state.plans.episode).toEqual({ revision: 1, nodes: ["a", "b"] });
    expect(state.budget).toEqual({ usedCalls: 2, reservedTokens: 40, finishingCalls: 1 });
    expect(state.admission).toEqual({ expandedNodes: 2, workAttempts: 3 });
    expect(state.cancellation).toEqual({ requested: true, reason: "operator" });
    expect(state.metadata.currentIteration).toBe(3);
  });

  it.each([
    { version: "2" },
    { catalogDigest: "catalog:two" },
    { input: { question: "different" } },
    { limits: { maxModelCalls: 100 } },
    { deadline: 6000 },
  ])("rejects changed definition %# before executing resumed work", async (change) => {
    const f = await fixture();
    await f.journal.initialize();
    const incompatible = new DurableGraphJournal(f.store, key, f.fence, { ...definition, ...change });
    const execute = vi.fn(async () => ({ answer: 1 }));
    await expect(incompatible.node("a", binding, {}, execute)).rejects.toThrow(/definition|binding|mismatch/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns persisted completed outputs without rerunning after ownership changes", async () => {
    const f = await fixture();
    expect(await f.journal.node("a", binding, { value: 2 }, async () => ({ answer: 4 }))).toEqual({ answer: 4 });
    const resumed = await f.restart();
    const execute = vi.fn(async () => ({ answer: 99 }));
    expect(await resumed.node("a", binding, { value: 2 }, execute)).toEqual({ answer: 4 });
    expect(execute).not.toHaveBeenCalled();
    expect((await resumed.snapshot()).nodes.a.status).toBe("completed");
  });

  it("binds node identity to input and executable version even for completed output reuse", async () => {
    const f = await fixture();
    await f.journal.node("a", binding, { value: 2 }, async () => 4);
    await expect(f.journal.node("a", binding, { value: 3 }, async () => 6)).rejects.toThrow(/input|mismatch/i);
    await expect(f.journal.node("a", { ...binding, version: "2" }, { value: 2 }, async () => 4)).rejects.toThrow(
      /binding|mismatch/i,
    );
  });

  it("claims a reserved pending node before work and rejects superseded pending incarnations", async () => {
    const f = await fixture();
    await f.journal.initialize();
    await f.journal.mutate((state) => {
      state.nodes.a = { binding, status: "pending", attempts: [], metadata: { planRevision: 1 } };
      state.nodes.old = { binding, status: "superseded", attempts: [], metadata: { planRevision: 0 } };
    });
    const result = await f.journal.node("a", binding, { value: 1 }, async () => {
      const state = await f.journal.snapshot();
      expect(state.nodes.a.status).toBe("running");
      expect(state.nodes.a.input).toEqual({ value: 1 });
      expect(state.nodes.a.metadata).toEqual({ planRevision: 1 });
      return 2;
    });
    expect(result).toBe(2);
    await expect(f.journal.node("old", binding, {}, async () => 1)).rejects.toThrow(/superseded/i);
  });

  it("fences an old node settlement while a recovered attempt completes", async () => {
    const f = await fixture();
    let finish!: (value: number) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => (started = resolve));
    const old = f.journal.node("a", binding, {}, () => {
      started();
      return new Promise<number>((resolve) => (finish = resolve));
    });
    const settled = old.then(
      (output) => ({ output }),
      (error: unknown) => ({ error }),
    );
    await Promise.race([
      entered,
      settled.then((result) => {
        if ("error" in result) throw result.error;
        throw new Error("Node returned before entering execution");
      }),
    ]);
    const resumed = await f.restart();
    expect(await resumed.node("a", binding, {}, async () => 2)).toBe(2);
    finish(1);
    const outcome = await settled;
    expect("error" in outcome ? outcome.error : undefined).toBeInstanceOf(DurableLeaseError);
    expect((await resumed.snapshot()).nodes.a.output).toBe(2);
    expect((await resumed.snapshot()).nodes.a.attempts).toHaveLength(2);
  });

  it("does not execute simultaneous duplicate claims in the same owner fence", async () => {
    const f = await fixture();
    let finish!: (value: number) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => (started = resolve));
    const first = f.journal.node("a", binding, {}, () => {
      started();
      return new Promise<number>((resolve) => (finish = resolve));
    });
    const settled = first.then(
      (output) => ({ output }),
      (error: unknown) => ({ error }),
    );
    await Promise.race([
      entered,
      settled.then((result) => {
        if ("error" in result) throw result.error;
        throw new Error("Node returned before entering execution");
      }),
    ]);
    const duplicate = vi.fn(async () => 2);
    await expect(f.journal.node("a", binding, {}, duplicate)).rejects.toThrow(/running|owned|active/i);
    expect(duplicate).not.toHaveBeenCalled();
    finish(1);
    expect(await settled).toEqual({ output: 1 });
  });

  it("preserves ordinary node failures and never silently retries them", async () => {
    const f = await fixture();
    await expect(
      f.journal.node("a", binding, {}, async () => {
        throw new Error("bad output");
      }),
    ).rejects.toThrow("bad output");
    const resumed = await f.restart();
    const execute = vi.fn(async () => 2);
    await expect(resumed.node("a", binding, {}, execute)).rejects.toThrow("bad output");
    expect(execute).not.toHaveBeenCalled();
    expect((await resumed.snapshot()).nodes.a.status).toBe("failed");
  });

  it("preserves uncertain control outcomes rather than turning them into ordinary failures", async () => {
    const f = await fixture();
    await expect(
      f.journal.node("a", binding, {}, async () => {
        throw new DurableRecoveryRequiredError();
      }),
    ).rejects.toBeInstanceOf(DurableRecoveryRequiredError);
    expect((await f.journal.snapshot()).nodes.a.status).toBe("uncertain");
  });

  it("persists model decisions before returning and rejects a changed replay request", async () => {
    const f = await fixture();
    const response = { message: { role: "assistant", toolCalls: [{ id: "call-one", name: "approved", args: {} }] } };
    expect(await f.journal.model("a/model/0", { messages: ["hello"] }, async () => response)).toEqual(response);
    const resumed = await f.restart();
    const execute = vi.fn(async () => ({ message: "different" }));
    expect(await resumed.model("a/model/0", { messages: ["hello"] }, execute)).toEqual(response);
    expect(execute).not.toHaveBeenCalled();
    await expect(resumed.model("a/model/0", { messages: ["changed"] }, execute)).rejects.toThrow(/input|request/i);
  });

  it("reuses persisted repeat and materialization decisions instead of recomputing them", async () => {
    const f = await fixture();
    expect(await f.journal.decision("repeat/2/guard", () => true)).toBe(true);
    expect(await f.journal.decision("repeat/2/plan", () => ({ nodes: ["a", "b"] }))).toEqual({ nodes: ["a", "b"] });
    const resumed = await f.restart();
    const compute = vi.fn(() => false);
    expect(await resumed.decision("repeat/2/guard", compute)).toBe(true);
    expect(compute).not.toHaveBeenCalled();
  });

  it("rejects corrupt persisted lifecycle records before executing callbacks", async () => {
    const f = await fixture();
    await f.journal.initialize();
    await f.store.update(
      key,
      (task) => {
        task.extensions["agentium.graph.v1"] = { schemaVersion: 1, nodes: { a: { status: "completed" } } };
      },
      f.fence,
    );
    const execute = vi.fn(async () => 1);
    await expect(f.journal.node("a", binding, {}, execute)).rejects.toThrow(/invalid|corrupt|journal/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it("detects finite but corrupted recorded output before completed-node reuse", async () => {
    const f = await fixture();
    await f.journal.node("a", binding, {}, async () => ({ answer: 1 }));
    const state = await f.journal.snapshot();
    state.nodes.a.output = { answer: 999 };
    await f.store.update(
      key,
      (task) => {
        task.extensions["agentium.graph.v1"] = JSON.parse(JSON.stringify(state));
      },
      f.fence,
    );
    const execute = vi.fn(async () => ({ answer: 2 }));
    await expect(f.journal.node("a", binding, {}, execute)).rejects.toThrow(/corrupt|digest|invalid/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects non-JSON values before they become successful durable outputs", async () => {
    const f = await fixture();
    await expect(f.journal.node("a", binding, {}, async () => Number.NaN)).rejects.toThrow(/finite|JSON|invalid/i);
    expect((await f.journal.snapshot()).nodes.a.status).toBe("failed");
  });

  it("prevents deletion or replacement of completed node evidence through mutation", async () => {
    const f = await fixture();
    await f.journal.node("a", binding, {}, async () => ({ answer: 1 }));
    await expect(
      f.journal.mutate((state) => {
        delete state.nodes.a;
      }),
    ).rejects.toThrow(/audit|delete|immutable/i);
    await expect(
      f.journal.mutate((state) => {
        state.nodes.a.output = { answer: 2 };
      }),
    ).rejects.toThrow(/immutable|completed|audit|corrupt/i);
  });

  it("retains immutable committed plans across pending topology revisions", async () => {
    const f = await fixture();
    await f.journal.mutate((state) => {
      state.plans["episode/revision/1"] = { nodes: ["a"] };
      state.metadata.currentPlan = "episode/revision/1";
    });
    await f.journal.mutate((state) => {
      state.plans["episode/revision/2"] = { nodes: ["a", "b"] };
      state.metadata.currentPlan = "episode/revision/2";
    });
    await expect(
      f.journal.mutate((state) => {
        state.plans["episode/revision/1"] = { nodes: ["changed"] };
      }),
    ).rejects.toThrow(/plan|immutable/i);
    await expect(
      f.journal.mutate((state) => {
        delete state.plans["episode/revision/1"];
      }),
    ).rejects.toThrow(/plan|audit|immutable/i);
    expect((await f.journal.snapshot()).metadata.currentPlan).toBe("episode/revision/2");
  });

  it("retains interrupted model uncertainty and allows bounded recovery under a new owner", async () => {
    const f = await fixture();
    await expect(
      f.journal.model("a/model/0", { prompt: "hello" }, async () => {
        throw new Error("provider acknowledgement lost");
      }),
    ).rejects.toThrow("lost");
    expect((await f.journal.snapshot()).models["a/model/0"].status).toBe("uncertain");
    const resumed = await f.restart();
    expect(await resumed.model("a/model/0", { prompt: "hello" }, async () => ({ answer: 1 }))).toEqual({ answer: 1 });
  });

  it("atomically preserves shared-counter increments across distinct journal instances", async () => {
    const f = await fixture();
    await f.journal.initialize();
    const other = new DurableGraphJournal(f.store, key, f.fence, definition);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 ? f.journal : other).mutate((state) => {
          state.metadata.workAttempts = Number(state.metadata.workAttempts ?? 0) + 1;
        }),
      ),
    );
    expect((await other.snapshot()).metadata.workAttempts).toBe(20);
  });

  it("rejects admission after the original deadline or persisted cancellation", async () => {
    for (const mode of ["deadline", "cancel", "task-cancel"]) {
      const f = await fixture();
      await f.journal.initialize();
      let journal = f.journal;
      if (mode === "deadline") {
        f.advance(4000);
        journal = await f.restart();
      } else if (mode === "cancel")
        await f.journal.mutate((state) => {
          state.cancellation = { requested: true, reason: "operator" };
        });
      else await f.supervisor.cancel(key, "operator");
      const execute = vi.fn(async () => 1);
      await expect(journal.node("a", binding, {}, execute)).rejects.toThrow(/deadline|cancel|running/i);
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it("reuses confirmed effect receipts and rejects changed logical effect arguments", async () => {
    const f = await fixture();
    const effect = { id: "a/effect/0", connectorVersion: "write@1", destination: "approved", args: { value: 1 } };
    const dispatch = vi.fn(async () => ({ resultRef: "receipt:one" }));
    const resolve = vi.fn(async () => ({ value: 1 }));
    expect(await f.journal.effect(effect, { version: "write@1", dispatch }, resolve)).toEqual({ value: 1 });
    const resumed = await f.restart();
    expect(await resumed.effect(effect, { version: "write@1", dispatch }, resolve)).toEqual({ value: 1 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    await expect(
      resumed.effect({ ...effect, args: { value: 2 } }, { version: "write@1", dispatch }, resolve),
    ).rejects.toThrow(/different|changed/i);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it("records cancellation after intent but before connector entry as known not dispatched", async () => {
    const f = await fixture();
    const cancellation = new AbortController();
    const effect = { id: "a/effect/0", connectorVersion: "write@1", destination: "approved", args: {} };
    const update = f.store.update.bind(f.store);
    vi.spyOn(f.store, "update").mockImplementation(async (...args) => {
      const task = await update(...args);
      if (task.actions[effect.id]?.state === "executing")
        cancellation.abort(new DOMException("Before connector entry", "AbortError"));
      return task;
    });
    const dispatch = vi.fn(async () => ({ resultRef: "receipt:one" }));
    await expect(
      f.journal.effect(effect, { version: "write@1", dispatch }, async () => null, cancellation.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(dispatch).not.toHaveBeenCalled();
    expect((await f.store.get(key))?.actions[effect.id]).toMatchObject({
      state: "canceled",
      evidenceRef: "local:cancelled-before-dispatch",
    });
    expect((await f.journal.snapshot()).evidence).not.toContainEqual(
      expect.objectContaining({ type: "effect.unresolved" }),
    );
  });

  it("reuses retained canonical effect output even when a resolver later becomes unavailable", async () => {
    const f = await fixture();
    const effect = { id: "a/effect/0", connectorVersion: "write@1", destination: "approved", args: { value: 1 } };
    const connector = { version: "write@1", dispatch: async () => ({ resultRef: "receipt:one" }) };
    await f.journal.effect(effect, connector, async () => ({ answer: 1 }));
    const resumed = await f.restart();
    const resolver = vi.fn(async () => {
      throw new Error("receipt archive offline");
    });
    expect(await resumed.effect(effect, connector, resolver)).toEqual({ answer: 1 });
    expect(resolver).not.toHaveBeenCalled();
  });

  it("marks node uncertainty when a remote effect acknowledgement is lost", async () => {
    const f = await fixture();
    const effect = { id: "a/effect/0", connectorVersion: "write@1", destination: "approved", args: {} };
    await expect(
      f.journal.node("a", { ...binding, kind: "effect" }, {}, () =>
        f.journal.effect(
          effect,
          {
            version: "write@1",
            dispatch: async () => {
              throw new Error("remote acknowledgement lost");
            },
          },
          async () => null,
        ),
      ),
    ).rejects.toBeInstanceOf(DurableRecoveryRequiredError);
    expect((await f.journal.snapshot()).nodes.a.status).toBe("uncertain");
    expect((await f.journal.snapshot()).evidence).toContainEqual(
      expect.objectContaining({ type: "effect.unresolved", effectId: "a/effect/0" }),
    );
  });

  it("reconciles remote acceptance before repeating an interrupted effect", async () => {
    const f = await fixture();
    const effect = { id: "a/effect/0", connectorVersion: "write@1", destination: "approved", args: { value: 1 } };
    const ledger = new DurableActionLedger(f.store, key, f.fence);
    await ledger.prepare(effect);
    await f.store.update(
      key,
      (task) => {
        task.actions[effect.id].state = "executing";
      },
      f.fence,
    );
    const resumed = await f.restart();
    const dispatch = vi.fn(async () => ({ resultRef: "receipt:duplicate" }));
    const reconcile = vi.fn(async () => ({
      outcome: "confirmed" as const,
      resultRef: "receipt:one",
      evidenceRef: "evidence:one",
    }));
    expect(
      await resumed.effect(effect, { version: "write@1", dispatch, reconcile }, async () => ({ value: 1 })),
    ).toEqual({ value: 1 });
    expect(dispatch).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect((await f.store.get(key))?.actions[effect.id].state).toBe("confirmed");
  });

  it("keeps unresolved effect evidence and requires recovery instead of unsafe redispatch", async () => {
    const f = await fixture();
    const effect = { id: "a/effect/0", connectorVersion: "write@1", destination: "approved", args: {} };
    const dispatch = vi.fn(async () => {
      throw new Error("remote acknowledgement lost");
    });
    await expect(f.journal.effect(effect, { version: "write@1", dispatch }, async () => null)).rejects.toThrow(
      /lost|unknown/i,
    );
    const resumed = await f.restart();
    await expect(
      resumed.effect(
        effect,
        { version: "write@1", dispatch, reconcile: async () => ({ outcome: "unknown", evidenceRef: "lookup:one" }) },
        async () => null,
      ),
    ).rejects.toBeInstanceOf(DurableRecoveryRequiredError);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await f.store.get(key))?.actions[effect.id].evidenceRef).toBe("lookup:one");
  });
});

describe("supervisor reconciliation entry", () => {
  async function interrupted() {
    const f = await fixture();
    const effect = { id: "send", connectorVersion: "write@1", destination: "approved", args: {} };
    await new DurableActionLedger(f.store, key, f.fence).prepare(effect);
    await f.store.update(
      key,
      (task) => {
        task.actions.send.state = "executing";
      },
      f.fence,
    );
    f.advance(101);
    return { ...f, effect };
  }
  it("reconciles under the new fence before entering a handler blocked by unknown outcomes", async () => {
    const f = await interrupted();
    const handler = vi.fn(async (ctx) => {
      expect(ctx.task.actions.send.state).toBe("confirmed");
    });
    const result = await f.supervisor.run(key, "recovery", handler, {
      reconcile: async (ctx) => {
        expect(ctx.task.actions.send.state).toBe("unknown");
        expect(ctx.lease.fence).toBe(2);
        await ctx.actions.reconcile("send", {
          version: "write@1",
          dispatch: async () => ({ resultRef: "must-not-dispatch" }),
          reconcile: async () => ({ outcome: "confirmed", resultRef: "receipt:one", evidenceRef: "evidence:one" }),
        });
      },
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.state).toBe("completed");
  });
  it("reconciles interrupted effects before acknowledging persisted cancellation", async () => {
    const f = await interrupted();
    await f.supervisor.cancel(key, "operator");
    const handler = vi.fn();
    const result = await f.supervisor.run(key, "recovery", handler, {
      reconcile: async (ctx) => {
        await ctx.actions.reconcile("send", {
          version: "write@1",
          dispatch: async () => ({ resultRef: "must-not-dispatch" }),
          reconcile: async () => ({ outcome: "confirmed", resultRef: "receipt:one", evidenceRef: "evidence:one" }),
        });
      },
    });
    expect(result.state).toBe("canceled");
    expect(handler).not.toHaveBeenCalled();
    expect(result.actions.send.state).toBe("confirmed");
  });
  it("still prevents handler admission when a reconciliation remains unknown", async () => {
    const f = await interrupted();
    const handler = vi.fn();
    await expect(
      f.supervisor.run(key, "recovery", handler, {
        reconcile: async (ctx) => {
          await ctx.actions.reconcile("send", {
            version: "write@1",
            dispatch: async () => ({ resultRef: "must-not-dispatch" }),
            reconcile: async () => ({ outcome: "unknown", evidenceRef: "lookup:one" }),
          });
        },
      }),
    ).rejects.toBeInstanceOf(DurableRecoveryRequiredError);
    expect(handler).not.toHaveBeenCalled();
    expect((await f.store.get(key))?.actions.send.evidenceRef).toBe("lookup:one");
  });

  it("does not grant an extra worker attempt after an exhausted recovery claim reconciles its effects", async () => {
    let now = 1000;
    const store = new InMemoryDurableTaskStore({ now: () => now });
    const supervisor = new DurableTaskSupervisor(store, { leaseMs: 100 });
    await store.create({ ...taskInput, budget: { maxAttempts: 1 } });
    const first = await supervisor.claim(key, "first");
    if (!first?.lease) throw new Error("Fixture did not obtain first lease");
    await new DurableActionLedger(store, key, first.lease).prepare({
      id: "send",
      connectorVersion: "write@1",
      destination: "approved",
      args: {},
    });
    await store.update(
      key,
      (task) => {
        task.actions.send.state = "executing";
      },
      first.lease,
    );
    now += 101;
    const handler = vi.fn();
    const result = await supervisor.run(key, "recovery", handler, {
      reconcile: async (ctx) => {
        await ctx.actions.reconcile("send", {
          version: "write@1",
          dispatch: async () => ({ resultRef: "must-not-dispatch" }),
          reconcile: async () => ({ outcome: "confirmed", resultRef: "receipt:one", evidenceRef: "evidence:one" }),
        });
      },
    });
    expect(result.state).toBe("stopped");
    expect(result.attempts).toHaveLength(1);
    expect(result.actions.send.state).toBe("confirmed");
    expect(handler).not.toHaveBeenCalled();
  });
});
