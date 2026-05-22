import { describe, expect, it } from "vitest";
import type { AgentJobPayload, WorkflowJobPayload } from "../job-types.js";

describe("AgentQueue job payloads", () => {
  it("agent job payload has correct shape", () => {
    const payload: AgentJobPayload = {
      type: "agent",
      agentName: "assistant",
      input: "Hello",
      sessionId: "s1",
      userId: "u1",
    };

    expect(payload.type).toBe("agent");
    expect(payload.agentName).toBe("assistant");
    expect(payload.input).toBe("Hello");
  });

  it("workflow job payload has correct shape", () => {
    const payload: WorkflowJobPayload = {
      type: "workflow",
      workflowName: "onboarding",
      initialState: { step: 1 },
      sessionId: "s1",
    };

    expect(payload.type).toBe("workflow");
    expect(payload.workflowName).toBe("onboarding");
  });
});
