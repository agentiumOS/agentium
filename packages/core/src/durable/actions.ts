import { randomUUID } from "node:crypto";
import { durableDigest, durableId, isDurableTerminal } from "./store.js";
import {
  AwaitingDurableApproval,
  type DurableAction,
  DurableConflictError,
  type DurableFence,
  type DurableJSON,
  DurableRecoveryRequiredError,
  type DurableTaskKey,
  type DurableTaskStore,
} from "./types.js";

export interface DurableActionInput {
  id: string;
  connectorVersion: string;
  destination: string;
  args: DurableJSON;
  approval?: { actorId: string; expiresAt: number };
}
export interface DurableActionConnector {
  /** Scoped host binding, including action implementation version. */
  version: string;
  dispatch(action: Readonly<DurableAction>, signal?: AbortSignal): Promise<{ resultRef: string }>;
  /** 'absent' must prove no effect can still occur; a transient 404 is insufficient. */
  reconcile?(
    action: Readonly<DurableAction>,
  ): Promise<
    | { outcome: "confirmed"; resultRef: string; evidenceRef: string }
    | { outcome: "absent" | "unknown"; evidenceRef: string }
  >;
}
/** Every dispatch is preceded by an atomic persisted intent. Not exactly-once execution. */
export class DurableActionLedger {
  private pending = new Set<Promise<unknown>>();
  async quiesce(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
  execute(input: DurableActionInput, connector: DurableActionConnector): Promise<{ resultRef: string }> {
    const promise = this.executeOwned(input, connector);
    this.pending.add(promise);
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }
  constructor(
    readonly store: DurableTaskStore,
    readonly key: DurableTaskKey,
    readonly fence: DurableFence,
    readonly signal?: AbortSignal,
  ) {}
  async prepare(input: DurableActionInput): Promise<DurableAction> {
    for (const value of [input.id, input.connectorVersion, input.destination]) durableId(value);
    const approvalId = randomUUID();
    const task = await this.store.update(
      this.key,
      (draft, now) => {
        if (draft.state !== "running") throw new DurableConflictError("Task is not running");
        const binding = {
          connectorVersion: input.connectorVersion,
          destination: input.destination,
          args: input.args,
          policyRevision: draft.policyRevision,
          grantRefs: draft.grantRefs,
          identity: draft.identity,
        };
        const preparedHash = durableDigest(binding);
        const existing = draft.actions[input.id];
        if (existing) {
          if (existing.preparedHash !== preparedHash)
            throw new DurableConflictError("Action ID reused with different prepared arguments");
          return;
        }
        const action: DurableAction = {
          id: input.id,
          ...binding,
          preparedHash,
          idempotencyKey: durableDigest([draft.identity.tenantId, draft.id, input.id, preparedHash]),
          state: "prepared",
        };
        if (input.approval) {
          durableId(input.approval.actorId);
          if (!Number.isSafeInteger(input.approval.expiresAt) || input.approval.expiresAt <= now)
            throw new DurableConflictError("Approval already expired");
          action.state = "awaiting_approval";
          action.approvalId = approvalId;
          draft.approvals[approvalId] = {
            id: approvalId,
            actionId: input.id,
            actorId: input.approval.actorId,
            preparedHash,
            policyRevision: draft.policyRevision,
            expiresAt: input.approval.expiresAt,
            decision: "pending",
            consumed: false,
          };
        }
        draft.actions[input.id] = action;
      },
      this.fence,
    );
    return task.actions[input.id];
  }
  private async executeOwned(
    input: DurableActionInput,
    connector: DurableActionConnector,
  ): Promise<{ resultRef: string }> {
    this.signal?.throwIfAborted();
    let action = await this.prepare(input);
    if (connector.version !== action.connectorVersion)
      throw new DurableConflictError("Connector version differs from prepared action");
    if (action.state === "confirmed") return { resultRef: action.resultRef! };
    if (action.state === "unknown" || action.state === "executing") throw new DurableRecoveryRequiredError();
    let waiting: string | undefined;
    let rejected = false;
    const started = await this.store.update(
      this.key,
      (draft, now) => {
        waiting = undefined;
        rejected = false;
        if (draft.state !== "running") throw new DurableConflictError("Task is not running");
        const current = draft.actions[input.id];
        if (!["prepared", "awaiting_approval"].includes(current.state))
          throw new DurableConflictError("Action cannot dispatch");
        if (current.approvalId) {
          const approval = draft.approvals[current.approvalId];
          if (
            approval.decision === "denied" ||
            approval.expiresAt <= now ||
            approval.consumed ||
            approval.preparedHash !== current.preparedHash ||
            approval.policyRevision !== draft.policyRevision
          ) {
            current.state = "rejected";
            rejected = true;
            return;
          }
          if (approval.decision === "pending") {
            draft.state = "awaiting_approval";
            waiting = approval.id;
            return;
          }
          approval.consumed = true;
        }
        current.state = "executing";
        current.dispatchFence = this.fence.fence;
      },
      this.fence,
    );
    if (waiting) throw new AwaitingDurableApproval(waiting);
    if (rejected) throw new DurableConflictError("Approval rejected, expired or already consumed");
    action = started.actions[input.id];
    let dispatched = false;
    try {
      this.signal?.throwIfAborted();
      dispatched = true;
      const result = await connector.dispatch(structuredClone(action), this.signal);
      durableId(result.resultRef);
      await this.store.update(
        this.key,
        (draft) => {
          const current = draft.actions[input.id];
          if (current.state !== "executing") throw new DurableConflictError("Action is no longer executing");
          current.state = "confirmed";
          current.resultRef = result.resultRef;
        },
        this.fence,
      );
      return result;
    } catch (error) {
      // Dispatch errors cannot prove the remote side performed no effect.
      await this.store
        .update(
          this.key,
          (draft) => {
            const current = draft.actions[input.id];
            if (current.state === "executing") {
              current.state = dispatched ? "unknown" : "canceled";
              if (!dispatched) current.evidenceRef = "local:cancelled-before-dispatch";
            }
          },
          this.fence,
        )
        .catch(() => {});
      throw error;
    }
  }
  async reconcile(actionId: string, connector: DurableActionConnector): Promise<DurableAction> {
    const task = await this.store.get(this.key);
    const action = task?.actions[actionId];
    if (!action || !["unknown", "executing"].includes(action.state))
      throw new DurableConflictError("Action does not need reconciliation");
    if (connector.version !== action.connectorVersion || !connector.reconcile) throw new DurableRecoveryRequiredError();
    const evidence = await connector.reconcile(structuredClone(action));
    durableId(evidence.evidenceRef);
    const updated = await this.store.update(
      this.key,
      (draft) => {
        const current = draft.actions[actionId];
        if (current.preparedHash !== action.preparedHash || !["unknown", "executing"].includes(current.state))
          throw new DurableConflictError("Action changed during reconciliation");
        current.evidenceRef = evidence.evidenceRef;
        if (evidence.outcome === "confirmed") {
          durableId(evidence.resultRef);
          current.state = "confirmed";
          current.resultRef = evidence.resultRef;
        } else if (evidence.outcome === "absent")
          current.state = draft.state === "cancel_requested" ? "canceled" : "prepared";
        else current.state = "unknown";
      },
      this.fence,
    );
    return updated.actions[actionId];
  }
  /** Trusted host approval endpoint must authenticate/authorize the supplied actor. */
  static async decide(
    store: DurableTaskStore,
    key: DurableTaskKey,
    input: { approvalId: string; actorId: string; preparedHash: string; approved: boolean },
  ): Promise<void> {
    if (typeof input.approved !== "boolean") throw new DurableConflictError("Approval decision must be boolean");
    await store.update(key, (draft, now) => {
      if (isDurableTerminal(draft.state) || draft.state === "cancel_requested")
        throw new DurableConflictError("Task is no longer approvable");
      const approval = draft.approvals[input.approvalId];
      if (
        !approval ||
        approval.actorId !== input.actorId ||
        approval.preparedHash !== input.preparedHash ||
        approval.expiresAt <= now ||
        approval.decision !== "pending" ||
        approval.consumed
      )
        throw new DurableConflictError("Approval binding invalid or already decided");
      approval.decision = input.approved ? "approved" : "denied";
    });
  }
}
