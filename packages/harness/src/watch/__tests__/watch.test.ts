import { type DurableAction, InMemoryDurableTaskStore } from "@agentium/core";
import { describe, expect, it, vi } from "vitest";
import { defineWatch, describeWatch } from "../definition.js";
import { isWatchQuiet, nextWatchDelivery } from "../quiet-hours.js";
import { DurableWatch } from "../runtime.js";
import type { WatchDefinitionInput, WatchServices, WatchSourceBatch } from "../types.js";

export function definition(overrides: Partial<WatchDefinitionInput> = {}): WatchDefinitionInput {
  return {
    id: "mail",
    version: 1,
    identity: { tenantId: "tenant", actorId: "actor" },
    sourceId: "gmail",
    sourceScope: "me@example.com",
    channel: "email",
    destination: "owner@example.com",
    policyRevision: 1,
    grantRefs: ["read-inbox", "notify-owner"],
    timeZone: "UTC",
    cooldownMs: 0,
    ...overrides,
  };
}
function fixture(overrides: Partial<WatchDefinitionInput> = {}) {
  let now = Date.parse("2026-01-01T12:00:00Z");
  const store = new InMemoryDurableTaskStore({ now: () => now });
  const jobs = new Map<string, number>();
  const batches: WatchSourceBatch[] = [];
  const effects: DurableAction[] = [];
  const services: WatchServices = {
    store,
    requireDurability: false,
    source: {
      id: "gmail",
      scope: "me@example.com",
      capabilities: { idempotentActivation: true, polling: true, push: true },
      baseline: vi.fn(async () => "10"),
      activate: vi.fn(async (key) => ({ reference: key, expiresAt: now + 86400000 })),
      stop: vi.fn(async () => {}),
      compareCursors: (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0),
      read: vi.fn(async () => batches.shift() ?? { cursor: "10", events: [], resynced: false }),
      verifyTrigger: vi.fn(async (raw) => raw as never),
    },
    scheduler: {
      capabilities: { durable: false, idempotentUpsert: true },
      schedule: vi.fn(async (job) => {
        jobs.set(job.key, job.at);
      }),
      cancel: vi.fn(async (key) => {
        jobs.delete(key);
      }),
    },
    notifications: {
      version: "email-v1",
      channel: "email",
      destination: "owner@example.com",
      dispatch: vi.fn(async (action) => {
        effects.push(structuredClone(action));
        return { resultRef: "sent:1" };
      }),
      reconcile: vi.fn(async () => ({ outcome: "confirmed" as const, resultRef: "sent:1", evidenceRef: "provider:1" })),
    },
    authorize: vi.fn(async () => true),
  };
  const watch = new DurableWatch(definition(overrides), services);
  const batch = (cursor: string, id = cursor, resynced = false) =>
    batches.push({ cursor, events: [{ id, occurredAt: now, data: { subject: id } }], resynced });
  return {
    watch,
    services,
    store,
    jobs,
    batch,
    effects,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("durable watches", () => {
  it("defines and describes immutable JSON without binding or starting I/O", () => {
    const input = definition();
    const d = defineWatch(input);
    input.grantRefs.push("new");
    expect(d.grantRefs).toEqual(["read-inbox", "notify-owner"]);
    expect(Object.isFrozen(d.limits)).toBe(true);
    expect(describeWatch(d)).toMatchObject({ activation: "explicit", modelCalls: false });
    expect(() => defineWatch({ ...definition(), secret: "x" } as never)).toThrow("Unknown");
    expect(() => defineWatch(definition({ timeZone: undefined }))).toThrow();
    expect(() => defineWatch({ ...definition(), grantRefs: "grant" } as never)).toThrow("shape");
    expect(() => defineWatch({ ...definition(), limits: [] } as never)).toThrow("shape");
    expect(() => defineWatch({ ...definition(), quietHours: null } as never)).toThrow("shape");
    expect(() => defineWatch(definition({ quietHours: { start: "25:00", end: "07:00" } }))).toThrow();
  });
  it("rejects non-durable services unless explicitly selected for testing, and requires host authorization", async () => {
    const f = fixture();
    expect(() => new DurableWatch(definition(), { ...f.services, requireDurability: true })).toThrow("durable");
    vi.mocked(f.services.authorize).mockResolvedValue(false);
    await expect(f.watch.activate()).rejects.toThrow("denied");
    expect(f.services.source.baseline).not.toHaveBeenCalled();
    expect(await f.store.get(f.watch.key)).toBeNull();
  });
  it("activates explicitly and idempotently, preserving a persisted baseline across activation failure", async () => {
    const f = fixture();
    vi.mocked(f.services.source.activate).mockRejectedValueOnce(new Error("unavailable"));
    await expect(f.watch.activate()).rejects.toThrow("unavailable");
    expect((await f.watch.inspect()).cursor).toBe("10");
    await f.watch.activate();
    await f.watch.activate();
    expect(f.services.source.baseline).toHaveBeenCalledTimes(1);
    expect(f.services.source.activate).toHaveBeenCalledTimes(2);
    expect(f.jobs.size).toBe(2);
  });
  it("keeps authorized shutdown fenced and available after the work budget stops the task", async () => {
    const f = fixture({ limits: { maxOperations: 1 } });
    await f.watch.activate();
    await expect(f.watch.poll()).rejects.toThrow("budget");
    expect((await f.store.get(f.watch.key))?.state).toBe("stopped");
    const fence = (await f.store.get(f.watch.key))!.fence;
    await f.watch.pause();
    expect(f.jobs.size).toBe(0);
    await f.watch.delete();
    expect(f.services.source.stop).toHaveBeenCalledTimes(1);
    expect((await f.watch.inspect()).status).toBe("deleted");
    const task = (await f.store.get(f.watch.key))!;
    expect(task.state).toBe("stopped");
    expect(task.attempts).toHaveLength(1);
    expect(task.fence).toBe(fence + 2);
    expect(task.lease).toBeUndefined();
    await expect(f.watch.resume()).rejects.toThrow("budget");
    expect(f.services.source.activate).toHaveBeenCalledTimes(1);
  });
  it("does not bypass authorization or immutable actor/version scope for maintenance", async () => {
    const f = fixture({ limits: { maxOperations: 1 } });
    await f.watch.activate();
    vi.mocked(f.services.authorize).mockImplementation(async ({ operation }) => operation !== "delete");
    await expect(f.watch.delete()).rejects.toThrow("authorization denied");
    expect(f.jobs.size).toBe(2);
    expect(f.services.source.stop).not.toHaveBeenCalled();
    vi.mocked(f.services.authorize).mockResolvedValue(true);
    const otherActor = new DurableWatch(
      definition({ identity: { tenantId: "tenant", actorId: "other" }, limits: { maxOperations: 1 } }),
      f.services,
    );
    await expect(otherActor.delete()).rejects.toThrow("different definition");
    expect(f.services.source.stop).not.toHaveBeenCalled();
    const otherVersion = new DurableWatch(definition({ version: 2 }), f.services);
    await expect(otherVersion.delete()).rejects.toThrow("not been activated");
    expect(f.services.source.stop).not.toHaveBeenCalled();
  });
  it.each(["cancel_requested", "canceled"] as const)(
    "allows shutdown of a %s task without reopening it",
    async (state) => {
      const f = fixture({ limits: { maxOperations: 1 } });
      await f.watch.activate();
      await f.store.update(f.watch.key, (draft) => {
        draft.state = "cancel_requested";
      });
      if (state === "canceled")
        await f.store.update(f.watch.key, (draft) => {
          draft.state = "canceled";
        });
      await f.watch.delete();
      expect(f.jobs.size).toBe(0);
      expect(f.services.source.stop).toHaveBeenCalledTimes(1);
      expect((await f.store.get(f.watch.key))?.state).toBe(state);
      expect((await f.store.get(f.watch.key))?.attempts).toHaveLength(1);
    },
  );
  it("commits cursor and decisions/pending digest together, deduplicates, and binds dispatch to immutable scope", async () => {
    const f = fixture();
    await f.watch.activate();
    f.batch("11", "semantic-event");
    await f.watch.poll();
    f.batch("12", "semantic-event");
    await f.watch.poll();
    expect(await f.watch.inspect()).toMatchObject({ cursor: "12", pending: [{ id: "semantic-event" }] });
    await f.watch.flush();
    await f.watch.flush();
    expect(f.effects).toHaveLength(1);
    expect(f.effects[0]).toMatchObject({
      identity: { tenantId: "tenant", actorId: "actor" },
      policyRevision: 1,
      grantRefs: ["read-inbox", "notify-owner"],
      destination: "owner@example.com",
    });
    expect(Object.values((await f.watch.inspect()).outbox)[0]).toMatchObject({
      state: "confirmed",
      reservedDay: "2026-01-01",
    });
  });
  it("rolls back cursor and pending work if aggregate admission exceeds limits", async () => {
    const f = fixture({ limits: { maxPendingEvents: 1 } });
    await f.watch.activate();
    f.batch("11");
    await f.watch.poll();
    f.batch("12");
    await expect(f.watch.poll()).rejects.toThrow("pending event limit");
    expect(await f.watch.inspect()).toMatchObject({ cursor: "11", pending: [{ id: "11" }], wakes: 2 });
  });
  it("only accepts authenticated matching trigger identity and never trusts a push checkpoint", async () => {
    const f = fixture();
    await f.watch.activate();
    const hint = {
      ...definition().identity,
      sourceId: "gmail",
      sourceScope: "me@example.com",
      eventId: "push1",
      cursor: "99999999999999999999",
    };
    await expect(f.watch.trigger({ ...hint, tenantId: "other" })).rejects.toThrow("scope");
    expect(f.services.source.read).not.toHaveBeenCalled();
    f.batch("11");
    await f.watch.trigger(hint);
    expect(f.services.source.read).toHaveBeenCalledWith("10", expect.anything(), expect.any(AbortSignal));
    expect((await f.watch.inspect()).cursor).toBe("11");
  });
  it("suppresses full-resync history without resetting cooldown or pending legitimate work", async () => {
    const f = fixture({ cooldownMs: 10000 });
    await f.watch.activate();
    f.batch("11");
    await f.watch.poll();
    await f.watch.flush();
    const until = (await f.watch.inspect()).cooldownUntil;
    f.batch("20", "historic", true);
    await f.watch.poll();
    await f.watch.flush();
    expect(f.effects).toHaveLength(1);
    expect((await f.watch.inspect()).cooldownUntil).toBe(until);
    expect(Object.values((await f.watch.inspect()).decisions).find((d) => d.id === "historic")?.decision).toBe(
      "resync",
    );
  });
  it("reserves daily sends before effects, defers beyond the cap, and reauthorizes the send", async () => {
    const f = fixture({ limits: { maxNotificationsPerDay: 1 } });
    await f.watch.activate();
    f.batch("11");
    await f.watch.poll();
    await f.watch.flush();
    f.batch("12");
    await f.watch.poll();
    await f.watch.flush();
    expect(f.effects).toHaveLength(1);
    expect((await f.watch.inspect()).schedules.flush).toBe(Date.parse("2026-01-02T00:00:00Z"));
    f.advance(86400000);
    await f.watch.flush();
    expect(f.effects).toHaveLength(2);
    expect(f.services.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "flush", notifications: 1, events: 1 }),
    );
  });
  it("keeps unknown sends and reservations reconcilable after delete, never retrying an uncertain effect", async () => {
    const f = fixture();
    await f.watch.activate();
    f.batch("11");
    await f.watch.poll();
    vi.mocked(f.services.notifications.dispatch).mockImplementationOnce(async (action) => {
      f.effects.push(structuredClone(action));
      throw new Error("lost acknowledgement");
    });
    await expect(f.watch.flush()).rejects.toThrow("lost acknowledgement");
    await expect(f.watch.flush()).rejects.toThrow();
    expect(f.effects).toHaveLength(1);
    await f.watch.pause();
    await f.watch.delete();
    const state = await f.watch.inspect();
    const id = Object.keys(state.outbox)[0];
    expect(state).toMatchObject({ status: "deleted", daily: { "2026-01-01": 1 } });
    await f.watch.reconcile(id);
    await f.watch.reconcile(id);
    expect(f.services.notifications.reconcile).toHaveBeenCalledTimes(1);
    expect((await f.watch.inspect()).outbox[id].state).toBe("confirmed");
    expect((await f.store.get(f.watch.key))?.state).toBe("running");
    await f.watch.flush();
    expect(f.effects).toHaveLength(1);
  });
  it("updates into a new version while preserving old outbox bindings and inherited send caps", async () => {
    const f = fixture();
    await f.watch.activate();
    f.batch("11");
    await f.watch.poll();
    vi.mocked(f.services.notifications.dispatch).mockRejectedValueOnce(new Error("uncertain"));
    await expect(f.watch.flush()).rejects.toThrow("uncertain");
    const next = await f.watch.update(definition({ version: 2 }));
    expect((await next.inspect()).cursor).toBe("11");
    expect((await next.inspect()).daily).toEqual({ "2026-01-01": 1 });
    expect((await f.watch.inspect()).status).toBe("paused");
    await f.watch.reconcile(Object.keys((await f.watch.inspect()).outbox)[0]);
    expect(Object.keys((await next.inspect()).outbox)).toHaveLength(0);
  });
  it("reconciles and repeats cleanup at the operation limit without dispatching again", async () => {
    const f = fixture({ limits: { maxOperations: 3 } });
    await f.watch.activate();
    f.batch("11");
    await f.watch.poll();
    vi.mocked(f.services.notifications.dispatch).mockRejectedValueOnce(new Error("uncertain"));
    await expect(f.watch.flush()).rejects.toThrow("uncertain");
    await f.watch.delete();
    const id = Object.keys((await f.watch.inspect()).outbox)[0];
    await f.watch.reconcile(id);
    await f.watch.reconcile(id);
    await f.watch.pause();
    expect((await f.watch.inspect()).outbox[id].state).toBe("confirmed");
    expect(f.services.notifications.dispatch).toHaveBeenCalledTimes(1);
    expect(f.services.notifications.reconcile).toHaveBeenCalledTimes(1);
    expect((await f.store.get(f.watch.key))?.attempts).toHaveLength(3);
  });
  it("charges the actual delivery day when a prepared digest is delayed across midnight", async () => {
    const f = fixture({ limits: { maxNotificationsPerDay: 1 } });
    await f.watch.activate();
    f.batch("11");
    await f.watch.poll();
    vi.mocked(f.services.authorize).mockImplementation(async (request) => request.notifications === 0);
    await expect(f.watch.flush()).rejects.toThrow("denied");
    f.advance(86400000);
    vi.mocked(f.services.authorize).mockResolvedValue(true);
    await f.watch.flush();
    f.batch("12");
    await f.watch.poll();
    await f.watch.flush();
    expect(f.effects).toHaveLength(1);
    expect((await f.watch.inspect()).daily).toEqual({ "2026-01-01": 1, "2026-01-02": 1 });
  });
  it("namespaces schedules by tenant and renews expired subscriptions without advancing baseline", async () => {
    const f = fixture();
    const other = new DurableWatch(definition({ identity: { tenantId: "another", actorId: "actor" } }), f.services);
    await f.watch.activate();
    await other.activate();
    expect(f.jobs.size).toBe(4);
    f.advance(86400001);
    await f.watch.activate();
    expect(f.services.source.activate).toHaveBeenCalledTimes(3);
    expect(f.services.source.baseline).toHaveBeenCalledTimes(2);
  });
  it("retiring an old version cannot stop the replacement source subscription", async () => {
    const f = fixture();
    await f.watch.activate();
    const next = await f.watch.update(definition({ version: 2 }));
    await f.watch.delete();
    expect(f.services.source.stop).not.toHaveBeenCalled();
    await next.delete();
    expect(f.services.source.stop).toHaveBeenCalledTimes(1);
  });
  it("retains exclusive lease while noncooperative source work remains in flight", async () => {
    const f = fixture();
    await f.watch.activate();
    let finish!: (value: WatchSourceBatch) => void;
    vi.mocked(f.services.source.read).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const polling = f.watch.poll();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await expect(f.watch.pause()).rejects.toThrow("busy");
    finish({ cursor: "11", events: [], resynced: false });
    await polling;
    await f.watch.pause();
    expect((await f.watch.inspect()).status).toBe("paused");
  });
  it("bounds wake count and rejects mutable connector scope drift before effects", async () => {
    const f = fixture({ limits: { maxWakes: 1 } });
    await f.watch.activate();
    f.batch("11");
    await f.watch.poll();
    await expect(f.watch.poll()).rejects.toThrow("wake budget");
    f.services.notifications.destination = "other@example.com";
    await expect(f.watch.flush()).rejects.toThrow("scope");
    expect(f.effects).toHaveLength(0);
  });
});

describe("IANA quiet hours", () => {
  it("keeps both repeated autumn hours quiet and resumes at the first valid boundary", () => {
    const quiet = { start: "01:00", end: "02:00" };
    expect(isWatchQuiet(Date.parse("2026-11-01T05:30:00Z"), "America/New_York", quiet)).toBe(true);
    expect(isWatchQuiet(Date.parse("2026-11-01T06:30:00Z"), "America/New_York", quiet)).toBe(true);
    expect(nextWatchDelivery(Date.parse("2026-11-01T05:30:00Z"), "America/New_York", quiet)).toBe(
      Date.parse("2026-11-01T07:00:00Z"),
    );
  });
  it("uses first valid local time when spring-forward skips the configured end", () => {
    expect(
      nextWatchDelivery(Date.parse("2026-03-08T06:30:00Z"), "America/New_York", { start: "01:00", end: "02:30" }),
    ).toBe(Date.parse("2026-03-08T07:00:00Z"));
  });
});
