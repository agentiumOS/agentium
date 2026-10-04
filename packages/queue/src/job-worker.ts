import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { Agent, Workflow } from "@agentium/core";
import { queueConnection } from "./connection.js";
import type { JobPayload } from "./job-types.js";

const require = createRequire(import.meta.url);

export interface WorkerConfig {
  connection: { host: string; port: number; password?: string; db?: number; tls?: boolean } | string;
  queueName?: string;
  concurrency?: number;
  agentRegistry: Record<string, Agent>;
  workflowRegistry?: Record<string, Workflow<any>>;
  teamRegistry?: Record<string, import("@agentium/core").Team>;
}

export class AgentWorker {
  private worker: any;

  constructor(config: WorkerConfig) {
    const legacy = config as unknown as { attempts?: unknown; backoffDelay?: unknown };
    if (legacy.attempts !== undefined || legacy.backoffDelay !== undefined)
      throw new Error(
        "Configure retries on AgentQueue defaultJobOptions or enqueue options; Worker retry options never controlled jobs",
      );
    const queueName = config.queueName ?? "agentium-jobs";
    const concurrency = config.concurrency ?? 5;
    const connection = queueConnection(config.connection);

    try {
      const { Worker } = require("bullmq");

      this.worker = new Worker(
        queueName,
        async (job: any) => {
          const payload = job.data as JobPayload;

          if (payload.type === "agent") {
            const agent = config.agentRegistry[payload.agentName];
            if (!agent) {
              throw new Error(`Agent "${payload.agentName}" not found in registry`);
            }

            const runId = randomUUID();
            let progress = 0;
            let progressWrites = Promise.resolve();
            const onChunk = (event: { runId: string }) => {
              if (event.runId !== runId) return;
              const next = ++progress;
              progressWrites = progressWrites.then(() => job.updateProgress(next)).catch(() => {});
            };
            agent.eventBus.on("run.stream.chunk", onChunk);

            try {
              const result = await agent.run(payload.input, {
                runId,
                sessionId: payload.sessionId,
                userId: payload.userId,
                tenantId: payload.tenantId,
              });
              return result;
            } finally {
              agent.eventBus.off("run.stream.chunk", onChunk);
              await progressWrites;
            }
          }

          if (payload.type === "workflow") {
            const workflow = config.workflowRegistry?.[payload.workflowName];
            if (!workflow) {
              throw new Error(`Workflow "${payload.workflowName}" not found in registry`);
            }

            const result = await workflow.run({
              sessionId: payload.sessionId,
              initialState: payload.initialState,
              userId: payload.userId,
              tenantId: payload.tenantId,
            });
            return result;
          }

          if (payload.type === "team") {
            const team = config.teamRegistry?.[payload.teamName];
            if (!team) {
              throw new Error(`Team "${payload.teamName}" not found in registry`);
            }

            const result = await team.run(payload.input, {
              sessionId: payload.sessionId,
              userId: payload.userId,
              tenantId: payload.tenantId,
            });
            return result;
          }

          throw new Error(`Unknown job type: ${(payload as any).type}`);
        },
        {
          connection,
          concurrency,
        },
      );
    } catch (err: any) {
      if (err?.code === "MODULE_NOT_FOUND" || err?.message?.includes("Cannot find module")) {
        throw new Error("bullmq and ioredis are required for AgentWorker. Install them: npm install bullmq ioredis");
      }
      throw err;
    }
  }

  start(): void {
    // Worker starts automatically on construction in BullMQ
  }

  async stop(timeoutMs = 30000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.worker.close(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Worker drain timeout")), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
