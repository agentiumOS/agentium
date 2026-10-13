import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type DurableActionConnector, type DurableActionInput, DurableActionLedger } from "../durable/actions.js";
import { durableCanonical, durableDigest, durableTaskDefinition } from "../durable/store.js";
import {
  AwaitingDurableApproval,
  DurableConflictError,
  type DurableFence,
  type DurableJSON,
  DurableLeaseError,
  DurableRecoveryRequiredError,
  type DurableTaskKey,
  type DurableTaskRecord,
  type DurableTaskStore,
} from "../durable/types.js";

export interface DurableGraphDefinition {
  id: string;
  version: string;
  catalogDigest: string;
  input: DurableJSON;
  limits: DurableJSON;
  deadline?: number;
}
export interface DurableGraphBinding {
  id: string;
  version: string;
  kind: string;
}
export interface DurableGraphNodeRecord {
  binding: DurableGraphBinding;
  status: "pending" | "prepared" | "running" | "completed" | "failed" | "cancelled" | "uncertain" | "superseded";
  input?: DurableJSON;
  inputDigest?: string;
  attempts: { id: string; workerId: string; fence: number; generation: number; startedAt: number }[];
  output?: DurableJSON;
  outputDigest?: string;
  error?: { name: string; message: string; code?: string };
  metadata: Record<string, DurableJSON>;
}
export interface DurableGraphState {
  schemaVersion: 1;
  definition: DurableGraphDefinition;
  definitionHash: string;
  plans: Record<string, DurableJSON>;
  nodes: Record<string, DurableGraphNodeRecord>;
  models: Record<string, DurableGraphNodeRecord>;
  decisions: Record<string, DurableJSON>;
  budget: DurableJSON;
  admission: DurableJSON;
  cancellation: { requested: boolean; reason?: string };
  evidence: DurableJSON[];
  metadata: Record<string, DurableJSON>;
}

const extensionKey = "agentium.graph.v1";
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identifier = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => {
    if (!value.trim() || ["__proto__", "constructor", "prototype"].includes(value)) return false;
    try {
      encodeURIComponent(value);
      return true;
    } catch {
      return false;
    }
  }, "Invalid durable graph identifier");
const jsonSchema: z.ZodType<DurableJSON> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonSchema),
    z.record(z.string(), jsonSchema),
  ]),
);
const bindingSchema = z.strictObject({ id: identifier, version: identifier, kind: identifier });
const definitionSchema = z.strictObject({
  id: identifier,
  version: identifier,
  catalogDigest: identifier,
  input: jsonSchema,
  limits: jsonSchema,
  deadline: integer.optional(),
});
const attemptSchema = z.strictObject({
  id: identifier,
  workerId: identifier,
  fence: integer,
  generation: integer,
  startedAt: integer,
});
const errorSchema = z.strictObject({ name: z.string(), message: z.string(), code: z.string().optional() });
const nodeSchema = z.strictObject({
  binding: bindingSchema,
  status: z.enum(["pending", "prepared", "running", "completed", "failed", "cancelled", "uncertain", "superseded"]),
  input: jsonSchema.optional(),
  inputDigest: identifier.optional(),
  attempts: z.array(attemptSchema),
  output: jsonSchema.optional(),
  outputDigest: identifier.optional(),
  error: errorSchema.optional(),
  metadata: z.record(z.string(), jsonSchema),
});
const stateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  definition: definitionSchema,
  definitionHash: identifier,
  plans: z.record(identifier, jsonSchema),
  nodes: z.record(identifier, nodeSchema),
  models: z.record(identifier, nodeSchema),
  decisions: z.record(identifier, jsonSchema),
  budget: jsonSchema,
  admission: jsonSchema,
  cancellation: z.strictObject({ requested: z.boolean(), reason: z.string().optional() }),
  evidence: z.array(jsonSchema),
  metadata: z.record(z.string(), jsonSchema),
});

export class DurableGraphJournalError extends DurableConflictError {
  readonly code = "durable_graph_invalid";
  constructor(message: string, options?: ErrorOptions) {
    super(message);
    this.name = "DurableGraphJournalError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}
export class DurableGraphNodeFailureError extends Error {
  readonly code = "durable_node_failed";
  constructor(
    readonly nodeId: string,
    readonly record: DurableGraphNodeRecord,
  ) {
    super(record.error?.message ?? `Durable node ${nodeId} is ${record.status}`);
    this.name = "DurableGraphNodeFailureError";
  }
}

function json(value: unknown): DurableJSON {
  try {
    return jsonSchema.parse(JSON.parse(durableCanonical(value)));
  } catch (cause) {
    throw new TypeError("Durable graph values require valid finite JSON", { cause });
  }
}
function parseState(value: unknown): DurableGraphState {
  try {
    const state = stateSchema.parse(JSON.parse(durableCanonical(value)));
    for (const [id, record] of [...Object.entries(state.nodes), ...Object.entries(state.models)]) {
      if ((record.input === undefined) !== (record.inputDigest === undefined))
        throw new Error(`Input binding is incomplete for ${id}`);
      if (record.input !== undefined && record.inputDigest !== durableDigest(record.input))
        throw new Error(`Input digest differs for ${id}`);
      if (record.attempts.length && record.inputDigest === undefined)
        throw new Error(`Attempt lacks input binding for ${id}`);
      if (record.status === "running" && !record.attempts.length) throw new Error(`Running node lacks owner for ${id}`);
      if (record.status === "completed" && (!Object.hasOwn(record, "output") || !record.attempts.length))
        throw new Error(`Completed node lacks durable output for ${id}`);
      if (record.status === "completed" && record.outputDigest !== durableDigest(record.output))
        throw new Error(`Completed output digest differs for ${id}`);
      if (record.status === "failed" && !record.error) throw new Error(`Failed node lacks failure for ${id}`);
      for (let index = 0; index < record.attempts.length; index++) {
        if (record.attempts[index].generation !== index + 1) throw new Error(`Attempt generation is corrupt for ${id}`);
      }
    }
    for (const [id, decision] of Object.entries(state.decisions)) {
      const recorded = state.models[`decision:${durableDigest(id)}`];
      if (recorded?.status !== "completed" || !same(recorded.output, decision))
        throw new Error(`Durable decision is not backed by its completed record for ${id}`);
    }
    return state;
  } catch (cause) {
    throw new DurableGraphJournalError("Invalid or corrupt durable graph journal", { cause });
  }
}
function same(a: unknown, b: unknown): boolean {
  return durableCanonical(a) === durableCanonical(b);
}
function errorRecord(error: unknown): { name: string; message: string; code?: string } {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    ...(code ? { code } : {}),
  };
}
function control(error: unknown): boolean {
  const record = errorRecord(error);
  return (
    error instanceof DurableConflictError ||
    error instanceof DurableRecoveryRequiredError ||
    error instanceof AwaitingDurableApproval ||
    record.name === "AbortError" ||
    record.code === "budget_exhausted" ||
    record.code === "workflow_cancelled" ||
    record.code?.startsWith("execution_") === true ||
    record.code?.startsWith("root_") === true
  );
}
function validateMutation(before: DurableGraphState, after: DurableGraphState): void {
  if (!same(before.definition, after.definition) || before.definitionHash !== after.definitionHash)
    throw new DurableGraphJournalError("Durable graph definition is immutable");
  if (before.cancellation.requested && !after.cancellation.requested)
    throw new DurableGraphJournalError("Durable cancellation cannot be cleared");
  if (!same(before.evidence, after.evidence.slice(0, before.evidence.length)))
    throw new DurableGraphJournalError("Durable effect evidence audit cannot be rewritten");
  for (const [id, decision] of Object.entries(before.decisions)) {
    if (!Object.hasOwn(after.decisions, id) || !same(decision, after.decisions[id]))
      throw new DurableGraphJournalError("Durable decisions are immutable");
  }
  for (const [id, plan] of Object.entries(before.plans)) {
    if (!Object.hasOwn(after.plans, id) || !same(plan, after.plans[id]))
      throw new DurableGraphJournalError("Committed durable plan revisions are immutable audit records");
  }
  for (const category of ["nodes", "models"] as const) {
    for (const [id, previous] of Object.entries(before[category])) {
      const next = after[category][id];
      if (!next) throw new DurableGraphJournalError("Durable node audit cannot be deleted");
      if (!same(previous.attempts, next.attempts.slice(0, previous.attempts.length)))
        throw new DurableGraphJournalError("Durable attempt audit cannot be rewritten");
      if (
        (previous.attempts.length || previous.status === "prepared") &&
        (!same(previous.binding, next.binding) || !same(previous.input ?? null, next.input ?? null))
      )
        throw new DurableGraphJournalError("Attempted durable node binding and input are immutable");
      if (["completed", "failed", "cancelled", "superseded"].includes(previous.status) && !same(previous, next))
        throw new DurableGraphJournalError("Terminal durable node evidence is immutable");
      if (previous.status === "running" && ["pending", "prepared", "superseded"].includes(next.status))
        throw new DurableGraphJournalError("Running durable work cannot be invalidated by topology changes");
    }
  }
}

/** Authoritative fenced state in one existing durable task aggregate. The caller
 * must bind replay-safe executables; the journal never makes opaque callbacks safe. */
export class DurableGraphJournal {
  readonly definition: DurableGraphDefinition;
  constructor(
    readonly store: DurableTaskStore,
    readonly key: DurableTaskKey,
    readonly fence: DurableFence,
    definition: DurableGraphDefinition,
  ) {
    this.definition = definitionSchema.parse(JSON.parse(durableCanonical(definition)));
    identifier.parse(key.tenantId);
    identifier.parse(key.taskId);
    identifier.parse(fence.workerId);
    integer.parse(fence.fence);
    if (!store.capabilities.atomicTaskUpdates || !store.capabilities.compareAndSet || !store.capabilities.fencing)
      throw new DurableGraphJournalError("Durable graph journal requires atomic CAS and fencing");
  }

  private read(task: DurableTaskRecord): DurableGraphState {
    const expected = durableDigest({ definition: this.definition, task: durableTaskDefinition(task) });
    const existing = task.extensions[extensionKey];
    const state =
      existing === undefined
        ? {
            schemaVersion: 1 as const,
            definition: structuredClone(this.definition),
            definitionHash: expected,
            plans: {},
            nodes: {},
            models: {},
            decisions: {},
            budget: null,
            admission: null,
            cancellation: { requested: false },
            evidence: [],
            metadata: {},
          }
        : parseState(existing);
    if (state.definitionHash !== expected || !same(state.definition, this.definition))
      throw new DurableGraphJournalError("Durable graph definition, inputs or host binding mismatch");
    return state;
  }

  private async update(
    operation: (state: DurableGraphState, task: DurableTaskRecord, now: number) => void,
  ): Promise<DurableGraphState> {
    const task = await this.store.update(
      this.key,
      (draft, now) => {
        const before = this.read(draft);
        const next = structuredClone(before);
        if (draft.state === "cancel_requested")
          next.cancellation = { requested: true, ...(draft.cancelReason ? { reason: draft.cancelReason } : {}) };
        const outcome: unknown = operation(next, draft, now);
        if (outcome && typeof (outcome as PromiseLike<unknown>).then === "function")
          throw new DurableGraphJournalError("Durable graph mutations must be synchronous");
        const validated = parseState(next);
        validateMutation(before, validated);
        draft.extensions[extensionKey] = json(validated);
      },
      this.fence,
    );
    return this.read(task);
  }

  initialize(): Promise<DurableGraphState> {
    return this.update(() => {});
  }
  /** Validated inspection never claims ownership or mutates a task. All work
   * admissions and settlements still require the current fenced update path. */
  async snapshot(): Promise<DurableGraphState> {
    const task = await this.store.get(this.key);
    if (!task) throw new DurableGraphJournalError("Durable graph task does not exist");
    return this.read(task);
  }
  mutate(update: (state: DurableGraphState, now: number) => void): Promise<DurableGraphState> {
    return this.update((state, _task, now) => update(state, now));
  }
  private admit(state: DurableGraphState, task: DurableTaskRecord, now: number): void {
    if (state.cancellation.requested || task.state === "cancel_requested")
      throw new DurableGraphJournalError("Durable graph cancellation requested");
    if (task.state !== "running") throw new DurableGraphJournalError("Durable graph task is not running");
    if (this.definition.deadline !== undefined && now >= this.definition.deadline)
      throw new DurableGraphJournalError("Original durable graph deadline exceeded");
  }

  node(
    id: string,
    binding: DurableGraphBinding,
    input: DurableJSON,
    execute: () => Promise<DurableJSON>,
  ): Promise<DurableJSON> {
    return this.operation("nodes", id, bindingSchema.parse(binding), input, execute);
  }
  model(id: string, request: DurableJSON, execute: () => Promise<DurableJSON>): Promise<DurableJSON> {
    return this.operation("models", id, { id: "model", version: "1", kind: "model" }, request, execute);
  }
  private async operation(
    category: "nodes" | "models",
    id: string,
    binding: DurableGraphBinding,
    input: DurableJSON,
    execute: () => Promise<DurableJSON>,
  ): Promise<DurableJSON> {
    identifier.parse(id);
    const admittedInput = json(input);
    const digest = durableDigest(admittedInput);
    const attemptId = randomUUID();
    const started = await this.update((state, task, now) => {
      const previous = state[category][id];
      if (
        previous &&
        (!same(previous.binding, binding) || (previous.inputDigest !== undefined && previous.inputDigest !== digest))
      )
        throw new DurableGraphJournalError("Durable node binding or input/request mismatch");
      if (previous?.status === "completed") return;
      this.admit(state, task, now);
      if (previous && ["failed", "cancelled", "superseded"].includes(previous.status))
        throw new DurableGraphNodeFailureError(id, previous);
      if (previous?.status === "running" && previous.attempts.at(-1)?.fence === this.fence.fence)
        throw new DurableGraphJournalError("Durable node already running under this active owner");
      if (
        previous?.status === "uncertain" &&
        Object.values(task.actions).some((action) => ["unknown", "executing"].includes(action.state))
      )
        throw new DurableRecoveryRequiredError();
      if (
        category === "models" &&
        previous?.status === "uncertain" &&
        previous.attempts.at(-1)?.fence === this.fence.fence
      )
        throw new DurableGraphJournalError(
          "Uncertain model work requires a new recovery owner or a new bounded operation",
        );
      const attempts = previous?.attempts ?? [];
      state[category][id] = {
        binding,
        status: "running",
        input: admittedInput,
        inputDigest: digest,
        attempts: [
          ...attempts,
          {
            id: attemptId,
            workerId: this.fence.workerId,
            fence: this.fence.fence,
            generation: attempts.length + 1,
            startedAt: now,
          },
        ],
        metadata: previous?.metadata ?? {},
      };
    });
    const record = started[category][id];
    if (record.status === "completed") return json(record.output);
    const settle = (state: DurableGraphState): DurableGraphNodeRecord => {
      const current = state[category][id];
      if (current?.status !== "running" || current.attempts.at(-1)?.id !== attemptId)
        throw new DurableGraphJournalError("Durable node attempt was superseded before settlement");
      return current;
    };
    try {
      const output = json(await execute());
      await this.update((state) => {
        const current = settle(state);
        current.output = output;
        current.outputDigest = durableDigest(output);
        current.status = "completed";
        delete current.error;
      });
      return json(output);
    } catch (error) {
      if (error instanceof DurableLeaseError) throw error;
      if (
        !control(error) ||
        error instanceof DurableRecoveryRequiredError ||
        errorRecord(error).name === "AbortError"
      ) {
        await this.update((state) => {
          const current = settle(state);
          current.status =
            error instanceof DurableRecoveryRequiredError || category === "models"
              ? "uncertain"
              : errorRecord(error).name === "AbortError"
                ? "cancelled"
                : "failed";
          current.error = errorRecord(error);
        });
      }
      throw error;
    }
  }

  async decision(id: string, compute: () => Promise<DurableJSON> | DurableJSON): Promise<DurableJSON> {
    identifier.parse(id);
    const existing = await this.snapshot();
    if (Object.hasOwn(existing.decisions, id)) return json(existing.decisions[id]);
    const output = await this.operation(
      "models",
      `decision:${durableDigest(id)}`,
      { id: "decision", version: "1", kind: "decision" },
      null,
      async () => json(await compute()),
    );
    await this.mutate((state) => {
      if (Object.hasOwn(state.decisions, id) && !same(state.decisions[id], output))
        throw new DurableGraphJournalError("Durable decision changed during commit");
      state.decisions[id] = output;
    });
    return json(output);
  }

  async effect(
    input: DurableActionInput,
    connector: DurableActionConnector,
    resolveResult: (ref: string) => Promise<DurableJSON>,
    signal?: AbortSignal,
  ): Promise<DurableJSON> {
    await this.update((state, task, now) => this.admit(state, task, now));
    const ledger = new DurableActionLedger(this.store, this.key, this.fence, signal);
    const prepared = await ledger.prepare(input);
    try {
      if (["executing", "unknown"].includes(prepared.state)) await ledger.reconcile(input.id, connector);
      const receipt = await ledger.execute(input, connector);
      const retained = (await this.snapshot()).evidence.find(
        (item) =>
          item !== null &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          item.type === "effect.receipt" &&
          item.effectId === input.id &&
          item.preparedHash === prepared.preparedHash,
      );
      if (
        retained !== null &&
        typeof retained === "object" &&
        !Array.isArray(retained) &&
        Object.hasOwn(retained, "output")
      ) {
        if (retained.resultRef !== receipt.resultRef || retained.outputDigest !== durableDigest(retained.output))
          throw new DurableGraphJournalError("Retained durable effect output digest differs");
        return json(retained.output);
      }
      const output = json(await resolveResult(receipt.resultRef));
      await this.mutate((state) => {
        const evidence = {
          type: "effect.receipt",
          effectId: input.id,
          resultRef: receipt.resultRef,
          preparedHash: prepared.preparedHash,
          inputDigest: durableDigest(input.args),
          outputDigest: durableDigest(output),
          output,
        };
        if (!state.evidence.some((previous) => same(previous, evidence))) state.evidence.push(evidence);
      });
      return output;
    } catch (error) {
      if (error instanceof DurableLeaseError) throw error;
      const current = (await this.store.get(this.key))?.actions[input.id];
      if (current && ["unknown", "executing"].includes(current.state)) {
        await this.mutate((state) => {
          state.evidence.push({
            type: "effect.unresolved",
            effectId: input.id,
            preparedHash: prepared.preparedHash,
            error: errorRecord(error),
          });
        });
        if (error instanceof DurableRecoveryRequiredError) throw error;
        const unresolved = new DurableRecoveryRequiredError();
        unresolved.cause = error;
        throw unresolved;
      }
      throw error;
    }
  }
}
