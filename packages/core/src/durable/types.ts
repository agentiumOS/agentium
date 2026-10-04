export type DurableJSON = null | boolean | number | string | DurableJSON[] | { [key: string]: DurableJSON };
export interface DurableTaskKey {
  tenantId: string;
  taskId: string;
}
export interface DurableIdentity {
  tenantId: string;
  actorId: string;
  sessionId: string;
  runId: string;
  rootRunId: string;
  parentRunId?: string;
}
export type DurableTaskState =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "cancel_requested"
  | "completed"
  | "failed"
  | "canceled"
  | "stopped";
export interface DurableLease {
  workerId: string;
  fence: number;
  expiresAt: number;
}
export interface DurableFence {
  workerId: string;
  fence: number;
}
export interface DurableTaskInput {
  id: string;
  identity: DurableIdentity;
  manifestHash: string;
  inputRef: string;
  policyRevision: number;
  grantRefs: string[];
  driver?: { id: string; version: number };
  input?: DurableJSON;
  budget?: { maxAttempts?: number; maxTokens?: number; maxCostMicros?: number };
  extensions?: Record<string, DurableJSON>;
}
export interface DurableAttempt {
  id: string;
  workerId: string;
  fence: number;
  startedAt: number;
}
export type DurableActionState =
  | "prepared"
  | "awaiting_approval"
  | "executing"
  | "confirmed"
  | "unknown"
  | "rejected"
  | "canceled";
export interface DurableAction {
  id: string;
  preparedHash: string;
  connectorVersion: string;
  destination: string;
  args: DurableJSON;
  policyRevision: number;
  grantRefs: string[];
  idempotencyKey: string;
  state: DurableActionState;
  approvalId?: string;
  dispatchFence?: number;
  resultRef?: string;
  evidenceRef?: string;
}
export interface DurableApproval {
  id: string;
  actionId: string;
  actorId: string;
  preparedHash: string;
  policyRevision: number;
  expiresAt: number;
  decision: "pending" | "approved" | "denied";
  consumed: boolean;
}
export interface DurableTaskRecord extends Omit<DurableTaskInput, "extensions" | "budget"> {
  schemaVersion: 1;
  state: DurableTaskState;
  revision: number;
  fence: number;
  createdAt: number;
  updatedAt: number;
  lease?: DurableLease;
  attempts: DurableAttempt[];
  budget: { maxAttempts: number; maxTokens: number; maxCostMicros: number };
  reservedTokens: number;
  reservedCostMicros: number;
  actions: Record<string, DurableAction>;
  approvals: Record<string, DurableApproval>;
  extensions: Record<string, DurableJSON>;
  resultRef?: string;
  failure?: string;
  cancelReason?: string;
}
/** Trusted host API. Tenant IDs must come from verified admission, never payload claims.
 * Updates are atomic within ONE bounded task aggregate; no cross-task transactions.
 */
export interface DurableTaskStore {
  readonly capabilities: {
    durable: boolean;
    atomicTaskUpdates: true;
    compareAndSet: true;
    fencing: true;
    durableOutbox: boolean;
  };
  create(input: DurableTaskInput): Promise<DurableTaskRecord>;
  get(key: DurableTaskKey): Promise<DurableTaskRecord | null>;
  /** Pure synchronous callback; CAS conflicts can cause re-evaluation. No network/effects here. */
  update(
    key: DurableTaskKey,
    mutate: (draft: DurableTaskRecord, now: number) => void,
    guard?: DurableFence,
  ): Promise<DurableTaskRecord>;
}
export class DurableConflictError extends Error {
  constructor(message = "Durable task conflict") {
    super(message);
    this.name = "DurableConflictError";
  }
}
export class DurableLeaseError extends DurableConflictError {
  constructor() {
    super("Durable lease expired or fenced out");
    this.name = "DurableLeaseError";
  }
}
export class DurableRecoveryRequiredError extends Error {
  constructor() {
    super("Durable action outcome is unknown; reconcile before resuming");
    this.name = "DurableRecoveryRequiredError";
  }
}
export class AwaitingDurableApproval extends Error {
  constructor(readonly approvalId: string) {
    super("Durable action awaits approval");
    this.name = "AwaitingDurableApproval";
  }
}
