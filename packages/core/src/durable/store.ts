import { createHash } from "node:crypto";
import {
  DurableConflictError,
  type DurableFence,
  DurableLeaseError,
  type DurableTaskInput,
  type DurableTaskKey,
  type DurableTaskRecord,
  type DurableTaskState,
  type DurableTaskStore,
} from "./types.js";

const transitions: Record<DurableTaskState, readonly DurableTaskState[]> = {
  queued: ["running", "cancel_requested", "failed", "stopped"],
  running: ["awaiting_approval", "cancel_requested", "completed", "failed", "stopped"],
  awaiting_approval: ["running", "cancel_requested", "failed", "stopped"],
  cancel_requested: ["canceled", "failed"],
  completed: [],
  failed: [],
  canceled: [],
  stopped: [],
};
export const isDurableTerminal = (state: DurableTaskState): boolean =>
  ["completed", "failed", "canceled", "stopped"].includes(state);
export function durableCanonical(value: unknown): string {
  function visit(item: unknown): unknown {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      const result: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(item).sort()) {
        if (["__proto__", "constructor", "prototype"].includes(key)) throw new TypeError("Unsafe durable record key");
        result[key] = visit((item as Record<string, unknown>)[key]);
      }
      return result;
    }
    throw new TypeError(
      "Durable records require finite JSON values; credentials and host services belong outside records",
    );
  }
  return JSON.stringify(visit(value));
}
export const durableDigest = (value: unknown): string =>
  `sha256:${createHash("sha256").update(durableCanonical(value)).digest("hex")}`;
export function durableId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 512 ||
    ["__proto__", "constructor", "prototype"].includes(value)
  )
    throw new TypeError("Invalid durable identifier");
}
export function durableInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Expected a nonnegative safe integer");
}
/** Stable admitted definition, excluding mutable extension/audit state. */
export function durableTaskDefinition(input: DurableTaskInput): DurableTaskInput {
  return {
    id: input.id,
    identity: structuredClone(input.identity),
    manifestHash: input.manifestHash,
    inputRef: input.inputRef,
    policyRevision: input.policyRevision,
    grantRefs: [...input.grantRefs],
    budget: {
      maxAttempts: input.budget?.maxAttempts ?? 3,
      maxTokens: input.budget?.maxTokens ?? 1_000_000,
      maxCostMicros: input.budget?.maxCostMicros ?? 100_000_000,
    },
    ...(input.driver ? { driver: structuredClone(input.driver) } : {}),
    ...(input.input !== undefined ? { input: structuredClone(input.input) } : {}),
  };
}
export const durableTaskDigest = (input: DurableTaskInput): string => durableDigest(durableTaskDefinition(input));
export function createDurableRecord(input: DurableTaskInput, now: number): DurableTaskRecord {
  durableCanonical(input);
  for (const value of [
    input.id,
    input.identity.tenantId,
    input.identity.actorId,
    input.identity.sessionId,
    input.identity.runId,
    input.identity.rootRunId,
    input.manifestHash,
    input.inputRef,
    ...input.grantRefs,
  ])
    durableId(value);
  if (input.identity.parentRunId !== undefined) durableId(input.identity.parentRunId);
  durableInteger(input.policyRevision);
  if (input.driver) {
    durableId(input.driver.id);
    durableInteger(input.driver.version);
  }
  const budget = {
    maxAttempts: input.budget?.maxAttempts ?? 3,
    maxTokens: input.budget?.maxTokens ?? 1_000_000,
    maxCostMicros: input.budget?.maxCostMicros ?? 100_000_000,
  };
  Object.values(budget).forEach(durableInteger);
  if (budget.maxAttempts < 1) throw new TypeError("maxAttempts must be positive");
  const record: DurableTaskRecord = {
    ...structuredClone(input),
    schemaVersion: 1,
    state: "queued",
    revision: 0,
    fence: 0,
    createdAt: now,
    updatedAt: now,
    budget,
    reservedTokens: 0,
    reservedCostMicros: 0,
    attempts: [],
    actions: {},
    approvals: {},
    extensions: structuredClone(input.extensions ?? {}),
  };
  return record;
}
export function assertDurableFence(record: DurableTaskRecord, guard: DurableFence, now: number): void {
  if (
    !record.lease ||
    record.lease.workerId !== guard.workerId ||
    record.lease.fence !== guard.fence ||
    record.lease.expiresAt <= now
  )
    throw new DurableLeaseError();
}
export function validateDurableUpdate(
  before: DurableTaskRecord,
  next: DurableTaskRecord,
  maxBytes: number,
  guard?: DurableFence,
): void {
  for (const key of [
    "id",
    "identity",
    "schemaVersion",
    "manifestHash",
    "inputRef",
    "input",
    "driver",
    "policyRevision",
    "grantRefs",
    "budget",
    "createdAt",
  ] as const) {
    if (durableCanonical(before[key] ?? null) !== durableCanonical(next[key] ?? null))
      throw new DurableConflictError(`Immutable task field: ${key}`);
  }
  if (next.revision !== before.revision || next.fence < before.fence)
    throw new DurableConflictError("Revision/fence cannot be rewritten");
  if (!Object.hasOwn(transitions, next.state)) throw new DurableConflictError("Invalid durable task state");
  if (next.state !== before.state && !transitions[before.state].includes(next.state))
    throw new DurableConflictError(`Invalid task transition: ${before.state} -> ${next.state}`);
  for (const field of ["reservedTokens", "reservedCostMicros", "fence"] as const) {
    durableInteger(next[field]);
    if (next[field] < before[field]) throw new DurableConflictError("Monotonic task counter decreased");
  }
  if (
    next.reservedTokens > next.budget.maxTokens ||
    next.reservedCostMicros > next.budget.maxCostMicros ||
    next.attempts.length > next.budget.maxAttempts
  )
    throw new DurableConflictError("Durable task budget exhausted");
  if (
    next.attempts.length < before.attempts.length ||
    durableCanonical(next.attempts.slice(0, before.attempts.length)) !== durableCanonical(before.attempts)
  )
    throw new DurableConflictError("Attempt audit cannot be rewritten");
  if (next.fence > before.fence && (next.fence !== before.fence + 1 || !next.lease || next.lease.fence !== next.fence))
    throw new DurableConflictError("Invalid lease fence increment");
  if (next.lease && (next.lease.fence !== next.fence || !Number.isSafeInteger(next.lease.expiresAt)))
    throw new DurableConflictError("Invalid durable lease");
  const actionTransitions: Record<string, readonly string[]> = {
    prepared: ["awaiting_approval", "executing", "canceled", "rejected"],
    awaiting_approval: ["executing", "rejected", "canceled"],
    executing: ["confirmed", "unknown", "canceled"],
    unknown: ["confirmed", "prepared", "canceled"],
    confirmed: [],
    rejected: [],
    canceled: [],
  };
  for (const [id, action] of Object.entries(next.actions)) {
    durableId(id);
    if (!Object.hasOwn(actionTransitions, action.state)) throw new DurableConflictError("Invalid action state");
    if (action.state === "executing" && before.actions[id]?.state !== "executing" && !guard)
      throw new DurableConflictError("Action dispatch requires a fenced update");
  }
  for (const [id, action] of Object.entries(before.actions)) {
    const updated = next.actions[id];
    if (!updated) throw new DurableConflictError("Action audit cannot be deleted");
    if (action.state !== updated.state && !actionTransitions[action.state].includes(updated.state))
      throw new DurableConflictError("Invalid action state transition");
    for (const key of [
      "id",
      "preparedHash",
      "connectorVersion",
      "destination",
      "args",
      "policyRevision",
      "grantRefs",
      "idempotencyKey",
    ] as const) {
      if (durableCanonical(action[key]) !== durableCanonical(updated[key]))
        throw new DurableConflictError("Prepared action cannot be changed");
    }
  }
  for (const [id, approval] of Object.entries(before.approvals)) {
    const updated = next.approvals[id];
    if (!updated) throw new DurableConflictError("Approval audit cannot be deleted");
    for (const key of ["id", "actionId", "actorId", "preparedHash", "policyRevision", "expiresAt"] as const)
      if (approval[key] !== updated[key]) throw new DurableConflictError("Approval binding cannot be changed");
    if (
      (approval.consumed && !updated.consumed) ||
      (approval.decision !== "pending" && approval.decision !== updated.decision)
    )
      throw new DurableConflictError("Approval is single use");
  }
  if (Buffer.byteLength(durableCanonical(next)) > maxBytes)
    throw new DurableConflictError("Durable task aggregate byte limit exceeded");
}
/** Local deterministic adapter. Never advertises process-crash durability. */
export class InMemoryDurableTaskStore implements DurableTaskStore {
  readonly capabilities = {
    durable: false,
    atomicTaskUpdates: true,
    compareAndSet: true,
    fencing: true,
    durableOutbox: false,
  } as const;
  private records = new Map<string, DurableTaskRecord>();
  constructor(private options: { now?: () => number; maxBytes?: number } = {}) {}
  private key(key: DurableTaskKey): string {
    return durableCanonical([key.tenantId, key.taskId]);
  }
  async create(input: DurableTaskInput): Promise<DurableTaskRecord> {
    const key = this.key({ tenantId: input.identity.tenantId, taskId: input.id });
    const record = createDurableRecord(input, this.options.now?.() ?? Date.now());
    if (this.records.has(key)) throw new DurableConflictError("Task already exists");
    validateDurableUpdate(record, record, this.options.maxBytes ?? 2_000_000);
    this.records.set(key, record);
    return structuredClone(record);
  }
  async get(key: DurableTaskKey): Promise<DurableTaskRecord | null> {
    return structuredClone(this.records.get(this.key(key)) ?? null);
  }
  async update(
    key: DurableTaskKey,
    mutate: (draft: DurableTaskRecord, now: number) => void,
    guard?: DurableFence,
  ): Promise<DurableTaskRecord> {
    const before = this.records.get(this.key(key));
    if (!before) throw new DurableConflictError("Task not found");
    const now = this.options.now?.() ?? Date.now();
    if (guard) assertDurableFence(before, guard, now);
    const next = structuredClone(before);
    const result: unknown = mutate(next, now);
    if (result && typeof (result as PromiseLike<unknown>).then === "function")
      throw new TypeError("Durable update callback must be synchronous");
    validateDurableUpdate(before, next, this.options.maxBytes ?? 2_000_000, guard);
    next.revision++;
    next.updatedAt = now;
    this.records.set(this.key(key), next);
    return structuredClone(next);
  }
}
