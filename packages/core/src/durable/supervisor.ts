import { randomUUID } from "node:crypto";
import { DurableActionLedger } from "./actions.js";
import { durableId, durableInteger, isDurableTerminal } from "./store.js";
import {
  AwaitingDurableApproval,
  DurableConflictError,
  type DurableFence,
  type DurableLease,
  DurableLeaseError,
  DurableRecoveryRequiredError,
  type DurableTaskInput,
  type DurableTaskKey,
  type DurableTaskRecord,
  type DurableTaskStore,
} from "./types.js";
export interface DurableExecutionContext {
  task: DurableTaskRecord;
  lease: DurableLease;
  signal: AbortSignal;
  actions: DurableActionLedger;
  reserve(tokens: number, costMicros: number): Promise<void>;
}
export type DurableTaskHandler = (
  context: DurableExecutionContext,
  // biome-ignore lint/suspicious/noConfusingVoidType: host handlers may intentionally return no result.
) => Promise<{ state?: "completed" | "stopped"; resultRef?: string } | void>;
/** Leases fence local commits, not requests already sent to external connectors. */
export class DurableTaskSupervisor {
  readonly leaseMs: number;
  constructor(
    readonly store: DurableTaskStore,
    private options: { leaseMs?: number; pollMs?: number } = {},
  ) {
    this.leaseMs = options.leaseMs ?? 30_000;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 10)
      throw new TypeError("leaseMs must be an integer >= 10");
    if (
      options.pollMs !== undefined &&
      (!Number.isSafeInteger(options.pollMs) || options.pollMs < 1 || options.pollMs >= this.leaseMs)
    )
      throw new TypeError("pollMs must be positive and below leaseMs");
    if (!store.capabilities.atomicTaskUpdates || !store.capabilities.fencing)
      throw new TypeError("Durable supervisor requires atomic fenced updates");
  }
  create(input: DurableTaskInput): Promise<DurableTaskRecord> {
    return this.store.create(input);
  }
  get(key: DurableTaskKey): Promise<DurableTaskRecord | null> {
    return this.store.get(key);
  }
  async claim(key: DurableTaskKey, workerId: string): Promise<DurableTaskRecord | null> {
    durableId(workerId);
    const attemptId = randomUUID();
    try {
      return await this.store.update(key, (draft, now) => {
        if (isDurableTerminal(draft.state) || (draft.lease && draft.lease.expiresAt > now)) throw new NotClaimable();
        if (
          draft.state === "awaiting_approval" &&
          Object.values(draft.approvals).some((a) => a.decision === "pending" && a.expiresAt > now)
        )
          throw new NotClaimable();
        const canceling = draft.state === "cancel_requested";
        for (const action of Object.values(draft.actions)) if (action.state === "executing") action.state = "unknown";
        const recoveryRequired = Object.values(draft.actions).some((action) => action.state === "unknown");
        const exhausted = draft.attempts.length >= draft.budget.maxAttempts;
        if (!canceling && exhausted && !recoveryRequired) {
          draft.state = "stopped";
          delete draft.lease;
          return;
        }
        draft.fence++;
        draft.lease = { workerId, fence: draft.fence, expiresAt: now + this.leaseMs };
        if (!canceling) {
          draft.state = "running";
          if (!exhausted) draft.attempts.push({ id: attemptId, workerId, fence: draft.fence, startedAt: now });
        }
      });
    } catch (error) {
      if (error instanceof NotClaimable) return null;
      throw error;
    }
  }
  async renew(key: DurableTaskKey, lease: DurableFence): Promise<DurableTaskRecord> {
    return this.store.update(
      key,
      (draft, now) => {
        if (isDurableTerminal(draft.state)) throw new DurableConflictError("Cannot renew terminal task");
        draft.lease!.expiresAt = now + this.leaseMs;
      },
      lease,
    );
  }
  async release(key: DurableTaskKey, lease: DurableFence): Promise<void> {
    await this.store.update(
      key,
      (draft) => {
        delete draft.lease;
      },
      lease,
    );
  }
  async cancel(key: DurableTaskKey, reason = "Host requested cancellation"): Promise<DurableTaskRecord> {
    return this.store.update(key, (draft) => {
      if (isDurableTerminal(draft.state) || draft.state === "cancel_requested") return;
      draft.state = "cancel_requested";
      draft.cancelReason = reason;
    });
  }
  async acknowledgeCancellation(key: DurableTaskKey, lease: DurableFence): Promise<DurableTaskRecord> {
    return this.store.update(
      key,
      (draft) => {
        if (draft.state !== "cancel_requested") throw new DurableConflictError("Cancellation was not requested");
        if (Object.values(draft.actions).some((a) => a.state === "unknown" || a.state === "executing"))
          throw new DurableRecoveryRequiredError();
        for (const action of Object.values(draft.actions))
          if (action.state === "prepared" || action.state === "awaiting_approval") action.state = "canceled";
        draft.state = "canceled";
        delete draft.lease;
      },
      lease,
    );
  }
  async run(key: DurableTaskKey, workerId: string, execute: DurableTaskHandler): Promise<DurableTaskRecord> {
    const task = await this.claim(key, workerId);
    if (!task) {
      const current = await this.get(key);
      if (!current) throw new DurableConflictError("Task not found");
      return current;
    }
    if (isDurableTerminal(task.state)) return task;
    const lease = task.lease!;
    const controller = new AbortController();
    const actions = new DurableActionLedger(this.store, key, lease, controller.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polling: Promise<void> | undefined;
    let finished = false;
    let lostLease = false;
    const poll = async () => {
      try {
        const current = await this.renew(key, lease);
        if (current.state === "cancel_requested") controller.abort(new Error("Durable cancellation requested"));
      } catch (error) {
        lostLease = true;
        controller.abort(error);
      }
      if (!finished && !lostLease)
        timer = setTimeout(
          () => {
            polling = poll();
          },
          this.options.pollMs ?? Math.max(1, Math.floor(this.leaseMs / 3)),
        );
    };
    try {
      if (Object.values(task.actions).some((a) => a.state === "unknown")) throw new DurableRecoveryRequiredError();
      if (task.state === "cancel_requested") return await this.acknowledgeCancellation(key, lease);
      timer = setTimeout(
        () => {
          polling = poll();
        },
        this.options.pollMs ?? Math.max(1, Math.floor(this.leaseMs / 3)),
      );
      const result = await execute({
        task,
        lease,
        signal: controller.signal,
        actions,
        reserve: async (tokens, costMicros) => {
          durableInteger(tokens);
          durableInteger(costMicros);
          await this.store.update(
            key,
            (draft) => {
              if (draft.state !== "running") throw new DurableConflictError("Task is not running");
              draft.reservedTokens += tokens;
              draft.reservedCostMicros += costMicros;
            },
            lease,
          );
        },
      });
      await actions.quiesce();
      if (lostLease) throw new DurableLeaseError();
      const current = await this.get(key);
      if (current?.state === "cancel_requested") return await this.acknowledgeCancellation(key, lease);
      return await this.store.update(
        key,
        (draft) => {
          if (draft.state !== "running") throw new DurableConflictError("Task cannot complete from its current state");
          if (Object.values(draft.actions).some((a) => ["unknown", "executing", "awaiting_approval"].includes(a.state)))
            throw new DurableRecoveryRequiredError();
          draft.state = result?.state ?? "completed";
          if (result?.resultRef) {
            durableId(result.resultRef);
            draft.resultRef = result.resultRef;
          }
          delete draft.lease;
        },
        lease,
      );
    } catch (error) {
      controller.abort(error);
      await actions.quiesce();
      const current = await this.get(key);
      if (lostLease || !current?.lease || current.lease.fence !== lease.fence) throw error;
      if (current.state === "cancel_requested") {
        try {
          return await this.acknowledgeCancellation(key, lease);
        } catch {
          throw error;
        }
      }
      if (error instanceof AwaitingDurableApproval) {
        await this.release(key, lease);
        return (await this.get(key))!;
      }
      if (
        error instanceof DurableRecoveryRequiredError ||
        Object.values(current.actions).some((a) => a.state === "unknown" || a.state === "executing")
      )
        throw error;
      await this.store.update(
        key,
        (draft) => {
          if (draft.state !== "running") throw new DurableConflictError("Task cannot fail from current state");
          draft.state = "failed";
          draft.failure = error instanceof Error ? error.message : "Durable handler failed";
          delete draft.lease;
        },
        lease,
      );
      throw error;
    } finally {
      finished = true;
      clearTimeout(timer);
      await polling;
      await this.release(key, lease).catch(() => {});
    }
  }
}
class NotClaimable extends Error {}
