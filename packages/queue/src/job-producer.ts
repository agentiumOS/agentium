import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { RunOutput } from "@agentium/core";
import { queueConnection } from "./connection.js";
import type { AgentJobPayload, JobStatus, ScheduleInfo, TeamJobPayload, WorkflowJobPayload } from "./job-types.js";

const require = createRequire(import.meta.url);
const LEGACY_MIGRATION =
  "Legacy repeat schedule maintenance requires BullMQ v5. Stop writers/workers, use BullMQ 5.81.5 to pause, drain, inventory and migrate legacy repeats, then restart with BullMQ v6.";

export interface ScheduleOptions {
  id: string;
  cron: string;
  timezone?: string;
  agent?: { name: string; input: string; sessionId?: string; userId?: string; tenantId?: string };
  workflow?: {
    name: string;
    initialState?: Record<string, unknown>;
    sessionId?: string;
    userId?: string;
    tenantId?: string;
  };
  team?: { name: string; input: string; sessionId?: string; userId?: string; tenantId?: string };
}

export interface QueueConfig {
  connection: { host: string; port: number; password?: string; db?: number; tls?: boolean } | string;
  queueName?: string;
  defaultJobOptions?: Record<string, unknown>;
}

export class AgentQueue {
  private queue: any;
  private queueEvents: any;
  private queueName: string;

  constructor(config: QueueConfig) {
    this.queueName = config.queueName ?? "agentium-jobs";
    const connection = queueConnection(config.connection);
    try {
      const { Queue, QueueEvents } = require("bullmq");
      this.queue = new Queue(this.queueName, {
        connection,
        defaultJobOptions: config.defaultJobOptions,
      });
      this.queueEvents = new QueueEvents(this.queueName, {
        connection,
      });
    } catch (err: any) {
      if (err?.code === "MODULE_NOT_FOUND" || err?.message?.includes("Cannot find module")) {
        throw new Error("bullmq and ioredis are required for AgentQueue. Install them: npm install bullmq ioredis");
      }
      throw err;
    }
  }

  async enqueueAgentRun(opts: {
    agentName: string;
    input: string;
    sessionId?: string;
    tenantId?: string;
    userId?: string;
    priority?: number;
    delay?: number;
    attempts?: number;
    backoff?: { type: "exponential" | "fixed"; delay: number };
    repeat?: { pattern: string; timezone?: string };
  }): Promise<{ jobId: string }> {
    const payload: AgentJobPayload = {
      type: "agent",
      agentName: opts.agentName,
      input: opts.input,
      sessionId: opts.sessionId,
      tenantId: opts.tenantId,
      userId: opts.userId,
    };

    const jobOpts: Record<string, unknown> = {};
    if (opts.priority !== undefined) jobOpts.priority = opts.priority;
    if (opts.delay !== undefined) jobOpts.delay = opts.delay;
    if (opts.attempts !== undefined) jobOpts.attempts = opts.attempts;
    if (opts.backoff) jobOpts.backoff = opts.backoff;

    if (opts.repeat) return this.enqueueRecurring(`agent:${opts.agentName}`, payload, opts.repeat, jobOpts);
    const job = await this.queue.add(`agent:${opts.agentName}`, payload, jobOpts);

    return { jobId: job.id };
  }

  async enqueueWorkflow(opts: {
    workflowName: string;
    userId?: string;
    initialState?: Record<string, unknown>;
    sessionId?: string;
    tenantId?: string;
    priority?: number;
    delay?: number;
    attempts?: number;
    backoff?: { type: "exponential" | "fixed"; delay: number };
    repeat?: { pattern: string; timezone?: string };
  }): Promise<{ jobId: string }> {
    const payload: WorkflowJobPayload = {
      type: "workflow",
      workflowName: opts.workflowName,
      userId: opts.userId,
      initialState: opts.initialState,
      sessionId: opts.sessionId,
      tenantId: opts.tenantId,
    };

    const jobOpts: Record<string, unknown> = {};
    if (opts.priority !== undefined) jobOpts.priority = opts.priority;
    if (opts.delay !== undefined) jobOpts.delay = opts.delay;
    if (opts.attempts !== undefined) jobOpts.attempts = opts.attempts;
    if (opts.backoff) jobOpts.backoff = opts.backoff;

    if (opts.repeat) return this.enqueueRecurring(`workflow:${opts.workflowName}`, payload, opts.repeat, jobOpts);
    const job = await this.queue.add(`workflow:${opts.workflowName}`, payload, jobOpts);

    return { jobId: job.id };
  }

  async enqueueTeamRun(opts: {
    teamName: string;
    input: string;
    sessionId?: string;
    tenantId?: string;
    userId?: string;
    priority?: number;
    delay?: number;
    attempts?: number;
    backoff?: { type: "exponential" | "fixed"; delay: number };
    repeat?: { pattern: string; timezone?: string };
  }): Promise<{ jobId: string }> {
    const payload: TeamJobPayload = {
      type: "team",
      teamName: opts.teamName,
      input: opts.input,
      sessionId: opts.sessionId,
      tenantId: opts.tenantId,
      userId: opts.userId,
    };

    const jobOpts: Record<string, unknown> = {};
    if (opts.priority !== undefined) jobOpts.priority = opts.priority;
    if (opts.delay !== undefined) jobOpts.delay = opts.delay;
    if (opts.attempts !== undefined) jobOpts.attempts = opts.attempts;
    if (opts.backoff) jobOpts.backoff = opts.backoff;

    if (opts.repeat) return this.enqueueRecurring(`team:${opts.teamName}`, payload, opts.repeat, jobOpts);
    const job = await this.queue.add(`team:${opts.teamName}`, payload, jobOpts);

    return { jobId: job.id };
  }

  async getJobStatus(jobId: string): Promise<JobStatus> {
    const job = await this.queue.getJob(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    const state = await job.getState();

    return {
      jobId: job.id,
      state: state as JobStatus["state"],
      progress: typeof job.progress === "number" ? job.progress : undefined,
      result: job.returnvalue,
      error: job.failedReason,
      createdAt: new Date(job.timestamp),
      processedAt: job.processedOn ? new Date(job.processedOn) : undefined,
      finishedAt: job.finishedOn ? new Date(job.finishedOn) : undefined,
    };
  }

  async cancelJob(jobId: string): Promise<void> {
    const job = await this.queue.getJob(jobId);
    if (job) {
      await job.remove();
    }
  }

  onCompleted(handler: (jobId: string, result: RunOutput) => void): void {
    this.queueEvents.on("completed", ({ jobId, returnvalue }: any) => {
      handler(jobId, returnvalue);
    });
  }

  onFailed(handler: (jobId: string, error: Error) => void): void {
    this.queueEvents.on("failed", ({ jobId, failedReason }: any) => {
      handler(jobId, new Error(failedReason));
    });
  }

  private async enqueueRecurring(
    name: string,
    data: AgentJobPayload | WorkflowJobPayload | TeamJobPayload,
    repeat: { pattern: string; timezone?: string },
    options: Record<string, unknown>,
  ) {
    const id = `repeat-${createHash("sha256").update(JSON.stringify({ name, data, repeat })).digest("hex")}`;
    await this.assertNoLegacySchedule(name, repeat.pattern);
    const job = await this.queue.upsertJobScheduler(
      id,
      { pattern: repeat.pattern, tz: repeat.timezone },
      { name, data, opts: options },
    );
    return { jobId: job.id };
  }

  private async schedulerRecords(): Promise<
    Array<{ key: string; name?: string; pattern?: string; tz?: string; next: number; iterationCount?: number }>
  > {
    try {
      return await this.queue.getJobSchedulers(0, -1, true);
    } catch (cause) {
      if (cause instanceof Error && /legacy repeatable job/i.test(cause.message))
        throw new Error(LEGACY_MIGRATION, { cause });
      throw cause;
    }
  }

  private hasLegacyMaintenance(): boolean {
    return typeof this.queue.getRepeatableJobs === "function" && typeof this.queue.removeRepeatableByKey === "function";
  }

  private async assertNoLegacySchedule(name: string, pattern: string) {
    if (!this.hasLegacyMaintenance()) {
      // v6 can return hashed v5 repeat metadata without iterationCount, or reject older keys outright.
      // Do not silently filter that data and create a duplicate scheduler alongside it.
      if ((await this.schedulerRecords()).some((job) => typeof job.iterationCount !== "number"))
        throw new Error(LEGACY_MIGRATION);
      return;
    }
    const legacy = await this.listLegacySchedules();
    if (legacy.some((item) => item.name === name && item.pattern === pattern)) {
      throw new Error(
        "A legacy repeat schedule already exists; pause and explicitly migrate it before creating a Job Scheduler",
      );
    }
  }

  async schedule(opts: ScheduleOptions): Promise<{ jobId: string }> {
    if (!opts.id || !opts.cron) throw new Error("schedule() requires a stable id and cron");
    if ([opts.agent, opts.workflow, opts.team].filter(Boolean).length !== 1)
      throw new Error("schedule() requires exactly one agent, workflow or team");
    let data: AgentJobPayload | WorkflowJobPayload | TeamJobPayload;
    let name: string;
    if (opts.agent) {
      name = `agent:${opts.agent.name}`;
      data = {
        type: "agent",
        agentName: opts.agent.name,
        input: opts.agent.input,
        sessionId: opts.agent.sessionId,
        userId: opts.agent.userId,
        tenantId: opts.agent.tenantId,
      };
    } else if (opts.team) {
      name = `team:${opts.team.name}`;
      data = {
        type: "team",
        teamName: opts.team.name,
        input: opts.team.input,
        sessionId: opts.team.sessionId,
        userId: opts.team.userId,
        tenantId: opts.team.tenantId,
      };
    } else {
      name = `workflow:${opts.workflow!.name}`;
      data = {
        type: "workflow",
        workflowName: opts.workflow!.name,
        initialState: opts.workflow!.initialState,
        sessionId: opts.workflow!.sessionId,
        userId: opts.workflow!.userId,
        tenantId: opts.workflow!.tenantId,
      };
    }
    await this.assertNoLegacySchedule(name, opts.cron);
    const job = await this.queue.upsertJobScheduler(opts.id, { pattern: opts.cron, tz: opts.timezone }, { name, data });
    return { jobId: job.id };
  }

  async unschedule(id: string): Promise<void> {
    if (!(await this.queue.removeJobScheduler(id))) throw new Error(`Schedule "${id}" not found`);
  }

  async listSchedules(): Promise<ScheduleInfo[]> {
    const jobs = await this.schedulerRecords();
    if (!this.hasLegacyMaintenance() && jobs.some((job) => typeof job.iterationCount !== "number"))
      throw new Error(LEGACY_MIGRATION);
    return jobs
      .filter((job) => typeof job.iterationCount === "number")
      .map((job) => ({ id: job.key, pattern: job.pattern ?? "", timezone: job.tz, next: new Date(job.next) }));
  }

  /** BullMQ v5 maintenance only. Never silently converts persisted legacy repeat records. */
  async listLegacySchedules(): Promise<
    Array<{ key: string; name: string; pattern?: string; timezone?: string; next: number }>
  > {
    if (!this.hasLegacyMaintenance()) throw new Error(LEGACY_MIGRATION);
    const schedulerIds = new Set(
      (await this.schedulerRecords()).filter((job) => typeof job.iterationCount === "number").map((job) => job.key),
    );
    return (await this.queue.getRepeatableJobs())
      .filter((job: any) => !schedulerIds.has(job.key))
      .map((job: any) => ({
        key: job.key,
        name: job.name,
        pattern: job.pattern,
        timezone: job.tz,
        next: job.next,
      }));
  }

  async pause(): Promise<void> {
    await this.queue.pause();
  }
  async resume(): Promise<void> {
    await this.queue.resume();
  }

  /** Maintenance-only removal: callers retain inventory/payload backups and stop concurrent schedule writers. */
  async removeLegacySchedule(key: string): Promise<void> {
    if (!this.hasLegacyMaintenance()) throw new Error(LEGACY_MIGRATION);
    if (!(await this.queue.isPaused()) || (await this.queue.getActiveCount()) !== 0)
      throw new Error("Pause the queue and drain active jobs before migrating schedules");
    if (!(await this.listLegacySchedules()).some((job) => job.key === key))
      throw new Error("Legacy schedule not found");
    await this.queue.removeRepeatableByKey(key);
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled([this.queue.close(), this.queueEvents.close()]);
    for (const r of results) {
      if (r.status === "rejected") console.warn("[JobProducer] Error during close:", r.reason);
    }
  }
}
