import { randomUUID } from "node:crypto";
import {
  DurableActionLedger,
  type DurableFence,
  type DurableJSON,
  type DurableTaskRecord,
  DurableTaskSupervisor,
  durableCanonical,
  durableDigest,
} from "@agentium/core";
import { defineWatch, watchId } from "./definition.js";
import { nextWatchDelivery, watchClock } from "./quiet-hours.js";
import type {
  WatchDefinition,
  WatchDefinitionInput,
  WatchOperation,
  WatchScheduleKind,
  WatchServices,
  WatchState,
} from "./types.js";

type Owned = { fence: DurableFence; signal: AbortSignal; actions: DurableActionLedger };
const kinds: WatchScheduleKind[] = ["poll", "renew", "flush"];
function initial(): WatchState {
  return {
    status: "inactive",
    cursor: null,
    subscription: null,
    wakes: 0,
    decisions: {},
    pending: [],
    outbox: {},
    daily: {},
    cooldownUntil: 0,
    schedules: {},
  };
}
/** A bounded, versioned watch. Construction is inert; all I/O requires an explicit method call. */
export class DurableWatch {
  readonly definition: WatchDefinition;
  readonly key: { tenantId: string; taskId: string };
  private readonly hash: string;
  private readonly supervisor: DurableTaskSupervisor;
  private readonly connectorVersion: string;
  constructor(
    definition: WatchDefinitionInput,
    private readonly services: WatchServices,
  ) {
    this.definition = defineWatch(definition);
    this.hash = durableDigest(this.definition);
    this.key = Object.freeze({
      tenantId: this.definition.identity.tenantId,
      taskId: `watch:${durableDigest([this.definition.identity.tenantId, this.definition.id, this.definition.version])}`,
    });
    this.checkBindings();
    this.connectorVersion = services.notifications.version;
    watchId(this.connectorVersion);
    if (
      !services.source.capabilities.idempotentActivation ||
      !services.source.capabilities.polling ||
      !services.scheduler.capabilities.idempotentUpsert
    )
      throw new Error("Watch needs idempotent source activation, polling and scheduler upserts");
    if (
      services.requireDurability !== false &&
      (!services.store.capabilities.durable ||
        !services.store.capabilities.durableOutbox ||
        !services.scheduler.capabilities.durable)
    )
      throw new Error("Durable watch requires durable storage, outbox and scheduling; opt out only for fixtures");
    this.supervisor = new DurableTaskSupervisor(services.store, { leaseMs: services.leaseMs });
  }
  private checkBindings() {
    const d = this.definition;
    if (
      this.services.source.id !== d.sourceId ||
      this.services.source.scope !== d.sourceScope ||
      this.services.notifications.channel !== d.channel ||
      this.services.notifications.destination !== d.destination
    )
      throw new Error("Watch service scope does not match definition");
    if (this.connectorVersion !== undefined && this.services.notifications.version !== this.connectorVersion)
      throw new Error("Watch notification connector changed; create a new configuration version");
  }
  private async authorize(operation: WatchOperation, notifications = 0, events = 0) {
    this.checkBindings();
    if ((await this.services.authorize({ operation, definition: this.definition, notifications, events })) !== true)
      throw new Error(`Watch ${operation} authorization denied`);
  }
  private state(task: DurableTaskRecord): WatchState {
    if (task.manifestHash !== this.hash) throw new Error("Watch version already bound to a different definition");
    return task.extensions.watch as unknown as WatchState;
  }
  private async read(): Promise<DurableTaskRecord> {
    const task = await this.services.store.get(this.key);
    if (!task) throw new Error("Watch has not been activated");
    this.state(task);
    return task;
  }
  private async mutate(owned: Owned, fn: (state: WatchState, now: number, task: DurableTaskRecord) => void) {
    owned.signal.throwIfAborted();
    return this.services.store.update(
      this.key,
      (draft, now) => {
        const state = this.state(draft);
        fn(state, now, draft);
        if (Buffer.byteLength(durableCanonical(state)) > this.definition.limits.maxStateBytes)
          throw new Error("Watch state size limit reached");
      },
      owned.fence,
    );
  }
  private async ensureRecord() {
    if (await this.services.store.get(this.key)) {
      await this.read();
      return;
    }
    const d = this.definition;
    try {
      await this.services.store.create({
        id: this.key.taskId,
        identity: { ...d.identity, sessionId: this.key.taskId, runId: this.key.taskId, rootRunId: this.key.taskId },
        manifestHash: this.hash,
        inputRef: `watch:${this.hash}`,
        policyRevision: d.policyRevision,
        grantRefs: d.grantRefs,
        budget: { maxAttempts: d.limits.maxOperations, maxTokens: 0, maxCostMicros: 0 },
        extensions: { watch: initial() as unknown as DurableJSON },
      });
    } catch (error) {
      if (!(await this.services.store.get(this.key))) throw error;
      await this.read();
    }
  }
  private async owned<T>(operation: WatchOperation, fn: (owned: Owned) => Promise<T>): Promise<T> {
    await this.authorize(operation);
    await this.read();
    const maintenance = operation === "pause" || operation === "delete" || operation === "reconcile";
    const workerId = randomUUID();
    const task = maintenance
      ? await this.services.store.update(this.key, (draft, now) => {
          this.state(draft);
          if (draft.lease && draft.lease.expiresAt > now) throw new Error("Watch is busy");
          // Cleanup must remain possible after work is exhausted or canceled. Keep terminal state
          // and attempt history intact: this lease authorizes no new work or notification dispatch.
          for (const action of Object.values(draft.actions)) if (action.state === "executing") action.state = "unknown";
          draft.fence++;
          draft.lease = { workerId, fence: draft.fence, expiresAt: now + this.supervisor.leaseMs };
        })
      : await this.supervisor.claim(this.key, workerId);
    if (!task?.lease) throw new Error("Watch is busy or its operation budget is exhausted");
    const controller = new AbortController();
    const owned: Owned = {
      fence: task.lease,
      signal: controller.signal,
      actions: new DurableActionLedger(this.services.store, this.key, task.lease, controller.signal),
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polling: Promise<void> | undefined;
    let finished = false;
    const heartbeat = async () => {
      try {
        if (maintenance)
          await this.services.store.update(
            this.key,
            (draft, now) => {
              draft.lease!.expiresAt = now + this.supervisor.leaseMs;
            },
            owned.fence,
          );
        else await this.supervisor.renew(this.key, owned.fence);
      } catch (error) {
        controller.abort(error);
      }
      if (!finished && !controller.signal.aborted)
        timer = setTimeout(
          () => {
            polling = heartbeat();
          },
          Math.max(1, Math.floor(this.supervisor.leaseMs / 3)),
        );
    };
    timer = setTimeout(
      () => {
        polling = heartbeat();
      },
      Math.max(1, Math.floor(this.supervisor.leaseMs / 3)),
    );
    let failure: unknown;
    let failed = false;
    let result!: T;
    try {
      result = await fn(owned);
      controller.signal.throwIfAborted();
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      await owned.actions.quiesce();
      finished = true;
      clearTimeout(timer);
      await polling;
      try {
        await this.supervisor.release(this.key, owned.fence);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
    if (failed) throw failure;
    return result;
  }
  private scheduleKey(kind: WatchScheduleKind) {
    return `${this.key.taskId}:${kind}`;
  }
  private async syncSchedules(owned: Owned) {
    const state = this.state(await this.read());
    for (const kind of kinds) {
      owned.signal.throwIfAborted();
      const at = state.schedules[kind];
      if (state.status === "active" && at !== undefined)
        await this.services.scheduler.schedule({
          key: this.scheduleKey(kind),
          identity: this.definition.identity,
          watchId: this.definition.id,
          configVersion: this.definition.version,
          kind,
          at,
        });
      else await this.services.scheduler.cancel(this.scheduleKey(kind));
    }
  }
  private async start(owned: Owned) {
    const current = await this.read();
    let state = this.state(current);
    if (state.status === "deleted") throw new Error("Deleted watch cannot resume; create a new version");
    if (state.status === "active" && state.subscription && state.subscription.expiresAt > current.updatedAt) {
      await this.syncSchedules(owned);
      return;
    }
    if (state.cursor === null) {
      const cursor = await this.services.source.baseline(owned.signal);
      this.validateCursor(cursor);
      await this.mutate(owned, (s) => {
        s.cursor = cursor;
        s.status = "activating";
      });
    }
    owned.signal.throwIfAborted();
    const subscription = await this.services.source.activate(this.key.taskId, owned.signal);
    watchId(subscription.reference);
    await this.mutate(owned, (s, now) => {
      if (!Number.isSafeInteger(subscription.expiresAt) || subscription.expiresAt <= now)
        throw new Error("Source returned expired subscription");
      s.subscription = subscription;
      s.status = "active";
      s.schedules.poll = now + this.definition.pollIntervalMs;
      s.schedules.renew = this.renewAt(now, subscription.expiresAt);
      if (s.pending.length || Object.values(s.outbox).some((o) => o.state === "pending"))
        s.schedules.flush = this.deliveryAt(s, now);
    });
    state = this.state(await this.read());
    if (state.status === "active") await this.syncSchedules(owned);
  }
  private renewAt(now: number, expiresAt: number) {
    return Math.min(now + this.definition.renewalIntervalMs, now + Math.max(1, Math.floor((expiresAt - now) / 2)));
  }
  private deliveryAt(state: WatchState, now: number) {
    const d = this.definition;
    let at = Math.max(now, state.cooldownUntil);
    at = nextWatchDelivery(at, d.timeZone, d.quietHours);
    if ((state.daily[watchClock(at, d.timeZone).day] ?? 0) >= d.limits.maxNotificationsPerDay)
      at = nextWatchDelivery(at, d.timeZone, d.quietHours, true);
    return at;
  }
  async activate(): Promise<void> {
    await this.authorize("activate");
    await this.ensureRecord();
    await this.owned("activate", (owned) => this.start(owned));
  }
  async resume(): Promise<void> {
    await this.owned("resume", (owned) => this.start(owned));
  }
  async inspect(): Promise<WatchState> {
    await this.authorize("inspect");
    return structuredClone(this.state(await this.read()));
  }
  async pause(): Promise<void> {
    await this.owned("pause", async (owned) => {
      await this.mutate(owned, (s) => {
        if (s.status !== "deleted") s.status = "paused";
        s.schedules = {};
      });
      await this.syncSchedules(owned);
    });
  }
  async delete(): Promise<void> {
    await this.owned("delete", async (owned) => {
      const task = await this.mutate(owned, (s) => {
        s.status = "deleted";
        s.schedules = {};
      });
      await this.syncSchedules(owned);
      const subscription = this.state(task).subscription;
      if (subscription) await this.services.source.stop(subscription, owned.signal);
      // The aggregate stays nonterminal: unknown notifications still need reconciliation.
    });
  }
  /** Explicit fail-closed rollout. Old pending/unknown sends stay bound to the old definition. */
  async update(definition: WatchDefinitionInput, services: WatchServices = this.services): Promise<DurableWatch> {
    const next = new DurableWatch(definition, services);
    if (
      next.definition.id !== this.definition.id ||
      next.definition.version <= this.definition.version ||
      next.definition.timeZone !== this.definition.timeZone ||
      durableCanonical(next.definition.identity) !== durableCanonical(this.definition.identity)
    )
      throw new Error("Watch update requires same identity/id/timezone and a newer version");
    await this.authorize("update");
    await this.pause();
    const previous = this.state(await this.read());
    const sameSource =
      next.definition.sourceId === this.definition.sourceId &&
      next.definition.sourceScope === this.definition.sourceScope;
    if (sameSource)
      await this.owned("update", async (owned) => {
        // Retire source ownership before activating its replacement. Deleting this version must not stop the new subscription.
        await this.mutate(owned, (s) => {
          s.subscription = null;
        });
      });
    await next.authorize("activate");
    await next.ensureRecord();
    await next.owned("activate", async (owned) => {
      await next.mutate(owned, (s) => {
        if (s.status !== "inactive") return;
        if (sameSource) {
          s.cursor = previous.cursor;
          s.cooldownUntil = previous.cooldownUntil;
          s.daily = structuredClone(previous.daily);
          s.decisions = Object.fromEntries(
            Object.entries(previous.decisions).map(([key, value]) => [key, { ...value, decision: "ignored" as const }]),
          );
          if (Object.keys(s.decisions).length > next.definition.limits.maxDecisions)
            throw new Error("New watch decision limit cannot retain deduplication history");
          // Old decisions/outbox remain auditable in the old version; copied IDs prevent duplicate admission.
        }
      });
      await next.start(owned);
    });
    return next;
  }
  private validateCursor(cursor: string) {
    watchId(cursor);
    if (this.services.source.compareCursors(cursor, cursor) !== 0) throw new Error("Invalid source cursor");
  }
  async trigger(raw: unknown): Promise<void> {
    await this.authorize("trigger");
    const verify = this.services.source.verifyTrigger;
    if (!this.services.source.capabilities.push || !verify)
      throw new Error("Watch source does not support verified push");
    const trigger = await verify.call(this.services.source, raw);
    const d = this.definition;
    if (
      trigger.tenantId !== d.identity.tenantId ||
      trigger.actorId !== d.identity.actorId ||
      trigger.sourceId !== d.sourceId ||
      trigger.sourceScope !== d.sourceScope
    )
      throw new Error("Authenticated trigger scope differs from watch");
    watchId(trigger.eventId);
    this.validateCursor(trigger.cursor);
    await this.poll(); // Push cursor is only a hint; source reads from the persisted checkpoint.
  }
  async poll(): Promise<void> {
    await this.owned("poll", async (owned) => {
      const before = this.state(await this.read());
      if (before.status !== "active") return;
      if (before.wakes >= this.definition.limits.maxWakes) throw new Error("Watch wake budget exhausted");
      if (before.cursor === null) throw new Error("Watch has no cursor");
      // Reserve wake even when a source request fails.
      await this.mutate(owned, (s) => {
        s.wakes++;
      });
      const batch = await this.services.source.read(before.cursor, this.definition.limits, owned.signal);
      this.validateCursor(batch.cursor);
      if (this.services.source.compareCursors(batch.cursor, before.cursor) < 0)
        throw new Error("Source cursor regressed");
      const limit = batch.resynced ? this.definition.limits.maxResyncEvents : this.definition.limits.maxEventsPerWake;
      if (!Array.isArray(batch.events) || batch.events.length > limit || typeof batch.resynced !== "boolean")
        throw new Error("Source exceeded watch batch bounds");
      const events = batch.events.map((event) => {
        watchId(event.id);
        if (
          !Number.isSafeInteger(event.occurredAt) ||
          event.occurredAt < 0 ||
          Buffer.byteLength(durableCanonical(event)) > this.definition.limits.maxEventBytes
        )
          throw new Error("Invalid or oversized watch event");
        const copy = structuredClone(event);
        const decision = batch.resynced
          ? "resync"
          : (this.services.filter ? this.services.filter(structuredClone(copy)) : true) === true
            ? "pending"
            : "ignored";
        return { event: copy, decision } as const;
      });
      await this.mutate(owned, (s, now) => {
        for (const { event, decision } of events) {
          const key = durableDigest(event.id);
          if (s.decisions[key]) continue;
          if (Object.keys(s.decisions).length >= this.definition.limits.maxDecisions)
            throw new Error("Watch decision limit reached; rotate the watch version");
          s.decisions[key] = { id: event.id, decision, at: now };
          if (decision === "pending") s.pending.push(event);
        }
        if (s.pending.length > this.definition.limits.maxPendingEvents)
          throw new Error("Watch pending event limit reached");
        s.cursor = batch.cursor;
        s.schedules.poll = now + this.definition.pollIntervalMs;
        if (s.pending.length) s.schedules.flush = this.deliveryAt(s, now);
      });
      await this.syncSchedules(owned);
    });
  }
  async renew(): Promise<void> {
    await this.owned("renew", async (owned) => {
      if (this.state(await this.read()).status !== "active") return;
      const subscription = await this.services.source.activate(this.key.taskId, owned.signal);
      watchId(subscription.reference);
      await this.mutate(owned, (s, now) => {
        if (!Number.isSafeInteger(subscription.expiresAt) || subscription.expiresAt <= now)
          throw new Error("Source returned expired subscription");
        s.subscription = subscription;
        s.schedules.renew = this.renewAt(now, subscription.expiresAt);
      });
      await this.syncSchedules(owned);
    });
  }
  /** Delivers at most one digest. It never retries an unresolved external effect. */
  async flush(): Promise<void> {
    await this.owned("flush", async (owned) => {
      const task = await this.mutate(owned, (s, now, draft) => {
        delete s.schedules.flush;
        if (s.status !== "active") return;
        for (const box of Object.values(s.outbox))
          if (draft.actions[box.id]?.state === "confirmed") {
            box.state = "confirmed";
            box.resultRef = draft.actions[box.id].resultRef!;
          }
        if (!s.pending.length && !Object.values(s.outbox).some((o) => o.state === "pending")) return;
        const at = this.deliveryAt(s, now);
        if (at > now) {
          s.schedules.flush = at;
          return;
        }
        let box = Object.values(s.outbox).find((o) => o.state === "pending");
        if (!box) {
          if (Object.keys(s.outbox).length >= this.definition.limits.maxOutbox)
            throw new Error("Watch outbox limit reached; rotate the watch version");
          const events = s.pending.splice(0, this.definition.limits.maxEventsPerWake);
          const id = durableDigest([this.hash, events.map((event) => event.id)]);
          box = {
            id,
            events,
            eventIds: events.map((event) => event.id),
            state: "pending",
            reservedDay: null,
            resultRef: null,
          };
          s.outbox[id] = box;
          for (const event of events) s.decisions[durableDigest(event.id)].decision = "outbox";
        }
        const action = draft.actions[box.id];
        if (action && !["prepared", "confirmed"].includes(action.state)) return;
        const day = watchClock(now, this.definition.timeZone).day;
        if (box.reservedDay !== day) {
          // A previously reserved but unsent effect moved to another day: retain the old charge and reserve today's cap too.
          box.reservedDay = day;
          s.daily[box.reservedDay] = (s.daily[box.reservedDay] ?? 0) + 1;
          s.cooldownUntil = now + this.definition.cooldownMs;
        }
      });
      const s = this.state(task);
      const box = Object.values(s.outbox).find((o) => o.state === "pending");
      if (s.status === "active" && box?.reservedDay && s.schedules.flush === undefined) {
        await this.authorize("flush", 1, box.events.length);
        owned.signal.throwIfAborted();
        const result = await owned.actions.execute(
          {
            id: box.id,
            connectorVersion: this.connectorVersion,
            destination: this.definition.destination,
            args: {
              watchId: this.definition.id,
              version: this.definition.version,
              channel: this.definition.channel,
              events: box.events as unknown as DurableJSON,
            },
          },
          this.services.notifications,
        );
        await this.mutate(owned, (state, now) => {
          state.outbox[box.id].state = "confirmed";
          state.outbox[box.id].resultRef = result.resultRef;
          if (state.pending.length) state.schedules.flush = this.deliveryAt(state, now);
        });
      }
      await this.syncSchedules(owned);
    });
  }
  /** Reconciliation remains available after pause/delete/update; it never dispatches a send. */
  async reconcile(outboxId: string): Promise<void> {
    await this.owned("reconcile", async (owned) => {
      const task = await this.read();
      const state = this.state(task);
      if (!state.outbox[outboxId]) throw new Error("Unknown watch outbox entry");
      const persisted = task.actions[outboxId];
      // Replaying reconciliation after a crash between ledger confirmation and outbox acknowledgement is safe.
      const action =
        persisted?.state === "confirmed" || (persisted?.state === "prepared" && persisted.evidenceRef)
          ? persisted
          : await owned.actions.reconcile(outboxId, this.services.notifications);
      if (action.state === "confirmed")
        await this.mutate(owned, (s) => {
          s.outbox[outboxId].state = "confirmed";
          s.outbox[outboxId].resultRef = action.resultRef!;
        });
    });
  }
}
