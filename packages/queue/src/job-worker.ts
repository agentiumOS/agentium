import type { Agent, Workflow } from "@agentium/core";
import type { JobPayload } from "./job-types.js";

export interface WorkerConfig {
  connection: { host: string; port: number; password?: string; db?: number; tls?: boolean } | string;
  queueName?: string;
  concurrency?: number;
  attempts?: number;
  backoffDelay?: number;
  agentRegistry: Record<string, Agent>;
  workflowRegistry?: Record<string, Workflow<any>>;
  teamRegistry?: Record<string, import("@agentium/core").Team>;
}

export class AgentWorker {
  private worker: any;

  constructor(config: WorkerConfig) {
    const queueName = config.queueName ?? "agentium:jobs";
    const concurrency = config.concurrency ?? 5;
    const connection = typeof config.connection === "string" ? { url: config.connection } : config.connection;
    const defaultJobOptions = {
      attempts: config.attempts ?? 3,
      backoff: {
        type: "exponential" as const,
        delay: config.backoffDelay ?? 1000,
      },
    };

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

            const onChunk = (_evt: any) => {
              job.updateProgress(typeof job.progress === "number" ? job.progress + 1 : 1);
            };
            agent.eventBus.on("run.stream.chunk", onChunk);

            try {
              const result = await agent.run(payload.input, {
                sessionId: payload.sessionId,
                userId: payload.userId,
              });
              return result;
            } finally {
              agent.eventBus.off("run.stream.chunk", onChunk);
            }
          }

          if (payload.type === "workflow") {
            const workflow = config.workflowRegistry?.[payload.workflowName];
            if (!workflow) {
              throw new Error(`Workflow "${payload.workflowName}" not found in registry`);
            }

            const result = await workflow.run({
              sessionId: payload.sessionId,
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
            });
            return result;
          }

          throw new Error(`Unknown job type: ${(payload as any).type}`);
        },
        {
          connection,
          concurrency,
          defaultJobOptions,
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
    await Promise.race([
      this.worker.close(),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("Worker drain timeout")), timeoutMs)),
    ]).catch((err) => {
      console.warn("[JobWorker] Error during stop:", err?.message ?? err);
    });
  }
}
