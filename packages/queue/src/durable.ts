import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  type DurableExecutionContext,
  type DurableTaskHandler,
  type DurableTaskInput,
  type DurableTaskKey,
  type DurableTaskRecord,
  type DurableTaskSupervisor,
  durableCanonical,
  durableTaskDigest,
} from "@agentium/core";
import { queueConnection } from "./connection.js";
import type { QueueConfig } from "./job-producer.js";

const requireQueue = createRequire(import.meta.url);
export interface DurableJobEnvelope {
  schemaVersion: 1;
  type: "durable";
  tenantId: string;
  taskId: string;
  inputDigest: string;
}
export interface DurableDriverRegistration {
  id: string;
  version: number;
  /** Explicit host assertion: resumes use stable action IDs and reconcile uncertain effects. */
  recoverable: true;
  execute: DurableTaskHandler;
}
export interface DurableQueueConfig extends QueueConfig {
  supervisor: DurableTaskSupervisor;
  /** Verify identity, definition, policy and grants before writing any task/queue record. */
  admit: (task: Readonly<DurableTaskInput>) => Promise<void>;
}
function envelope(task: DurableTaskInput): DurableJobEnvelope {
  return {
    schemaVersion: 1,
    type: "durable",
    tenantId: task.identity.tenantId,
    taskId: task.id,
    inputDigest: durableTaskDigest(task),
  };
}
function parseEnvelope(value: unknown): DurableJobEnvelope {
  if (!value || typeof value !== "object") throw new Error("Invalid durable queue envelope");
  const input = value as DurableJobEnvelope;
  if (
    Object.keys(input).some((key) => !["schemaVersion", "type", "tenantId", "taskId", "inputDigest"].includes(key)) ||
    input.schemaVersion !== 1 ||
    input.type !== "durable" ||
    typeof input.tenantId !== "string" ||
    !input.tenantId.trim() ||
    input.tenantId.length > 512 ||
    typeof input.taskId !== "string" ||
    !input.taskId.trim() ||
    input.taskId.length > 512 ||
    typeof input.inputDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(input.inputDigest)
  )
    throw new Error("Invalid durable queue envelope");
  return input;
}
/** Queue delivery is a hint; Mongo/another atomic task store owns authoritative state.
 * Persistence precedes enqueue. If Redis fails, call wake() after retrying admission.
 * The stable task key prevents a delivery retry from creating a second execution.
 */
export class DurableAgentQueue {
  private queue: any;
  constructor(private readonly config: DurableQueueConfig) {
    const { Queue } = requireQueue("bullmq");
    this.queue = new Queue(config.queueName ?? "agentium-durable", {
      connection: queueConnection(config.connection),
      defaultJobOptions: config.defaultJobOptions,
    });
  }
  async enqueue(task: DurableTaskInput): Promise<{ taskId: string; deliveryId: string }> {
    const copy = JSON.parse(durableCanonical(task)) as DurableTaskInput;
    if (!copy.driver?.id || !Number.isSafeInteger(copy.driver.version) || copy.driver.version < 1)
      throw new Error("Durable tasks require a versioned driver reference");
    await this.config.admit(structuredClone(copy));
    const key = { tenantId: copy.identity.tenantId, taskId: copy.id };
    const existing = await this.config.supervisor.get(key);
    if (existing) {
      if (durableTaskDigest(existing) !== durableTaskDigest(copy))
        throw new Error("Task ID already has a different immutable envelope");
    } else {
      try {
        await this.config.supervisor.create(copy);
      } catch (error) {
        const raced = await this.config.supervisor.get(key);
        if (!raced || durableTaskDigest(raced) !== durableTaskDigest(copy)) throw error;
      }
    }
    return this.wake(key);
  }
  /** Explicit re-delivery after approval, reconciliation, or a failed initial enqueue. */
  async wake(key: DurableTaskKey): Promise<{ taskId: string; deliveryId: string }> {
    const task = await this.config.supervisor.get(key);
    if (!task) throw new Error("Durable task not found");
    await this.config.admit(structuredClone(task));
    const job = await this.queue.add("durable", envelope(task), { jobId: randomUUID(), removeOnComplete: true });
    return { taskId: task.id, deliveryId: job.id };
  }
  async cancel(key: DurableTaskKey, reason?: string): Promise<void> {
    const task = await this.config.supervisor.get(key);
    if (!task) throw new Error("Durable task not found");
    await this.config.admit(structuredClone(task));
    await this.config.supervisor.cancel(key, reason);
    await this.wake(key);
  }
  async close(): Promise<void> {
    await this.queue.close();
  }
}

export interface DurableWorkerConfig extends Omit<QueueConfig, "defaultJobOptions"> {
  supervisor: DurableTaskSupervisor;
  workerId?: string;
  concurrency?: number;
  drivers: readonly DurableDriverRegistration[];
  /** Revalidate policy/grants from authoritative host state; a payload is not authentication. */
  admit: (task: Readonly<DurableTaskRecord>) => Promise<void>;
  /** Observe delivery failures; durable task outcome remains available from the store. */
  onError?: (error: Error) => void;
}
export class DurableAgentWorker {
  private worker: any;
  constructor(config: DurableWorkerConfig) {
    const drivers = new Map<string, DurableDriverRegistration>();
    for (const driver of config.drivers) {
      const key = `${driver.id}@${driver.version}`;
      if (
        !driver.id ||
        !Number.isSafeInteger(driver.version) ||
        driver.version < 1 ||
        driver.recoverable !== true ||
        drivers.has(key)
      )
        throw new Error("Durable drivers require unique versioned, explicitly recoverable registrations");
      drivers.set(key, driver);
    }
    const workerId = config.workerId ?? `worker-${randomUUID()}`;
    if (!Number.isSafeInteger(config.concurrency ?? 5) || (config.concurrency ?? 5) < 1)
      throw new Error("Worker concurrency must be positive");
    const { Worker, DelayedError } = requireQueue("bullmq");
    this.worker = new Worker(
      config.queueName ?? "agentium-durable",
      async (
        job: { data: unknown; moveToDelayed(timestamp: number, token?: string): Promise<void> },
        token?: string,
      ) => {
        const delivery = parseEnvelope(job.data);
        const key = { tenantId: delivery.tenantId, taskId: delivery.taskId };
        const task = await config.supervisor.get(key);
        if (!task || envelope(task).inputDigest !== delivery.inputDigest)
          throw new Error("Durable delivery does not match persisted task");
        await config.admit(structuredClone(task));
        const driver = task.driver ? drivers.get(`${task.driver.id}@${task.driver.version}`) : undefined;
        if (!driver) throw new Error("Durable execution driver is not registered");
        const result = await config.supervisor.run(key, workerId, async (context: DurableExecutionContext) => {
          // A second check after the atomic claim closes the wait/admission boundary.
          await config.admit(structuredClone(context.task));
          return driver.execute(context);
        });
        // A duplicate delivery may arrive while a crashed owner's lease still lives.
        // Keep this hint pending until the lease can be reclaimed, rather than losing it.
        if (result.lease && (result.state === "running" || result.state === "cancel_requested")) {
          await job.moveToDelayed(
            Date.now() + Math.max(25, Math.min(config.supervisor.leaseMs, result.lease.expiresAt - result.updatedAt)),
            token,
          );
          throw new DelayedError();
        }
        return { taskId: result.id, state: result.state, revision: result.revision };
      },
      { connection: queueConnection(config.connection), concurrency: config.concurrency ?? 5 },
    );
    this.worker.on("error", (error: Error) => config.onError?.(error));
  }
  /** Drains owned work. Active durable cancellation is explicit through queue.cancel(). */
  async stop(): Promise<void> {
    await this.worker.close();
  }
}
