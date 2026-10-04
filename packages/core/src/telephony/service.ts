import { createHash } from "node:crypto";
import {
  bounded,
  deadline,
  identitySchema,
  parseInput,
  requestSchema,
  sameReference,
  terminal,
  validateRef,
} from "./common.js";
import {
  type CallAuthorization,
  type CallIdentity,
  type CallIntentKey,
  type CallIntentRecord,
  type CallIntentStore,
  type CallOperationOptions,
  type CallReference,
  type CallSnapshot,
  type NormalizedCallEvent,
  type OutboundCallProvider,
  type OutboundCallRequest,
  TelephonyError,
} from "./types.js";

function key(request: OutboundCallRequest): CallIntentKey {
  return { tenantId: request.identity.tenantId, intentId: request.intentId };
}
function digest(request: OutboundCallRequest, providerId: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        providerId,
        request.identity.tenantId,
        request.identity.userId,
        request.intentId,
        request.routeId,
        request.to,
        request.from,
      ]),
    )
    .digest("hex");
}
function safeFailure(error: unknown): TelephonyError {
  return error instanceof TelephonyError ? error : new TelephonyError("provider-unavailable", "unknown");
}
/** Local/test store only. It does not survive process loss or coordinate multiple workers. */
export class InMemoryCallIntentStore implements CallIntentStore {
  private readonly records = new Map<string, CallIntentRecord>();
  constructor(private readonly maxIntents = 10_000) {
    if (!Number.isInteger(maxIntents) || maxIntents < 1) throw new TelephonyError("invalid-input", "not-dispatched");
  }
  private id(value: CallIntentKey): string {
    return JSON.stringify([value.tenantId, value.intentId]);
  }
  async claim(value: CallIntentRecord) {
    const id = this.id(key(value.request));
    const previous = this.records.get(id);
    if (previous) return { claimed: false, record: structuredClone(previous) };
    if (this.records.size >= this.maxIntents) throw new TelephonyError("capacity", "not-dispatched");
    this.records.set(id, structuredClone(value));
    return { claimed: true, record: structuredClone(value) };
  }
  async get(value: CallIntentKey) {
    const result = this.records.get(this.id(value));
    return result ? structuredClone(result) : undefined;
  }
  async compareAndSet(value: CallIntentKey, revision: number, next: CallIntentRecord) {
    const id = this.id(value);
    const current = this.records.get(id);
    if (!current || current.revision !== revision) return false;
    if (
      next.revision !== revision + 1 ||
      next.digest !== current.digest ||
      next.providerId !== current.providerId ||
      digest(next.request, next.providerId) !== current.digest
    )
      throw new TelephonyError("conflict", "not-dispatched");
    this.records.set(id, structuredClone(next));
    return true;
  }
}
export interface OutboundCallServiceConfig {
  providers: readonly OutboundCallProvider[];
  store: CallIntentStore;
  /** Required for every operation, including deduplicated reads and callbacks. */
  authorize: (request: CallAuthorization) => boolean | Promise<boolean>;
}
export class OutboundCallService {
  private readonly providers = new Map<string, OutboundCallProvider>();
  private readonly store: CallIntentStore;
  private readonly authorize: OutboundCallServiceConfig["authorize"];
  constructor(config: OutboundCallServiceConfig) {
    if (typeof config.authorize !== "function" || !config.store)
      throw new TelephonyError("invalid-input", "not-dispatched");
    const hostStore = config.store;
    // Host storage exceptions can contain connection strings. Preserve only our safe errors.
    const storage = async <T>(operation: () => Promise<T>, outcome: "not-dispatched" | "unknown"): Promise<T> => {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof TelephonyError) throw error;
        throw new TelephonyError("store-unavailable", outcome);
      }
    };
    this.store = {
      claim: (record) => storage(() => hostStore.claim(record), "not-dispatched"),
      get: (key) => storage(() => hostStore.get(key), "not-dispatched"),
      compareAndSet: (key, revision, next) => storage(() => hostStore.compareAndSet(key, revision, next), "unknown"),
    };
    this.authorize = config.authorize;
    for (const provider of config.providers) {
      if (this.providers.has(provider.routeId)) throw new TelephonyError("conflict", "not-dispatched");
      this.providers.set(provider.routeId, provider);
    }
  }
  private provider(request: OutboundCallRequest): OutboundCallProvider {
    const provider = this.providers.get(request.routeId);
    if (!provider) throw new TelephonyError("invalid-input", "not-dispatched");
    return provider;
  }
  private async allowed(
    operation: CallAuthorization["operation"],
    identity: CallIdentity,
    request: OutboundCallRequest,
    ref?: CallReference,
    options?: CallOperationOptions,
  ) {
    if (identity.tenantId !== request.identity.tenantId || identity.userId !== request.identity.userId)
      throw new TelephonyError("unauthorized", "not-dispatched");
    const scope = deadline(options);
    try {
      if (
        (await bounded(
          async () => this.authorize(structuredClone({ operation, identity, request, ref })),
          scope.signal,
        )) === true
      )
        return;
    } catch {
      if (scope.signal.aborted) throw new TelephonyError("aborted", "not-dispatched");
    } finally {
      scope.dispose();
    }
    throw new TelephonyError("unauthorized", "not-dispatched");
  }
  private async load(
    identity: CallIdentity,
    intentId: string,
    operation: CallAuthorization["operation"],
    ref?: CallReference,
    options?: CallOperationOptions,
  ) {
    const verified = parseInput(identitySchema, identity);
    if (typeof intentId !== "string" || !/^[A-Za-z0-9_.:@-]{1,200}$/.test(intentId))
      throw new TelephonyError("invalid-input", "not-dispatched");
    const entry = await this.store.get({ tenantId: verified.tenantId, intentId });
    if (!entry) throw new TelephonyError("not-found", "not-dispatched");
    await this.allowed(operation, verified, entry.request, ref ?? entry.snapshot?.ref, options);
    if (this.provider(entry.request).id !== entry.providerId) throw new TelephonyError("conflict", "not-dispatched");
    return entry;
  }
  private async update(
    entry: CallIntentRecord,
    patch: Partial<Pick<CallIntentRecord, "creation" | "snapshot" | "hangup" | "errorCode">>,
  ): Promise<CallIntentRecord> {
    for (let attempt = 0; attempt < 16; attempt++) {
      const next = { ...entry, ...patch, revision: entry.revision + 1 };
      if (entry.snapshot) next.creation = "accepted";
      // Late reads/events cannot undo stronger evidence or terminal state.
      if (entry.snapshot && patch.snapshot) {
        if (!sameReference(entry.snapshot.ref, patch.snapshot.ref))
          throw new TelephonyError("conflict", "not-dispatched");
        const ranks = {
          unknown: 0,
          queued: 1,
          ringing: 2,
          active: 3,
          completed: 4,
          busy: 4,
          "no-answer": 4,
          cancelled: 4,
          failed: 4,
        };
        if (terminal(entry.snapshot.status) || ranks[patch.snapshot.status] < ranks[entry.snapshot.status])
          next.snapshot = entry.snapshot;
      }
      if (await this.store.compareAndSet(key(entry.request), entry.revision, next)) return next;
      const latest = await this.store.get(key(entry.request));
      if (!latest || latest.digest !== entry.digest) throw new TelephonyError("unresolved", "unknown");
      entry = latest;
    }
    throw new TelephonyError("unresolved", "unknown");
  }
  async create(value: OutboundCallRequest, options?: CallOperationOptions): Promise<CallIntentRecord> {
    const request = parseInput(requestSchema, value);
    const provider = this.provider(request);
    await this.allowed("create", request.identity, request, undefined, options);
    if (options?.signal?.aborted) throw new TelephonyError("aborted", "not-dispatched");
    const claimed = await this.store.claim({
      request,
      providerId: provider.id,
      digest: digest(request, provider.id),
      revision: 0,
      creation: "dispatching",
      hangup: "none",
    });
    if (claimed.record.digest !== digest(request, provider.id)) throw new TelephonyError("conflict", "not-dispatched");
    if (!claimed.claimed) return claimed.record; // Never replay dispatching/unknown/rejected entries.
    try {
      const result = await provider.create(structuredClone(request), options);
      validateRef(result.ref, provider.id, request.routeId);
      return await this.update(claimed.record, { creation: "accepted", snapshot: result });
    } catch (error) {
      const failure = safeFailure(error);
      await this.update(claimed.record, {
        creation: failure.outcome === "unknown" ? "unknown" : "rejected",
        errorCode: failure.code,
      });
      throw failure;
    }
  }
  async getIntent(identity: CallIdentity, intentId: string): Promise<CallIntentRecord> {
    return this.load(identity, intentId, "read");
  }
  async get(identity: CallIdentity, intentId: string, options?: CallOperationOptions): Promise<CallIntentRecord> {
    const entry = await this.load(identity, intentId, "read", undefined, options);
    if (!entry.snapshot) throw new TelephonyError("unresolved", "not-dispatched");
    const result = await this.provider(entry.request).get(entry.snapshot.ref, options);
    return this.update(entry, { snapshot: result });
  }
  async hangup(identity: CallIdentity, intentId: string, options?: CallOperationOptions): Promise<CallIntentRecord> {
    const principal = parseInput(identitySchema, identity);
    for (let attempt = 0; attempt < 16; attempt++) {
      // A status event may have advanced the revision without reserving this effect.
      // Reload and reauthorize before each retry; a competing hangup or terminal call wins.
      const entry = await this.load(principal, intentId, "hangup", undefined, options);
      if (!entry.snapshot) throw new TelephonyError("unresolved", "not-dispatched");
      if (entry.hangup !== "none" || terminal(entry.snapshot.status)) return entry;
      if (options?.signal?.aborted) throw new TelephonyError("aborted", "not-dispatched");
      const claimed = { ...entry, revision: entry.revision + 1, hangup: "dispatching" as const };
      if (!(await this.store.compareAndSet(key(entry.request), entry.revision, claimed))) continue;
      try {
        await this.provider(entry.request).hangup(entry.snapshot.ref, options);
        return await this.update(claimed, { hangup: "acknowledged" });
      } catch (error) {
        const failure = safeFailure(error);
        await this.update(claimed, {
          hangup: failure.outcome === "unknown" ? "unknown" : "rejected",
          errorCode: failure.code,
        });
        throw failure;
      }
    }
    throw new TelephonyError("conflict", "not-dispatched");
  }
  /** Host must establish correspondence to the original intent independently (provider logs/callback).
   * A failed/unknown create is never retried here. Binding cannot replace a known call.
   */
  async reconcile(
    identity: CallIdentity,
    intentId: string,
    ref: CallReference,
    options?: CallOperationOptions,
  ): Promise<CallIntentRecord> {
    // Parsing snapshots the caller-owned object before the first asynchronous boundary.
    const requestedRef = validateRef(ref, ref.providerId, ref.routeId);
    const entry = await this.load(identity, intentId, "reconcile", requestedRef, options);
    const provider = this.provider(entry.request);
    validateRef(requestedRef, provider.id, entry.request.routeId);
    if (entry.snapshot || entry.creation === "rejected") throw new TelephonyError("conflict", "not-dispatched");
    const result = await provider.get(requestedRef, options);
    if (!sameReference(result.ref, requestedRef)) throw new TelephonyError("invalid-response", "unknown");
    return this.update(entry, { creation: "accepted", snapshot: result, errorCode: undefined });
  }
  /** The host verifies signatures/account/freshness before invoking; no HTTP webhook endpoint is exposed. */
  async applyVerifiedEvent(
    identity: CallIdentity,
    intentId: string,
    event: NormalizedCallEvent,
  ): Promise<CallIntentRecord> {
    const entry = await this.load(identity, intentId, "event", event.ref);
    if (!entry.snapshot) throw new TelephonyError("unresolved", "not-dispatched");
    const provider = this.provider(entry.request);
    validateRef(event.ref, provider.id, entry.request.routeId);
    const statuses = [
      "queued",
      "ringing",
      "active",
      "completed",
      "busy",
      "no-answer",
      "cancelled",
      "failed",
      "unknown",
    ];
    if (
      !statuses.includes(event.status) ||
      typeof event.providerStatus !== "string" ||
      event.providerStatus.length > 100
    )
      throw new TelephonyError("invalid-input", "not-dispatched");
    const observed: CallSnapshot = {
      ref: { ...event.ref },
      status: event.status,
      providerStatus: event.providerStatus,
    };
    return this.update(entry, { snapshot: observed });
  }
}
