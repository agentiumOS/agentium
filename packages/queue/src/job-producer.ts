import type { RunOutput } from "@agentium/core";
import type { AgentJobPayload, JobStatus, ScheduleInfo, TeamJobPayload, WorkflowJobPayload } from "./job-types.js";

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
    this.queueName = config.queueName ?? "agentium:jobs";
    const connection = typeof config.connection === "string" ? { url: config.connection } : config.connection;
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
      userId: opts.userId,
    };

    const jobOpts: Record<string, unknown> = {};
    if (opts.priority !== undefined) jobOpts.priority = opts.priority;
    if (opts.delay !== undefined) jobOpts.delay = opts.delay;
    if (opts.attempts !== undefined) jobOpts.attempts = opts.attempts;
    if (opts.backoff) jobOpts.backoff = opts.backoff;
    if (opts.repeat) jobOpts.repeat = opts.repeat;

    const job = await this.queue.add(`agent:${opts.agentName}`, payload, jobOpts);

    return { jobId: job.id };
  }

  async enqueueWorkflow(opts: {
    workflowName: string;
    initialState?: Record<string, unknown>;
    sessionId?: string;
    priority?: number;
    delay?: number;
    attempts?: number;
    backoff?: { type: "exponential" | "fixed"; delay: number };
    repeat?: { pattern: string; timezone?: string };
  }): Promise<{ jobId: string }> {
    const payload: WorkflowJobPayload = {
      type: "workflow",
      workflowName: opts.workflowName,
      initialState: opts.initialState,
      sessionId: opts.sessionId,
    };

    const jobOpts: Record<string, unknown> = {};
    if (opts.priority !== undefined) jobOpts.priority = opts.priority;
    if (opts.delay !== undefined) jobOpts.delay = opts.delay;
    if (opts.attempts !== undefined) jobOpts.attempts = opts.attempts;
    if (opts.backoff) jobOpts.backoff = opts.backoff;
    if (opts.repeat) jobOpts.repeat = opts.repeat;

    const job = await this.queue.add(`workflow:${opts.workflowName}`, payload, jobOpts);

    return { jobId: job.id };
  }

  async enqueueTeamRun(opts: {
    teamName: string;
    input: string;
    sessionId?: string;
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
      userId: opts.userId,
    };

    const jobOpts: Record<string, unknown> = {};
    if (opts.priority !== undefined) jobOpts.priority = opts.priority;
    if (opts.delay !== undefined) jobOpts.delay = opts.delay;
    if (opts.attempts !== undefined) jobOpts.attempts = opts.attempts;
    if (opts.backoff) jobOpts.backoff = opts.backoff;
    if (opts.repeat) jobOpts.repeat = opts.repeat;

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

  async schedule(opts: {
    id: string;
    cron: string;
    timezone?: string;
    agent?: { name: string; input: string; sessionId?: string; userId?: string };
    workflow?: { name: string; initialState?: Record<string, unknown> };
    team?: { name: string; input: string; sessionId?: string; userId?: string };
  }): Promise<{ jobId: string }> {
    if (!opts.agent && !opts.workflow) {
      throw new Error("schedule() requires either agent or workflow");
    }
    if (opts.agent && opts.workflow) {
      throw new Error("schedule() accepts either agent or workflow, not both");
    }

    const repeat = { pattern: opts.cron, ...(opts.timezone ? { tz: opts.timezone } : {}) };

    if (opts.agent) {
      return this.enqueueAgentRun({
        agentName: opts.agent.name,
        input: opts.agent.input,
        sessionId: opts.agent.sessionId,
        userId: opts.agent.userId,
        repeat,
      });
    }

    if (opts.team) {
      return this.enqueueTeamRun({
        teamName: opts.team.name,
        input: opts.team.input,
        sessionId: opts.team.sessionId,
        userId: opts.team.userId,
        repeat,
      });
    }

    return this.enqueueWorkflow({
      workflowName: opts.workflow!.name,
      initialState: opts.workflow!.initialState,
      repeat,
    });
  }

  async unschedule(id: string): Promise<void> {
    const jobs = await this.queue.getRepeatableJobs();
    const match = jobs.find((j: any) => j.name === `agent:${id}` || j.name === `workflow:${id}` || j.name === id);
    if (!match) {
      throw new Error(`Schedule "${id}" not found`);
    }
    await this.queue.removeRepeatableByKey(match.key);
  }

  async listSchedules(): Promise<ScheduleInfo[]> {
    const jobs = await this.queue.getRepeatableJobs();
    return jobs.map((j: any) => ({
      id: j.name,
      pattern: j.pattern ?? j.cron,
      timezone: j.tz ?? undefined,
      next: j.next ? new Date(j.next) : new Date(),
    }));
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled([this.queue.close(), this.queueEvents.close()]);
    for (const r of results) {
      if (r.status === "rejected") console.warn("[JobProducer] Error during close:", r.reason);
    }
  }
}
