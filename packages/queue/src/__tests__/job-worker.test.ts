import { describe, expect, it, vi } from "vitest";
import type { JobPayload } from "../job-types.js";
import { AgentWorker, type WorkerConfig } from "../job-worker.js";

it("rejects removed JavaScript worker retry fields before connection configuration", () => {
  const connection = vi.fn(() => {
    throw new Error("Connection must not be read");
  });
  for (const unsupported of [{ attempts: 3 }, { backoffDelay: 1000 }, { attempts: 0 }, { backoffDelay: null }]) {
    const config = {
      ...unsupported,
      agentRegistry: {},
      get connection() {
        return connection();
      },
    } as unknown as WorkerConfig;
    expect(() => new AgentWorker(config)).toThrow(/Configure retries on AgentQueue/);
  }
  expect(connection).not.toHaveBeenCalled();
});

describe("Queue job type guards", () => {
  it("agent job has type 'agent'", () => {
    const job: JobPayload = {
      type: "agent",
      agentName: "bot",
      input: "hello",
    };

    expect(job.type).toBe("agent");
    if (job.type === "agent") {
      expect(job.agentName).toBe("bot");
    }
  });

  it("workflow job has type 'workflow'", () => {
    const job: JobPayload = {
      type: "workflow",
      workflowName: "flow1",
    };

    expect(job.type).toBe("workflow");
    if (job.type === "workflow") {
      expect(job.workflowName).toBe("flow1");
    }
  });
});
