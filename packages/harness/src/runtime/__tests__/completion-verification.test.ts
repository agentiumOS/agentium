import type { ToolCallResult } from "@agentium/core";
import { describe, expect, it, vi } from "vitest";
import { verifiedCompletionPolicy } from "../../policies.js";
import { type ExecutionDriver, HarnessRuntime } from "../driver.js";

const start = { identity: { tenantId: "tenant", userId: "actor" }, sessionId: "proof" };
function driver(execute: ExecutionDriver["start"] = async () => ({ text: "All tests passed" })): ExecutionDriver {
  return {
    id: "verification",
    version: 1,
    capabilities: { controls: [], durable: false, controlledExecution: true, policyCoverage: "local" },
    start: execute,
  };
}
describe("completion verification", () => {
  it("rejects a claimed success when current host evidence is unavailable", async () => {
    const runtime = new HarnessRuntime({
      driver: driver(),
      grants: { toolIds: [], modelRoles: ["main"] },
      completionPolicy: verifiedCompletionPolicy({
        verifier: { verify: async () => ({ verdict: "unknown", reason: "No current test record" }) },
      }),
    });
    expect(await runtime.run("Finish", start)).toMatchObject({
      status: "stopped",
      text: "All tests passed",
      completion: { revision: 0, decision: { action: "stop", reason: "No current test record" } },
    });
  });
  it("retains current host evidence in the accepted result and event", async () => {
    const runtime = new HarnessRuntime({
      driver: driver(),
      grants: { toolIds: [], modelRoles: ["main"] },
      completionPolicy: verifiedCompletionPolicy({
        id: "tests",
        verifier: {
          verify: async () => ({
            verdict: "pass",
            reason: "Current artifact verified",
            evidence: ["artifact:revision-7:test-run-2"],
          }),
        },
      }),
    });
    const handle = runtime.start("Finish", start);
    const events = [];
    for await (const event of handle.events()) events.push(event.payload);
    expect(await handle.result()).toMatchObject({
      status: "completed",
      completion: {
        policyId: "tests",
        revision: 0,
        decision: { action: "accept", evidence: ["artifact:revision-7:test-run-2"] },
      },
    });
    expect(events).toContainEqual({
      type: "completion",
      policyId: "tests",
      revision: 0,
      action: "accept",
      reason: "Current artifact verified",
      evidence: ["artifact:revision-7:test-run-2"],
    });
  });
  it("fails closed for an invalid custom policy instead of accepting unknown actions", async () => {
    const runtime = new HarnessRuntime({
      driver: driver(),
      grants: { toolIds: [], modelRoles: ["main"] },
      completionPolicy: { id: "invalid", evaluate: async () => JSON.parse('{"action":"typo","reason":"bad"}') },
    });
    expect(await runtime.run("Finish", start)).toMatchObject({
      status: "failed",
      reason: { code: "invalid_completion" },
    });
  });
  it("rejects oversized evidence instead of truncating acceptance proof", async () => {
    const runtime = new HarnessRuntime({
      driver: driver(),
      grants: { toolIds: [], modelRoles: ["main"] },
      completionPolicy: {
        id: "oversized",
        evaluate: async () => ({ action: "accept", reason: "ok", evidence: ["x".repeat(9000)] }),
      },
    });
    expect(await runtime.run("Finish", start)).toMatchObject({
      status: "failed",
      reason: { code: "invalid_completion" },
    });
  });
  it("observes an applied effect after cancellation without running ordinary afterTool", async () => {
    const abort = new AbortController();
    let effects = 0;
    const observed = vi.fn<(result: ToolCallResult) => void>();
    const afterTool = vi.fn();
    const runtime = new HarnessRuntime({
      grants: { toolIds: ["apply"], modelRoles: ["main"] },
      definition: {
        kind: "local",
        abilities: [
          {
            instanceId: "observations",
            validate() {},
            describe: () => ({ toolNames: [], requirements: [] }),
            bind: async () => ({
              tools: [],
              middleware: [
                {
                  id: "observer",
                  observeToolSettlement: (result: ToolCallResult) => {
                    observed(result);
                  },
                  afterTool,
                },
              ],
            }),
          },
        ],
      },
      driver: driver(async (_request, services) => {
        await services.dispatchEffect("apply", {}, async () => {
          effects++;
          abort.abort("after applied effect");
          return {};
        });
        return { text: "should not finish" };
      }),
    });
    expect((await runtime.run("Apply", { ...start, signal: abort.signal })).status).toBe("cancelled");
    expect(effects).toBe(1);
    expect(observed).toHaveBeenCalledOnce();
    expect(observed.mock.calls[0]?.[0]).toMatchObject({ toolName: "apply", denial: "cancelled" });
    expect(afterTool).not.toHaveBeenCalled();
  });
});
