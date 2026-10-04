import { randomUUID } from "node:crypto";
import { EventBus } from "@agentium/core";
import { Queue } from "bullmq";
import { Queue as LegacyQueue } from "bullmq-v5";
import { Redis } from "ioredis";
import { afterEach, expect, it, vi } from "vitest";
import { AgentQueue } from "../job-producer.js";
import { AgentWorker } from "../job-worker.js";

// Exercise the same adapter against both real SDK majors without changing its public constructor.
const sdk = vi.hoisted(() => ({ legacy: false }));
vi.mock("node:module", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:module")>();
  return {
    ...original,
    createRequire(...args: Parameters<typeof original.createRequire>) {
      const nativeRequire = original.createRequire(...args);
      return Object.assign(
        (id: string) => nativeRequire(id === "bullmq" && sdk.legacy ? "bullmq-v5" : id),
        nativeRequire,
      );
    },
  };
});

const enabled = process.env.AGENTIUM_REDIS_TEST === "1";
const connection = { host: "127.0.0.1", port: Number(process.env.AGENTIUM_REDIS_PORT ?? 6389) };
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  sdk.legacy = false;
  for (const close of cleanup.splice(0).reverse()) await close();
});

it.skipIf(!enabled)(
  "runs jobs and upserts/removes stable agent/team/workflow scheduler IDs on real Redis",
  async () => {
    const queueName = `agentium-integration-${randomUUID()}`;
    const queue = new AgentQueue({ queueName, connection });
    const native = new Queue(queueName, { connection });
    cleanup.push(async () => {
      await native.obliterate({ force: true });
      await native.close();
    });
    cleanup.push(() => queue.close());
    for (const opts of [
      { id: "daily-agent", agent: { name: "bot", input: "one" } },
      { id: "daily-team", team: { name: "squad", input: "two" } },
      { id: "daily-workflow", workflow: { name: "flow", initialState: { counter: 2 } } },
    ]) {
      await queue.schedule({ ...opts, cron: "0 0 * * *", timezone: "UTC" });
      await queue.schedule({ ...opts, cron: "0 1 * * *", timezone: "UTC" });
    }
    expect((await queue.listSchedules()).map((s) => s.id).sort()).toEqual([
      "daily-agent",
      "daily-team",
      "daily-workflow",
    ]);
    await expect(queue.listLegacySchedules()).rejects.toThrow("requires BullMQ v5");
    await queue.unschedule("daily-agent");
    expect((await queue.listSchedules()).map((s) => s.id)).not.toContain("daily-agent");
    const worker = new AgentWorker({
      queueName,
      connection,
      agentRegistry: {},
      workflowRegistry: {
        flow: { run: async (options: any) => ({ state: options.initialState }) } as any,
      },
    });
    cleanup.push(() => worker.stop());
    const { jobId } = await queue.enqueueWorkflow({ workflowName: "flow", initialState: { marker: "forwarded" } });
    await expect.poll(async () => (await queue.getJobStatus(jobId)).state).toBe("completed");
    expect((await queue.getJobStatus(jobId)).result).toEqual({ state: { marker: "forwarded" } });
  },
);

it.skipIf(!enabled)("refuses real v5 legacy data on v6 until explicit paused v5 migration", async () => {
  const queueName = `agentium-legacy-${randomUUID()}`;
  const native = new LegacyQueue(queueName, { connection });
  const current = new AgentQueue({ queueName, connection });
  cleanup.push(async () => {
    await native.obliterate({ force: true });
    await native.close();
  });
  cleanup.push(() => current.close());
  await native.add(
    "agent:bot",
    { type: "agent", agentName: "bot", input: "legacy" },
    { repeat: { pattern: "0 0 * * *" } },
  );
  const before = await native.getRepeatableJobs();
  expect(before).toHaveLength(1);
  await expect(current.listLegacySchedules()).rejects.toThrow("requires BullMQ v5");
  await expect(current.removeLegacySchedule(before[0].key)).rejects.toThrow("requires BullMQ v5");
  await expect(current.listSchedules()).rejects.toThrow("requires BullMQ v5");
  await expect(
    current.schedule({ id: "replacement", cron: "0 0 * * *", agent: { name: "bot", input: "legacy" } }),
  ).rejects.toThrow("requires BullMQ v5");
  await expect(
    current.enqueueAgentRun({ agentName: "unrelated", input: "repeat", repeat: { pattern: "0 1 * * *" } }),
  ).rejects.toThrow("requires BullMQ v5");
  expect((await native.getRepeatableJobs()).map((job) => job.key)).toEqual(before.map((job) => job.key));

  sdk.legacy = true;
  const maintenance = new AgentQueue({ queueName, connection });
  sdk.legacy = false;
  cleanup.push(() => maintenance.close());
  const legacy = await maintenance.listLegacySchedules();
  expect(legacy).toHaveLength(1);
  expect(await maintenance.listSchedules()).toEqual([]);
  await expect(
    maintenance.schedule({ id: "replacement", cron: "0 0 * * *", agent: { name: "bot", input: "legacy" } }),
  ).rejects.toThrow(/legacy/);
  await expect(maintenance.removeLegacySchedule(legacy[0].key)).rejects.toThrow(/Pause/);
  await maintenance.pause();
  await maintenance.removeLegacySchedule(legacy[0].key);
  expect(await maintenance.listLegacySchedules()).toEqual([]);
  await maintenance.schedule({ id: "replacement", cron: "0 0 * * *", agent: { name: "bot", input: "legacy" } });
  await current.schedule({ id: "replacement", cron: "0 1 * * *", agent: { name: "bot", input: "updated" } });
  expect(await current.listSchedules()).toEqual([expect.objectContaining({ id: "replacement", pattern: "0 1 * * *" })]);
  expect(await maintenance.listLegacySchedules()).toEqual([]);
  await current.unschedule("replacement");
  expect(await current.listSchedules()).toEqual([]);
  await maintenance.resume();
});

it.skipIf(!enabled)("preserves older legacy keys when v6 rejects their persisted metadata", async () => {
  const queueName = `agentium-old-legacy-${randomUUID()}`;
  const native = new LegacyQueue(queueName, { connection });
  const current = new AgentQueue({ queueName, connection });
  cleanup.push(async () => {
    await native.obliterate({ force: true });
    await native.close();
  });
  cleanup.push(() => current.close());
  // Persist the pre-hash repeat-index shape: no metadata hash existed for these records.
  const key = "legacy::::0 0 * * *";
  const client = new Redis(connection);
  cleanup.push(() => client.quit());
  await client.zadd(native.keys.repeat, 2_000_000_000_000, key);
  const error = await current.listSchedules().catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("requires BullMQ v5");
  expect((error as Error).cause).toBeInstanceOf(Error);
  await expect(
    current.schedule({ id: "new", cron: "0 1 * * *", agent: { name: "bot", input: "new" } }),
  ).rejects.toThrow("requires BullMQ v5");
  expect(await client.zrange(native.keys.repeat, 0, -1)).toEqual([key]);
});

it.skipIf(!enabled)("keeps v5 scheduler upserts distinct from legacy inventory", async () => {
  const queueName = `agentium-v5-${randomUUID()}`;
  sdk.legacy = true;
  const queue = new AgentQueue({ queueName, connection });
  sdk.legacy = false;
  const native = new LegacyQueue(queueName, { connection });
  cleanup.push(async () => {
    await native.obliterate({ force: true });
    await native.close();
  });
  cleanup.push(() => queue.close());
  await queue.schedule({ id: "stable", cron: "0 0 * * *", agent: { name: "bot", input: "one" } });
  await queue.schedule({ id: "stable", cron: "0 1 * * *", agent: { name: "bot", input: "two" } });
  expect(await queue.listSchedules()).toEqual([expect.objectContaining({ id: "stable", pattern: "0 1 * * *" })]);
  expect(await queue.listLegacySchedules()).toEqual([]);
  await queue.unschedule("stable");
  expect(await queue.listSchedules()).toEqual([]);
});

it.skipIf(!enabled)("isolates concurrent worker progress and forwards scoped identity", async () => {
  const queueName = `agentium-progress-${randomUUID()}`;
  const queue = new AgentQueue({ queueName, connection });
  const native = new Queue(queueName, { connection });
  cleanup.push(async () => {
    await native.obliterate({ force: true });
    await native.close();
  });
  cleanup.push(() => queue.close());
  const eventBus = new EventBus();
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const captured: Array<{ runId: string; userId: string; tenantId: string }> = [];
  const agent = {
    eventBus,
    run: async (input: string, options: any) => {
      captured.push(options);
      if (++arrived === 2) release();
      await gate;
      eventBus.emit("run.stream.chunk", { runId: "another-run", chunk: "ignore" });
      eventBus.emit("run.stream.chunk", { runId: options.runId, chunk: input });
      return { text: input };
    },
  };
  const worker = new AgentWorker({ queueName, connection, concurrency: 2, agentRegistry: { shared: agent as any } });
  cleanup.push(() => worker.stop());
  const jobs = await Promise.all(
    ["one", "two"].map((input) =>
      queue.enqueueAgentRun({
        agentName: "shared",
        input,
        userId: "actor",
        tenantId: "tenant",
      }),
    ),
  );
  for (const { jobId } of jobs) {
    await expect.poll(async () => (await queue.getJobStatus(jobId)).state).toBe("completed");
    expect((await queue.getJobStatus(jobId)).progress).toBe(1);
  }
  expect(new Set(captured.map((value) => value.runId)).size).toBe(2);
  expect(captured.every((value) => value.userId === "actor" && value.tenantId === "tenant")).toBe(true);
});
