import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";
import { HarnessRuntime } from "../driver.js";
import type { ExecutionDriver } from "../types.js";

const start = { identity: { tenantId: "fixture", userId: "fixture" }, sessionId: "effect-budget" };

describe.each(["dispatch", "dispatchEffect"] as const)("single admission through %s", (port) => {
  it("executes one granted operation with exactly one remaining tool admission", async () => {
    let effects = 0;
    const policy = vi.fn(async () => ({ action: "allow" as const }));
    const driver: ExecutionDriver = {
      id: "effect-budget",
      version: 1,
      capabilities: { controlledExecution: true, policyCoverage: "local", controls: [], durable: false },
      async start(_request, services) {
        if (port === "dispatchEffect") {
          const value = await services.dispatchEffect("apply", {}, async () => {
            effects++;
            return "applied";
          });
          return { text: value };
        }
        const result = await services.dispatch({ id: "one", name: "apply", arguments: {} });
        return { text: result.result, status: result.error ? "failed" : "completed" };
      },
    };
    const runtime = new HarnessRuntime({
      driver,
      tools: [
        {
          name: "apply",
          description: "isolated counter",
          parameters: z.object({}),
          execute: async () => {
            effects++;
            return "applied";
          },
        },
      ],
      grants: { toolIds: ["apply"], modelRoles: [] },
      budgets: { maxToolCalls: 1 },
      executionPolicy: { decide: policy },
    });
    const result = await runtime.run("apply", start);
    expect(result.status).toBe("completed");
    expect(result.text).toBe("applied");
    expect(effects).toBe(1);
    expect(result.budget?.toolCalls.used).toBe(1);
    expect(policy).toHaveBeenCalledTimes(1);
  });

  it("continues to enforce the host denial through the context policy", async () => {
    const effect = vi.fn(async () => "applied");
    const driver: ExecutionDriver = {
      id: "denial",
      version: 1,
      capabilities: { controlledExecution: true, policyCoverage: "local", controls: [], durable: false },
      async start(_request, services) {
        if (port === "dispatchEffect") {
          await services.dispatchEffect("apply", {}, effect);
          return { text: "unexpected" };
        }
        const result = await services.dispatch({ id: "one", name: "apply", arguments: {} });
        return { text: result.result, status: result.error ? "failed" : "completed" };
      },
    };
    const runtime = new HarnessRuntime({
      driver,
      tools: [{ name: "apply", description: "isolated counter", parameters: z.object({}), execute: effect }],
      grants: { toolIds: ["apply"], modelRoles: [] },
      budgets: { maxToolCalls: 1 },
      executionPolicy: { decide: () => ({ action: "deny", reason: "Host refused" }) },
    });
    expect((await runtime.run("apply", start)).status).toBe("failed");
    expect(effect).not.toHaveBeenCalled();
  });
});
