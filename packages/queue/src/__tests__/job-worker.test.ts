import { describe, expect, it } from "vitest";
import type { JobPayload } from "../job-types.js";

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
