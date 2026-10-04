import { describe, expect, it, vi } from "vitest";
import { DurableActionLedger } from "../actions.js";
import { durableDigest, durableTaskDigest, InMemoryDurableTaskStore } from "../store.js";
import { DurableTaskSupervisor } from "../supervisor.js";
import { DurableRecoveryRequiredError, type DurableTaskInput } from "../types.js";

const key = { tenantId: "tenant", taskId: "task" };
function input(): DurableTaskInput {
  return {
    id: "task",
    identity: { tenantId: "tenant", actorId: "actor", sessionId: "session", runId: "run", rootRunId: "root" },
    manifestHash: "sha256:manifest",
    inputRef: "input:one",
    policyRevision: 1,
    grantRefs: ["grant:send"],
    budget: { maxAttempts: 10, maxTokens: 10, maxCostMicros: 20 },
  };
}
function fixture() {
  let now = 1000;
  const store = new InMemoryDurableTaskStore({ now: () => now });
  const supervisor = new DurableTaskSupervisor(store, { leaseMs: 100 });
  return {
    store,
    supervisor,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const action = { id: "send", connectorVersion: "fixture@1", destination: "inbox", args: { message: "hello" } };
describe("durable fenced task foundation", () => {
  it("normalizes omitted budgets in immutable definition digests", async () => {
    const f = fixture();
    const definition = input();
    delete definition.budget;
    const record = await f.store.create(definition);
    expect(durableTaskDigest(definition)).toBe(durableTaskDigest(record));
    expect(durableTaskDigest({ ...definition, budget: { maxTokens: 5 } })).not.toBe(durableTaskDigest(record));
  });
  it("stops an exhausted attempt budget while preserving unknown effects for reconciliation", async () => {
    for (const uncertain of [false, true]) {
      const f = fixture();
      const definition = input();
      definition.budget = { maxAttempts: 1 };
      await f.store.create(definition);
      const first = (await f.supervisor.claim(key, "one"))!;
      if (uncertain) {
        const ledger = new DurableActionLedger(f.store, key, first.lease!);
        await ledger.prepare(action);
        await f.store.update(
          key,
          (d) => {
            d.actions.send.state = "executing";
          },
          first.lease!,
        );
      }
      f.advance(101);
      const next = (await f.supervisor.claim(key, "two"))!;
      expect(next.state).toBe(uncertain ? "running" : "stopped");
      expect(next.attempts).toHaveLength(1);
      if (uncertain) expect(next.actions.send.state).toBe("unknown");
    }
  });

  it("allows one claim, increments fences after expiry, rejects stale completion and release", async () => {
    const f = fixture();
    await f.supervisor.create(input());
    const [one, two] = await Promise.all([f.supervisor.claim(key, "one"), f.supervisor.claim(key, "two")]);
    expect([one, two].filter(Boolean)).toHaveLength(1);
    const first = (one ?? two)!;
    f.advance(101);
    const next = await f.supervisor.claim(key, "replacement");
    expect(next!.fence).toBe(2);
    await expect(f.supervisor.release(key, first.lease!)).rejects.toThrow(/fenced|expired/);
    await expect(
      f.store.update(
        key,
        (draft) => {
          draft.state = "completed";
        },
        first.lease!,
      ),
    ).rejects.toThrow(/fenced|expired/);
    expect(await f.store.get({ tenantId: "other", taskId: "task" })).toBeNull();
  });
  it("atomically preserves extension changes and rejects immutable fields and async mutations", async () => {
    const f = fixture();
    await f.store.create(input());
    await Promise.all(
      Array.from({ length: 20 }, () =>
        f.store.update(key, (d) => {
          d.extensions.count = Number(d.extensions.count ?? 0) + 1;
        }),
      ),
    );
    expect((await f.store.get(key))?.extensions.count).toBe(20);
    await expect(
      f.store.update(key, (d) => {
        d.policyRevision++;
      }),
    ).rejects.toThrow(/Immutable/);
    await expect(
      f.store.update(key, async (d) => {
        d.extensions.bad = true;
      }),
    ).rejects.toThrow(/synchronous/);
    expect((await f.store.get(key))?.extensions.bad).toBeUndefined();
  });
  it("bounds reservations and keeps terminal tasks terminal", async () => {
    const f = fixture();
    await f.store.create(input());
    await f.supervisor.run(key, "worker", async (ctx) => {
      await ctx.reserve(10, 20);
      await expect(ctx.reserve(1, 0)).rejects.toThrow(/budget/);
      return { resultRef: "result:done" };
    });
    expect((await f.store.get(key))?.state).toBe("completed");
    expect(await f.supervisor.claim(key, "late")).toBeNull();
    expect((await f.supervisor.cancel(key)).state).toBe("completed");
    await expect(
      f.store.update(key, (d) => {
        d.state = "running";
      }),
    ).rejects.toThrow(/transition/);
  });
  it("persists approval suspension, verifies actor/hash, consumes once and reuses confirmed results", async () => {
    const f = fixture();
    await f.store.create(input());
    const dispatch = vi.fn(async () => ({ resultRef: "result:sent" }));
    const approvedAction = { ...action, approval: { actorId: "reviewer", expiresAt: 5000 } };
    const handler = async ({ actions }: { actions: DurableActionLedger }) =>
      actions.execute(approvedAction, { version: "fixture@1", dispatch });
    expect((await f.supervisor.run(key, "one", handler)).state).toBe("awaiting_approval");
    expect(dispatch).not.toHaveBeenCalled();
    const suspended = (await f.store.get(key))!;
    const approval = Object.values(suspended.approvals)[0];
    await expect(
      DurableActionLedger.decide(f.store, key, {
        approvalId: approval.id,
        actorId: "forged",
        preparedHash: approval.preparedHash,
        approved: true,
      }),
    ).rejects.toThrow(/binding/);
    await DurableActionLedger.decide(f.store, key, {
      approvalId: approval.id,
      actorId: "reviewer",
      preparedHash: approval.preparedHash,
      approved: true,
    });
    const completed = await f.supervisor.run(key, "two", async (ctx) => {
      await handler(ctx);
      await handler(ctx);
    });
    expect(completed.state).toBe("completed");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(completed.approvals[approval.id].consumed).toBe(true);
  });
  it("does not dispatch changed, denied or expired approvals", async () => {
    for (const mode of ["changed", "denied", "expired"]) {
      const f = fixture();
      await f.store.create(input());
      const dispatch = vi.fn(async () => ({ resultRef: "result:sent" }));
      const prepared = { ...action, approval: { actorId: "reviewer", expiresAt: 1050 } };
      await f.supervisor.run(key, "one", async (ctx) => {
        await ctx.actions.execute(prepared, { version: "fixture@1", dispatch });
      });
      const approval = Object.values((await f.store.get(key))!.approvals)[0];
      if (mode === "expired") f.advance(51);
      else
        await DurableActionLedger.decide(f.store, key, {
          approvalId: approval.id,
          actorId: "reviewer",
          preparedHash: approval.preparedHash,
          approved: mode !== "denied",
        });
      await expect(
        f.supervisor.run(key, "two", async (ctx) => {
          await ctx.actions.execute(mode === "changed" ? { ...prepared, destination: "other" } : prepared, {
            version: "fixture@1",
            dispatch,
          });
        }),
      ).rejects.toThrow();
      expect(dispatch).not.toHaveBeenCalled();
    }
  });
  it("marks interrupted dispatch unknown and requires authoritative reconciliation before restart", async () => {
    const f = fixture();
    await f.store.create(input());
    const first = (await f.supervisor.claim(key, "one"))!;
    const ledger = new DurableActionLedger(f.store, key, first.lease!);
    await ledger.prepare(action);
    await f.store.update(
      key,
      (d) => {
        d.actions.send.state = "executing";
      },
      first.lease!,
    );
    f.advance(101);
    const driver = vi.fn();
    await expect(f.supervisor.run(key, "two", driver)).rejects.toBeInstanceOf(DurableRecoveryRequiredError);
    expect(driver).not.toHaveBeenCalled();
    const recovery = (await f.supervisor.claim(key, "reconciler"))!;
    const currentLedger = new DurableActionLedger(f.store, key, recovery.lease!);
    await currentLedger.reconcile("send", {
      version: "fixture@1",
      dispatch: vi.fn(),
      reconcile: async () => ({ outcome: "confirmed", resultRef: "result:sent", evidenceRef: "receipt:one" }),
    });
    await f.supervisor.release(key, recovery.lease!);
    const dispatch = vi.fn();
    await f.supervisor.run(key, "three", async (ctx) => {
      await ctx.actions.execute(action, { version: "fixture@1", dispatch });
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("never acknowledges cancellation while an effect outcome is unknown", async () => {
    const f = fixture();
    await f.store.create(input());
    const record = (await f.supervisor.claim(key, "worker"))!;
    const ledger = new DurableActionLedger(f.store, key, record.lease!);
    await expect(
      ledger.execute(action, {
        version: "fixture@1",
        dispatch: async () => {
          throw new Error("connection lost after send");
        },
      }),
    ).rejects.toThrow(/connection/);
    await f.supervisor.cancel(key);
    await expect(f.supervisor.acknowledgeCancellation(key, record.lease!)).rejects.toBeInstanceOf(
      DurableRecoveryRequiredError,
    );
    expect((await f.store.get(key))?.state).toBe("cancel_requested");
    await ledger.reconcile("send", {
      version: "fixture@1",
      dispatch: vi.fn(),
      reconcile: async () => ({ outcome: "confirmed", resultRef: "sent", evidenceRef: "receipt" }),
    });
    expect((await f.supervisor.acknowledgeCancellation(key, record.lease!)).state).toBe("canceled");
  });
  it("polls persisted cancellation, waits for owned effects and rejects late task success", async () => {
    const store = new InMemoryDurableTaskStore();
    const supervisor = new DurableTaskSupervisor(store, { leaseMs: 300, pollMs: 5 });
    await store.create(input());
    let started!: () => void;
    const effectStarted = new Promise<void>((r) => {
      started = r;
    });
    const result = supervisor.run(key, "worker", async (ctx) => {
      await ctx.actions.execute(action, {
        version: "fixture@1",
        dispatch: async (_action, signal) => {
          started();
          await new Promise<void>((r) => signal!.addEventListener("abort", () => r(), { once: true }));
          return { resultRef: "committed-before-cancel-ack" };
        },
      });
      return { resultRef: "late success" };
    });
    await effectStarted;
    await supervisor.cancel(key);
    expect((await result).state).toBe("canceled");
    expect((await store.get(key))?.actions.send.state).toBe("confirmed");
  });
  it("makes prepared digests independent of object key order and rejects host-only data", () => {
    expect(durableDigest({ a: 1, b: 2 })).toBe(durableDigest({ b: 2, a: 1 }));
    expect(() => durableDigest({ sdk: () => {} })).toThrow(/JSON/);
  });
});
