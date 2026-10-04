import { randomUUID } from "node:crypto";
import { type DurableTaskInput, DurableTaskSupervisor, InMemoryDurableTaskStore } from "@agentium/core";
import { Queue } from "bullmq";
import { afterEach, describe, expect, it } from "vitest";
import { DurableAgentQueue, DurableAgentWorker } from "../durable.js";

const enabled = process.env.AGENTIUM_REDIS_TEST === "1";
const connection = { host: "127.0.0.1", port: Number(process.env.AGENTIUM_REDIS_PORT ?? 6389) };
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function input(): DurableTaskInput {
  return {
    id: randomUUID(),
    identity: { tenantId: "tenant", actorId: "actor", sessionId: "session", runId: "run", rootRunId: "run" },
    manifestHash: "manifest",
    inputRef: "input",
    policyRevision: 1,
    grantRefs: ["grant"],
    driver: { id: "fixture", version: 1 },
    input: { value: 42 },
  };
}
function setup() {
  const queueName = `durable-fixture-${randomUUID()}`;
  const store = new InMemoryDurableTaskStore();
  const supervisor = new DurableTaskSupervisor(store, { leaseMs: 150, pollMs: 30 });
  const native = new Queue(queueName, { connection });
  cleanup.push(async () => {
    await native.obliterate({ force: true });
    await native.close();
  });
  const queue = new DurableAgentQueue({
    queueName,
    connection,
    supervisor,
    admit: async (task) => {
      if (task.identity.actorId !== "actor") throw new Error("denied");
    },
  });
  cleanup.push(() => queue.close());
  return { queueName, queue, native, store, supervisor };
}
describe.skipIf(!enabled)("durable Redis delivery", () => {
  it("admits before persistence, deduplicates task definitions, and keeps payloads bounded", async () => {
    const { queue, native, supervisor } = setup();
    const task = input();
    const key = { tenantId: "tenant", taskId: task.id };
    await expect(queue.enqueue({ ...task, identity: { ...task.identity, actorId: "other" } })).rejects.toThrow(
      "denied",
    );
    expect(await supervisor.get(key)).toBeNull();
    const first = await queue.enqueue(task);
    await queue.enqueue(task);
    await expect(queue.enqueue({ ...task, budget: { maxTokens: 1 } })).rejects.toThrow(/immutable/);
    expect((await native.getJob(first.deliveryId))!.data).toEqual(
      expect.objectContaining({ schemaVersion: 1, taskId: task.id }),
    );
    expect(Object.keys((await native.getJob(first.deliveryId))!.data).sort()).toEqual([
      "inputDigest",
      "schemaVersion",
      "taskId",
      "tenantId",
      "type",
    ]);
  });
  it("retains an early duplicate hint until a crashed owner's lease expires, then executes once", async () => {
    const { queue, supervisor, queueName } = setup();
    const task = input();
    const key = { tenantId: "tenant", taskId: task.id };
    await queue.enqueue(task);
    await supervisor.claim(key, "crashed-owner");
    let calls = 0;
    const worker = new DurableAgentWorker({
      queueName,
      connection,
      supervisor,
      admit: async () => {},
      drivers: [
        {
          id: "fixture",
          version: 1,
          recoverable: true,
          execute: async (ctx) => {
            expect(ctx.task.input).toEqual({ value: 42 });
            calls++;
          },
        },
      ],
    });
    cleanup.push(() => worker.stop());
    await expect.poll(async () => (await supervisor.get(key))?.state).toBe("completed");
    await queue.wake(key);
    await expect.poll(async () => (await supervisor.get(key))?.fence).toBe(2);
    expect(calls).toBe(1);
  });
  it("rejects tampered hints and fresh grant revocation, and cancellation skips the driver", async () => {
    const { queue, native, supervisor, queueName } = setup();
    const task = input();
    const key = { tenantId: "tenant", taskId: task.id };
    const delivery = await queue.enqueue(task);
    const job = (await native.getJob(delivery.deliveryId))!;
    await job.updateData({ ...job.data, inputDigest: `sha256:${"0".repeat(64)}` });
    let admitted = false;
    let calls = 0;
    const worker = new DurableAgentWorker({
      queueName,
      connection,
      supervisor,
      admit: async () => {
        if (!admitted) throw new Error("revoked");
      },
      drivers: [
        {
          id: "fixture",
          version: 1,
          recoverable: true,
          execute: async () => {
            calls++;
          },
        },
      ],
    });
    cleanup.push(() => worker.stop());
    await expect.poll(() => job.getState()).toBe("failed");
    expect((await supervisor.get(key))?.state).toBe("queued");
    const revoked = await queue.wake(key);
    await expect.poll(async () => (await native.getJob(revoked.deliveryId))?.getState()).toBe("failed");
    admitted = true;
    await queue.cancel(key);
    await expect.poll(async () => (await supervisor.get(key))?.state).toBe("canceled");
    expect(calls).toBe(0);
  });
});
