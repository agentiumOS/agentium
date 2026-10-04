import { describe, expect, it, vi } from "vitest";
import {
  type CallIntentStore,
  type CallSnapshot,
  InMemoryCallIntentStore,
  type OutboundCallProvider,
  OutboundCallService,
  TelephonyError,
} from "../index.js";

const identity = { tenantId: "tenant-a", userId: "user-a" };
const request = { identity, intentId: "intent-1", routeId: "route-1", to: "+14155550101", from: "+14155550102" };
const ref = { providerId: "fixture", routeId: "route-1", callId: "call-1" };
function fixture(store: CallIntentStore = new InMemoryCallIntentStore()) {
  const create = vi.fn(async (): Promise<CallSnapshot> => ({ ref, status: "queued", providerStatus: "queued" }));
  const get = vi.fn(async (): Promise<CallSnapshot> => ({ ref, status: "active", providerStatus: "active" }));
  const hangup = vi.fn(async () => ({ ref, acknowledged: true as const }));
  const provider: OutboundCallProvider = {
    id: "fixture",
    routeId: "route-1",
    create,
    get,
    hangup,
    capabilities: { transport: "http", automaticCreateRetry: false, callbackVerification: "host", hangup: "call" },
    normalizeVerifiedEvent: () => ({ ref, status: "active", providerStatus: "active" }),
  };
  const authorize = vi.fn(async () => true);
  const service = new OutboundCallService({ providers: [provider], store, authorize });
  return { create, get, hangup, provider, authorize, service, store };
}
describe("outbound intent lifecycle", () => {
  it("atomically deduplicates concurrent creates and rejects payload collisions", async () => {
    const f = fixture();
    const results = await Promise.all(Array.from({ length: 20 }, () => f.service.create(request)));
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(results.every((r) => ["dispatching", "accepted"].includes(r.creation))).toBe(true);
    expect((await f.service.create(request)).creation).toBe("accepted");
    await expect(f.service.create({ ...request, to: "+14155550199" })).rejects.toMatchObject({ code: "conflict" });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.authorize).toHaveBeenCalledTimes(22);
  });
  it("rejects forged actor access on every operation and keeps tenant keys isolated", async () => {
    const f = fixture();
    await f.service.create(request);
    const other = { ...identity, userId: "other" };
    for (const promise of [
      f.service.getIntent(other, request.intentId),
      f.service.get(other, request.intentId),
      f.service.hangup(other, request.intentId),
      f.service.reconcile(other, request.intentId, ref),
      f.service.applyVerifiedEvent(other, request.intentId, { ref, status: "completed", providerStatus: "completed" }),
    ]) {
      await expect(promise).rejects.toMatchObject({ code: "unauthorized" });
    }
    expect(f.get).not.toHaveBeenCalled();
    expect(f.hangup).not.toHaveBeenCalled();
    await expect(f.service.getIntent({ ...identity, tenantId: "other" }, request.intentId)).rejects.toMatchObject({
      code: "not-found",
    });
    await f.service.create({ ...request, identity: { ...identity, tenantId: "other" } });
    expect(f.create).toHaveBeenCalledTimes(2);
  });
  it("denies false/throwing admission and rechecks authorization for duplicate intents", async () => {
    const f = fixture();
    f.authorize.mockResolvedValueOnce(false);
    await expect(f.service.create(request)).rejects.toMatchObject({ code: "unauthorized" });
    expect(f.create).not.toHaveBeenCalled();
    await f.service.create(request);
    f.authorize.mockRejectedValueOnce(new Error("secret policy internals"));
    await expect(f.service.create(request)).rejects.toMatchObject({
      message: "Telephony operation failed: unauthorized (not-dispatched)",
    });
    expect(f.create).toHaveBeenCalledTimes(1);
  });
  it("does not claim or dispatch a pre-aborted request", async () => {
    const f = fixture();
    await expect(f.service.create(request, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      outcome: "not-dispatched",
    });
    expect(await f.store.get({ tenantId: identity.tenantId, intentId: request.intentId })).toBeUndefined();
    expect(f.create).not.toHaveBeenCalled();
  });
  it("preserves ambiguous creation and never retries across service reconstruction", async () => {
    const f = fixture();
    f.create.mockRejectedValueOnce(new Error("network secret"));
    await expect(f.service.create(request)).rejects.toMatchObject({ outcome: "unknown" });
    const resumed = new OutboundCallService({ store: f.store, providers: [f.provider], authorize: f.authorize });
    expect((await resumed.create(request)).creation).toBe("unknown");
    expect(f.create).toHaveBeenCalledTimes(1);
    await expect(resumed.hangup(identity, request.intentId)).rejects.toMatchObject({ code: "unresolved" });
    expect((await resumed.reconcile(identity, request.intentId, ref)).creation).toBe("accepted");
    await resumed.hangup(identity, request.intentId);
    expect(f.hangup).toHaveBeenCalledTimes(1);
    await expect(resumed.reconcile(identity, request.intentId, { ...ref, callId: "other" })).rejects.toMatchObject({
      code: "conflict",
    });
  });
  it("keeps a crash-window reservation unresolved until host reconciliation", async () => {
    const f = fixture();
    let resolve!: (snapshot: CallSnapshot) => void;
    f.create.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = f.service.create(request);
    await vi.waitFor(() => expect(f.create).toHaveBeenCalledOnce());
    const resumed = new OutboundCallService({ store: f.store, providers: [f.provider], authorize: f.authorize });
    expect((await resumed.create(request)).creation).toBe("dispatching");
    expect(f.create).toHaveBeenCalledTimes(1);
    await resumed.reconcile(identity, request.intentId, ref);
    resolve({ ref, status: "queued", providerStatus: "queued" });
    await pending;
    expect((await resumed.getIntent(identity, request.intentId)).snapshot?.status).toBe("active");
  });
  it("deduplicates concurrent hangup and requires terminal evidence after acknowledgment", async () => {
    const f = fixture();
    await f.service.create(request);
    await Promise.all(Array.from({ length: 10 }, () => f.service.hangup(identity, request.intentId)));
    expect(f.hangup).toHaveBeenCalledTimes(1);
    const state = await f.service.getIntent(identity, request.intentId);
    expect(state.hangup).toBe("acknowledged");
    expect(state.snapshot?.status).toBe("queued");
    await f.service.applyVerifiedEvent(identity, request.intentId, {
      ref,
      status: "completed",
      providerStatus: "completed",
    });
    await f.service.applyVerifiedEvent(identity, request.intentId, {
      ref,
      status: "ringing",
      providerStatus: "ringing",
    });
    await f.service.get(identity, request.intentId);
    expect((await f.service.getIntent(identity, request.intentId)).snapshot?.status).toBe("completed");
  });
  it("does not replay an uncertain hangup and rejects events for another call", async () => {
    const f = fixture();
    await f.service.create(request);
    f.hangup.mockRejectedValueOnce(new Error("secret"));
    await expect(f.service.hangup(identity, request.intentId)).rejects.toMatchObject({ outcome: "unknown" });
    expect((await f.service.hangup(identity, request.intentId)).hangup).toBe("unknown");
    expect(f.hangup).toHaveBeenCalledTimes(1);
    await expect(
      f.service.applyVerifiedEvent(identity, request.intentId, {
        ref: { ...ref, callId: "other" },
        status: "completed",
        providerStatus: "completed",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
  it("isolates caller/authorizer mutation and refuses capacity eviction", async () => {
    const f = fixture(new InMemoryCallIntentStore(1));
    f.authorize.mockImplementationOnce(async (value?: unknown) => {
      if (value) (value as { request: { to: string } }).request.to = "+14155550199";
      return true;
    });
    const result = await f.service.create(request);
    result.request.to = "+14155550188";
    expect((await f.service.getIntent(identity, request.intentId)).request.to).toBe(request.to);
    await expect(f.service.create({ ...request, intentId: "intent-2" })).rejects.toMatchObject({ code: "capacity" });
    expect(f.create).toHaveBeenCalledTimes(1);
  });
  it("retains explicit provider rejection, requiring a new intent for any new call", async () => {
    const f = fixture();
    f.create.mockRejectedValueOnce(new TelephonyError("provider-rejected", "rejected", 400));
    await expect(f.service.create(request)).rejects.toMatchObject({ outcome: "rejected" });
    expect((await f.service.create(request)).creation).toBe("rejected");
    await expect(f.service.reconcile(identity, request.intentId, ref)).rejects.toMatchObject({ code: "conflict" });
    expect(f.create).toHaveBeenCalledTimes(1);
  });
  it("cancels a stalled authorizer without any claim or dispatch", async () => {
    const f = fixture();
    f.authorize.mockImplementationOnce(() => new Promise(() => {}));
    await expect(f.service.create(request, { timeoutMs: 5 })).rejects.toMatchObject({
      code: "aborted",
      outcome: "not-dispatched",
    });
    expect(f.create).not.toHaveBeenCalled();
    expect(await f.store.get({ tenantId: identity.tenantId, intentId: request.intentId })).toBeUndefined();
  });
  it("redacts storage failures and does not dispatch after a failed claim", async () => {
    const store: CallIntentStore = {
      claim: async () => {
        throw new Error("secret database credential");
      },
      get: async () => undefined,
      compareAndSet: async () => false,
    };
    const f = fixture(store);
    await expect(f.service.create(request)).rejects.toMatchObject({
      message: "Telephony operation failed: store-unavailable (not-dispatched)",
    });
    expect(f.create).not.toHaveBeenCalled();
  });
  it.each(["status", "terminal", "hangup"] as const)(
    "resolves a hangup reservation racing a %s update",
    async (winner) => {
      const store = new InMemoryCallIntentStore();
      let raced = false;
      const racing: CallIntentStore = {
        claim: (entry) => store.claim(entry),
        get: (key) => store.get(key),
        compareAndSet: async (key, revision, next) => {
          if (next.hangup === "dispatching" && !raced) {
            raced = true;
            const current = (await store.get(key))!;
            await store.compareAndSet(key, revision, {
              ...current,
              revision: revision + 1,
              hangup: winner === "hangup" ? "dispatching" : "none",
              snapshot: {
                ref,
                status: winner === "terminal" ? "completed" : "active",
                providerStatus: winner === "terminal" ? "completed" : "active",
              },
            });
            return false;
          }
          return store.compareAndSet(key, revision, next);
        },
      };
      const f = fixture(racing);
      await f.service.create(request);
      const result = await f.service.hangup(identity, request.intentId);
      expect(f.hangup).toHaveBeenCalledTimes(winner === "status" ? 1 : 0);
      expect(result.hangup).toBe(winner === "status" ? "acknowledged" : winner === "hangup" ? "dispatching" : "none");
      expect(result.snapshot?.status).toBe(winner === "terminal" ? "completed" : "active");
      expect(f.authorize).toHaveBeenCalledTimes(3);
    },
  );
  it("rechecks authorization after a lost hangup reservation and bounds repeated CAS failures", async () => {
    for (const revoke of [true, false]) {
      const store = new InMemoryCallIntentStore();
      let reservations = 0;
      const f = fixture({
        claim: (entry) => store.claim(entry),
        get: (key) => store.get(key),
        compareAndSet: async (key, revision, next) => {
          if (next.hangup === "dispatching") {
            reservations++;
            return false;
          }
          return store.compareAndSet(key, revision, next);
        },
      });
      await f.service.create(request);
      if (revoke) f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      await expect(f.service.hangup(identity, request.intentId)).rejects.toMatchObject({
        code: revoke ? "unauthorized" : "conflict",
        outcome: "not-dispatched",
      });
      expect(f.hangup).not.toHaveBeenCalled();
      expect(reservations).toBe(revoke ? 1 : 16);
    }
  });
  it("binds only the reference snapshotted before reconciliation authorization", async () => {
    const f = fixture();
    f.create.mockRejectedValueOnce(new Error("ambiguous"));
    await expect(f.service.create(request)).rejects.toMatchObject({ outcome: "unknown" });
    let allow!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const reads: string[] = [];
    const service = new OutboundCallService({
      store: f.store,
      providers: [
        {
          ...f.provider,
          get: async (value) => {
            reads.push(value.callId);
            return { ref: value, status: "active", providerStatus: "active" };
          },
        },
      ],
      authorize: async (value) => {
        if (value.operation === "reconcile") {
          if (value.ref?.callId !== "approved") return false;
          entered();
          await new Promise<void>((resolve) => {
            allow = resolve;
          });
        }
        return true;
      },
    });
    const mutable = { ...ref, callId: "approved" };
    const pending = service.reconcile(identity, request.intentId, mutable);
    await waiting;
    mutable.callId = "not-approved";
    allow();
    const result = await pending;
    expect(reads).toEqual(["approved"]);
    expect(result.snapshot?.ref.callId).toBe("approved");
  });
});
