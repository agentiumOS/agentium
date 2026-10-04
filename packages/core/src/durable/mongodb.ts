import { createRequire } from "node:module";
import { assertDurableFence, createDurableRecord, durableDigest, validateDurableUpdate } from "./store.js";
import {
  DurableConflictError,
  type DurableFence,
  DurableLeaseError,
  type DurableTaskInput,
  type DurableTaskKey,
  type DurableTaskRecord,
  type DurableTaskStore,
} from "./types.js";

const require = createRequire(import.meta.url);

/** Single-document CAS adapter: task, action ledger and extension outbox commit together.
 * No cross-task transaction guarantee. MongoDB must provide majority+journal writes.
 */
export class MongoDBDurableTaskStore implements DurableTaskStore {
  readonly capabilities = {
    durable: true,
    atomicTaskUpdates: true,
    compareAndSet: true,
    fencing: true,
    durableOutbox: true,
  } as const;
  private client: any;
  private db: any;
  private collection: any;
  constructor(
    private uri: string,
    private options: { database?: string; collection?: string; maxBytes?: number; maxConflicts?: number } = {},
  ) {}
  async initialize(): Promise<void> {
    if (this.collection) return;
    const { MongoClient } = require("mongodb");
    this.client = new MongoClient(this.uri, { retryWrites: true });
    await this.client.connect();
    this.db = this.client.db(this.options.database ?? "agentium");
    this.collection = this.db.collection(this.options.collection ?? "durable_tasks", {
      readPreference: "primary",
      readConcern: { level: "majority" },
      writeConcern: { w: "majority", j: true },
    });
  }
  private ready(): void {
    if (!this.collection) throw new Error("Initialize MongoDBDurableTaskStore before use");
  }
  private id(key: DurableTaskKey): string {
    return durableDigest([key.tenantId, key.taskId]);
  }
  private async now(): Promise<number> {
    const result = await this.db.command({ hello: 1 });
    const now = Number(result.localTime);
    if (!Number.isFinite(now)) throw new Error("MongoDB server clock unavailable");
    return now;
  }
  async create(input: DurableTaskInput): Promise<DurableTaskRecord> {
    this.ready();
    const record = createDurableRecord(input, await this.now());
    validateDurableUpdate(record, record, this.options.maxBytes ?? 2_000_000);
    try {
      await this.collection.insertOne({
        _id: this.id({ tenantId: input.identity.tenantId, taskId: input.id }),
        ...record,
      });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw new DurableConflictError("Task already exists");
      throw error;
    }
    return structuredClone(record);
  }
  async get(key: DurableTaskKey): Promise<DurableTaskRecord | null> {
    this.ready();
    const value = await this.collection.findOne({
      _id: this.id(key),
      "identity.tenantId": key.tenantId,
      id: key.taskId,
    });
    if (!value) return null;
    const { _id, ...record } = value;
    return record;
  }
  async update(
    key: DurableTaskKey,
    mutate: (draft: DurableTaskRecord, now: number) => void,
    guard?: DurableFence,
  ): Promise<DurableTaskRecord> {
    this.ready();
    for (let attempt = 0; attempt < (this.options.maxConflicts ?? 32); attempt++) {
      const before = await this.get(key);
      if (!before) throw new DurableConflictError("Task not found");
      const now = await this.now();
      if (guard) assertDurableFence(before, guard, now);
      const next = structuredClone(before);
      const result: unknown = mutate(next, now);
      if (result && typeof (result as PromiseLike<unknown>).then === "function")
        throw new TypeError("Durable update callback must be synchronous");
      validateDurableUpdate(before, next, this.options.maxBytes ?? 2_000_000, guard);
      next.revision++;
      next.updatedAt = now;
      const filter: Record<string, unknown> = {
        _id: this.id(key),
        revision: before.revision,
        "identity.tenantId": key.tenantId,
      };
      if (guard) {
        filter["lease.workerId"] = guard.workerId;
        filter["lease.fence"] = guard.fence;
        filter.$expr = { $gt: ["$lease.expiresAt", { $toLong: "$$NOW" }] };
      } else if (before.lease && next.fence > before.fence) {
        filter.$expr = { $lte: ["$lease.expiresAt", { $toLong: "$$NOW" }] };
      }
      const write = await this.collection.replaceOne(filter, { _id: this.id(key), ...next });
      if (write.matchedCount === 1) return structuredClone(next);
      if (guard) {
        const current = await this.get(key);
        if (!current) throw new DurableLeaseError();
        assertDurableFence(current, guard, await this.now());
      }
    }
    throw new DurableConflictError("Concurrent task updates exceeded retry limit");
  }
  async close(): Promise<void> {
    await this.client?.close();
    this.collection = undefined;
  }
}
