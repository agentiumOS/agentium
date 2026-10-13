import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ModelProvider } from "../models/provider.js";
import type { StreamChunk } from "../models/types.js";

/** Root ceilings supplement local graph/Agent limits and model/tool/token budgets. */
export interface RootExecutionLimits {
  maxConcurrentWork?: number;
  maxExpandedNodes?: number;
  maxWorkAttempts?: number;
  maxPlanRevisions?: number;
}
export type RootExecutionKind = "model" | "tool" | "function";
/** Persisted lifetime counters. Active slots represent SDK dispatch ownership,
 * not proof that a fenced worker's remote operation has stopped. */
export interface RootExecutionCounts {
  schemaVersion: 1;
  limits: RootExecutionLimits;
  deadline?: number;
  expandedIds: string[];
  revisionIds: string[];
  workAttempts: number;
}
export interface RootExecutionPersistence {
  /** Atomic fenced update; the pure synchronous callback may be reevaluated by CAS.
   * Absence initializes the root; a restored root must have the same ceilings/deadline. */
  update(mutate: (current: RootExecutionCounts | undefined) => RootExecutionCounts): Promise<RootExecutionCounts>;
}
export interface RootExecutionSnapshot {
  active: number;
  queued: number;
  highWater: number;
  expandedNodes: number;
  workAttempts: number;
  planRevisions: number;
}
export interface RootExecutionEvent {
  type: "queued" | "admitted" | "released" | "cancelled" | "rejected" | "exhausted" | "expanded" | "revision";
  kind?: RootExecutionKind;
  id?: string;
  attemptId?: string;
  code?: string;
  snapshot: RootExecutionSnapshot;
}
export interface RootExecutionLease {
  attemptId: string;
  /** Run leaf code under nested-dispatch detection; cancellation blocks new callbacks. */
  run<T>(execute: () => Promise<T>): Promise<T>;
  /** Finalize already-owned work after cancellation without admitting or charging work. */
  cleanup<T>(execute: () => Promise<T>): Promise<T>;
  /** Idempotent; called only after the owned operation has actually settled. */
  release(): Promise<void>;
}
export class RootExecutionError extends Error {
  constructor(
    readonly code:
      | "root_expansion_limit"
      | "root_attempt_limit"
      | "root_revision_limit"
      | "root_nested_leaf"
      | "root_cancelled"
      | "root_deadline"
      | "root_state_invalid",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RootExecutionError";
  }
}

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const limitsSchema = z
  .object({
    maxConcurrentWork: safeInteger.positive().optional(),
    maxExpandedNodes: safeInteger.optional(),
    maxWorkAttempts: safeInteger.optional(),
    maxPlanRevisions: safeInteger.optional(),
  })
  .strict();
const identity = z
  .string()
  .min(1)
  .refine((value) => {
    if (value.trim().length === 0) return false;
    try {
      encodeURIComponent(value);
      return true;
    } catch {
      return false;
    }
  });
const countsSchema = z
  .object({
    schemaVersion: z.literal(1),
    limits: limitsSchema,
    deadline: safeInteger.optional(),
    expandedIds: z.array(identity),
    revisionIds: z.array(identity),
    workAttempts: safeInteger,
  })
  .strict();
const leafScope = new AsyncLocalStorage<RootExecutionController>();
function limitsKey(limits: RootExecutionLimits): string {
  return JSON.stringify([
    limits.maxConcurrentWork ?? null,
    limits.maxExpandedNodes ?? null,
    limits.maxWorkAttempts ?? null,
    limits.maxPlanRevisions ?? null,
  ]);
}
/** Validate untrusted/restored accounting before any resumed admission. */
export function validateRootExecutionCounts(value: unknown): RootExecutionCounts {
  const parsed = countsSchema.safeParse(value);
  if (!parsed.success)
    throw new RootExecutionError("root_state_invalid", "Invalid root execution accounting", { cause: parsed.error });
  const counts = parsed.data;
  if (
    new Set(counts.expandedIds).size !== counts.expandedIds.length ||
    new Set(counts.revisionIds).size !== counts.revisionIds.length ||
    counts.expandedIds.length > (counts.limits.maxExpandedNodes ?? Infinity) ||
    counts.revisionIds.length > (counts.limits.maxPlanRevisions ?? Infinity) ||
    counts.workAttempts > (counts.limits.maxWorkAttempts ?? Infinity)
  )
    throw new RootExecutionError(
      "root_state_invalid",
      "Root execution accounting exceeds its limits or duplicates identities",
    );
  return counts;
}
interface Waiter {
  kind: RootExecutionKind;
  id: string;
  signal?: AbortSignal;
  resolve: (lease: RootExecutionLease) => void;
  reject: (error: unknown) => void;
  abort: () => void;
}
/** FIFO root admission. Structural nodes and Agent orchestration hold no permits. */
export class RootExecutionController {
  readonly limits: RootExecutionLimits;
  readonly deadline?: number;
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly persistence?: RootExecutionPersistence;
  private readonly onEvent?: (event: RootExecutionEvent) => void;
  private counts: RootExecutionCounts;
  private mutations: Promise<void> = Promise.resolve();
  private queue: Waiter[] = [];
  private active = 0;
  private highWater = 0;
  constructor(
    limits: RootExecutionLimits = {},
    options: {
      signal?: AbortSignal;
      deadline?: number;
      persistence?: RootExecutionPersistence;
      onEvent?: (event: RootExecutionEvent) => void;
    } = {},
  ) {
    this.limits = Object.freeze(limitsSchema.parse(limits));
    if (options.deadline !== undefined) safeInteger.parse(options.deadline);
    this.deadline = options.deadline;
    this.persistence = options.persistence;
    this.onEvent = options.onEvent;
    this.signal = this.controller.signal;
    this.counts = {
      schemaVersion: 1,
      limits: { ...this.limits },
      ...(this.deadline !== undefined ? { deadline: this.deadline } : {}),
      expandedIds: [],
      revisionIds: [],
      workAttempts: 0,
    };
    this.signal.addEventListener("abort", () => this.cancelWaiters(), { once: true });
    if (options.signal) {
      const abort = () =>
        this.controller.abort(
          new RootExecutionError("root_cancelled", "Root execution cancelled", { cause: options.signal?.reason }),
        );
      if (options.signal.aborted) abort();
      else options.signal.addEventListener("abort", abort, { once: true });
    }
    if (this.deadline !== undefined) {
      const schedule = () => {
        if (this.signal.aborted) return;
        const remaining = (this.deadline ?? 0) - Date.now();
        if (remaining <= 0)
          this.controller.abort(new RootExecutionError("root_deadline", "Root execution deadline exceeded"));
        else {
          const timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
          timer.unref?.();
          this.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
        }
      };
      schedule();
    }
  }
  snapshot(): RootExecutionSnapshot {
    return {
      active: this.active,
      queued: this.queue.length,
      highWater: this.highWater,
      expandedNodes: this.counts.expandedIds.length,
      workAttempts: this.counts.workAttempts,
      planRevisions: this.counts.revisionIds.length,
    };
  }
  private emit(event: Omit<RootExecutionEvent, "snapshot">): void {
    try {
      this.onEvent?.({ ...event, snapshot: this.snapshot() });
    } catch {
      /* Observation cannot revoke or leak an admitted permit. */
    }
  }
  private ensureActive(signal?: AbortSignal): void {
    if (this.deadline !== undefined && Date.now() >= this.deadline && !this.signal.aborted)
      this.controller.abort(new RootExecutionError("root_deadline", "Root execution deadline exceeded"));
    if (this.signal.aborted) throw this.signal.reason;
    if (signal?.aborted)
      throw new RootExecutionError("root_cancelled", "Root operation cancelled", { cause: signal.reason });
  }
  private validateBinding(counts: RootExecutionCounts): void {
    if (limitsKey(counts.limits) !== limitsKey(this.limits) || counts.deadline !== this.deadline)
      throw new RootExecutionError(
        "root_state_invalid",
        "Recovered root limits or deadline differ from the admitted root",
      );
    const expanded = new Set(counts.expandedIds);
    const revisions = new Set(counts.revisionIds);
    if (
      counts.workAttempts < this.counts.workAttempts ||
      this.counts.expandedIds.some((id) => !expanded.has(id)) ||
      this.counts.revisionIds.some((id) => !revisions.has(id))
    )
      throw new RootExecutionError("root_state_invalid", "Root lifetime accounting cannot decrease");
  }
  private mutate(change: (counts: RootExecutionCounts) => void): Promise<void> {
    const operation = this.mutations.then(async () => {
      let expected: RootExecutionCounts | undefined;
      const apply = (current: RootExecutionCounts | undefined): RootExecutionCounts => {
        const next = validateRootExecutionCounts(current ?? this.counts);
        this.validateBinding(next);
        change(next);
        expected = validateRootExecutionCounts(next);
        return structuredClone(expected);
      };
      const committed = validateRootExecutionCounts(
        this.persistence ? await this.persistence.update(apply) : apply(this.counts),
      );
      this.validateBinding(committed);
      if (!expected || JSON.stringify(committed) !== JSON.stringify(expected))
        throw new RootExecutionError("root_state_invalid", "Persistence did not commit the requested root accounting");
      this.counts = committed;
    });
    this.mutations = operation.catch(() => {});
    return operation;
  }
  async expand(ids: readonly string[]): Promise<void> {
    this.ensureActive();
    const validated = z.array(identity).parse(ids);
    await this.mutate((counts) => {
      this.ensureActive();
      const additions = [...new Set(validated)].filter((id) => !counts.expandedIds.includes(id));
      if (counts.expandedIds.length + additions.length > (this.limits.maxExpandedNodes ?? Infinity))
        throw new RootExecutionError("root_expansion_limit", "Root node expansion allowance exhausted");
      counts.expandedIds.push(...additions);
    }).catch((error: unknown) => {
      this.emit({ type: "exhausted", code: error instanceof RootExecutionError ? error.code : undefined });
      throw error;
    });
    this.emit({ type: "expanded" });
  }
  async revision(id: string): Promise<void> {
    this.ensureActive();
    identity.parse(id);
    await this.mutate((counts) => {
      this.ensureActive();
      if (counts.revisionIds.includes(id)) return;
      if (counts.revisionIds.length >= (this.limits.maxPlanRevisions ?? Infinity))
        throw new RootExecutionError("root_revision_limit", "Root plan revision allowance exhausted");
      counts.revisionIds.push(id);
    }).catch((error: unknown) => {
      this.emit({ type: "exhausted", id, code: error instanceof RootExecutionError ? error.code : undefined });
      throw error;
    });
    this.emit({ type: "revision", id });
  }
  async acquire(kind: RootExecutionKind, id: string, signal?: AbortSignal): Promise<RootExecutionLease> {
    this.ensureActive(signal);
    identity.parse(id);
    if (!["model", "tool", "function"].includes(kind))
      throw new RootExecutionError("root_state_invalid", "Invalid leaf operation kind");
    if (leafScope.getStore()) {
      this.emit({ type: "rejected", kind, id, code: "root_nested_leaf" });
      throw new RootExecutionError(
        "root_nested_leaf",
        "A controlled leaf cannot initiate nested controlled work; use graph/Agent orchestration",
      );
    }
    return new Promise<RootExecutionLease>((resolve, reject) => {
      const waiter: Waiter = {
        kind,
        id,
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.queue.indexOf(waiter);
          if (index < 0) return;
          this.queue.splice(index, 1);
          signal?.removeEventListener("abort", waiter.abort);
          this.emit({ type: "cancelled", kind, id, code: "root_cancelled" });
          reject(
            new RootExecutionError("root_cancelled", "Queued root operation cancelled", { cause: signal?.reason }),
          );
        },
      };
      this.queue.push(waiter);
      signal?.addEventListener("abort", waiter.abort, { once: true });
      this.emit({ type: "queued", kind, id });
      this.pump();
    });
  }
  private cancelWaiters(): void {
    const queued = this.queue.splice(0);
    for (const waiter of queued) {
      waiter.signal?.removeEventListener("abort", waiter.abort);
      this.emit({
        type: "cancelled",
        kind: waiter.kind,
        id: waiter.id,
        code: this.signal.reason instanceof RootExecutionError ? this.signal.reason.code : "root_cancelled",
      });
      waiter.reject(this.signal.reason);
    }
  }
  private pump(): void {
    while (!this.signal.aborted && this.queue.length && this.active < (this.limits.maxConcurrentWork ?? Infinity)) {
      const waiter = this.queue.shift();
      if (!waiter) return;
      waiter.signal?.removeEventListener("abort", waiter.abort);
      this.active++;
      this.highWater = Math.max(this.highWater, this.active);
      const attemptId = randomUUID();
      void this.mutate((counts) => {
        this.ensureActive(waiter.signal);
        if (counts.workAttempts >= (this.limits.maxWorkAttempts ?? Infinity))
          throw new RootExecutionError("root_attempt_limit", "Root work attempt allowance exhausted");
        counts.workAttempts++;
      })
        .then(() => {
          this.ensureActive(waiter.signal);
          let released = false;
          let running = false;
          const executeOwned = async <T>(execute: () => Promise<T>, requireActive: boolean): Promise<T> => {
            if (released) throw new RootExecutionError("root_state_invalid", "Released leaf permit cannot execute");
            if (running)
              throw new RootExecutionError("root_state_invalid", "A leaf permit cannot execute concurrent callbacks");
            if (leafScope.getStore())
              throw new RootExecutionError(
                "root_nested_leaf",
                "A leaf permit cannot execute inside another controlled leaf",
              );
            if (requireActive) this.ensureActive(waiter.signal);
            running = true;
            try {
              return await leafScope.run(this, execute);
            } finally {
              running = false;
            }
          };
          const lease: RootExecutionLease = {
            attemptId,
            run: (execute) => executeOwned(execute, true),
            cleanup: (execute) => executeOwned(execute, false),
            release: async () => {
              if (released) return;
              if (running)
                throw new RootExecutionError(
                  "root_state_invalid",
                  "A leaf permit cannot release before its callback settles",
                );
              released = true;
              this.active--;
              this.emit({ type: "released", kind: waiter.kind, id: waiter.id, attemptId });
              this.pump();
            },
          };
          this.emit({ type: "admitted", kind: waiter.kind, id: waiter.id, attemptId });
          waiter.resolve(lease);
        })
        .catch((error: unknown) => {
          this.active--;
          this.emit({
            type: error instanceof RootExecutionError && error.code === "root_attempt_limit" ? "exhausted" : "rejected",
            kind: waiter.kind,
            id: waiter.id,
            attemptId,
            code: error instanceof RootExecutionError ? error.code : undefined,
          });
          waiter.reject(error);
          this.pump();
        });
    }
  }
  async run<T>(kind: RootExecutionKind, id: string, execute: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const lease = await this.acquire(kind, id, signal);
    try {
      return await lease.run(execute);
    } finally {
      await lease.release();
    }
  }
}

/** Standalone Agent provider interception. Controlled hosts meter their own ports. */
export function withRootExecutionProvider(
  provider: ModelProvider,
  root: RootExecutionController,
  id: string,
): ModelProvider {
  let sequence = 0;
  return {
    providerId: provider.providerId,
    modelId: provider.modelId,
    capabilities: provider.capabilities,
    unknownCapabilities: provider.unknownCapabilities,
    communicationCapabilities: provider.communicationCapabilities,
    accountingRole: provider.accountingRole,
    attemptVisibility: provider.attemptVisibility,
    generate: (messages, options) =>
      root.run(
        "model",
        `${id}/model/${sequence++}`,
        () =>
          provider.generate(messages, {
            ...options,
            signal: options?.signal ? AbortSignal.any([options.signal, root.signal]) : root.signal,
            ...(root.deadline !== undefined
              ? { deadline: Math.min(root.deadline, options?.deadline ?? Infinity) }
              : {}),
          }),
        options?.signal,
      ),
    async *stream(messages, options): AsyncGenerator<StreamChunk> {
      const lease = await root.acquire("model", `${id}/model/${sequence++}`, options?.signal);
      let stream: AsyncGenerator<StreamChunk> | undefined;
      try {
        stream = provider.stream(messages, {
          ...options,
          signal: options?.signal ? AbortSignal.any([options.signal, root.signal]) : root.signal,
          ...(root.deadline !== undefined ? { deadline: Math.min(root.deadline, options?.deadline ?? Infinity) } : {}),
        });
        while (true) {
          const next = await lease.run(() =>
            stream ? stream.next() : Promise.reject(new Error("Missing model stream")),
          );
          if (next.done) break;
          yield next.value;
        }
      } finally {
        try {
          const iterator = stream;
          if (iterator) await lease.cleanup(() => iterator.return(undefined));
        } finally {
          await lease.release();
        }
      }
    },
  };
}
