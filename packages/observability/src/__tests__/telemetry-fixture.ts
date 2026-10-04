import type { Trace } from "../types.js";
export const output = {
  text: "PRIVATE_OUTPUT",
  toolCalls: [],
  usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
};
export function fixtureTrace(): Trace {
  return {
    traceId: "a".repeat(32),
    rootSpanId: "b".repeat(16),
    startTime: 1700000000000,
    endTime: 1700000000001,
    metadata: { agentName: "demo", sessionId: "s", input: "PRIVATE_PROMPT" },
    spans: [
      {
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        name: "agent.run",
        kind: "agent",
        startTime: 1700000000000,
        endTime: 1700000000001,
        status: "ok",
        attributes: { agentName: "demo", input: "PRIVATE_PROMPT", output: "PRIVATE_OUTPUT", password: "SECRET" },
        events: [],
      },
    ],
  };
}
