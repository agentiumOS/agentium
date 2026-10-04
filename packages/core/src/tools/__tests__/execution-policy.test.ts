import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";
import { RunContext } from "../../agent/run-context.js";
import { EventBus } from "../../events/event-bus.js";
import type { ExecutionPolicy, RunMode, ToolEffect, ValidatedToolCall } from "../execution-policy.js";
import { ToolExecutor } from "../tool-executor.js";
import type { ToolDef } from "../types.js";

const call = { id: "call", name: "effect", arguments: { value: "valid" } };
function context(runMode: RunMode = "execute", executionPolicy?: ExecutionPolicy) {
  return new RunContext({ sessionId: "session", eventBus: new EventBus(), runMode, executionPolicy });
}
function fixture(overrides: Partial<ToolDef> = {}) {
  const execute = vi.fn(async () => "effect result");
  const transform = vi.fn(async (value) => value);
  return {
    execute,
    transform,
    tool: {
      name: "effect",
      description: "effect",
      parameters: z.object({ value: z.string() }),
      execute,
      toModelOutput: transform,
      ...overrides,
    } as ToolDef,
  };
}

describe("mandatory execution policy", () => {
  it("validates before policy, approval predicates, callbacks and execution", async () => {
    const predicate = vi.fn(() => true);
    const decide = vi.fn(() => ({ action: "allow" as const }));
    const approval = vi.fn(async () => ({ approved: true }));
    const f = fixture({ requiresApproval: predicate });
    const executor = new ToolExecutor([f.tool], {
      executionPolicy: { decide },
      approval: { policy: "all", onApproval: approval },
    });
    const [result] = await executor.executeAll([{ ...call, arguments: { value: 12 } }], context());
    expect(result.error).toMatch(/Invalid arguments/);
    for (const fn of [predicate, decide, approval, f.execute, f.transform]) expect(fn).not.toHaveBeenCalled();
  });

  it.each([true, () => true])(
    "fails closed without an approver for an explicit requirement",
    async (requiresApproval) => {
      const f = fixture({ requiresApproval });
      const [result] = await new ToolExecutor([f.tool]).executeAll([call], context());
      expect(result.denial).toBe("approval_required");
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.transform).not.toHaveBeenCalled();
    },
  );

  it("does not allow legacy exemption to override host deny or ask", async () => {
    for (const action of ["deny", "ask"] as const) {
      const f = fixture({ requiresApproval: false });
      const [result] = await new ToolExecutor([f.tool], { executionPolicy: { decide: () => ({ action }) } }).executeAll(
        [call],
        context(),
      );
      expect(result.denial).toBe(action === "deny" ? "policy" : "approval_required");
      expect(f.execute).not.toHaveBeenCalled();
    }
  });

  it("checks policy again before returning a previously cached result", async () => {
    let allowed = true;
    const f = fixture({ cache: { ttl: 10000 } });
    const executor = new ToolExecutor([f.tool], {
      executionPolicy: { decide: () => ({ action: allowed ? "allow" : "deny" }) },
    });
    expect((await executor.executeAll([call], context()))[0].result).toBe("effect result");
    allowed = false;
    expect((await executor.executeAll([call], context()))[0].denial).toBe("policy");
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.transform).toHaveBeenCalledTimes(1);
  });

  it.each(["write", "external", "execute"] as ToolEffect[])(
    "denies %s in plan mode even with an approving reviewer",
    async (effect) => {
      const f = fixture();
      const approval = vi.fn(async () => ({ approved: true }));
      const executor = new ToolExecutor([f.tool], {
        executionPolicy: { decide: () => ({ action: "allow" }), resolveEffect: () => effect },
        approval: { policy: "all", onApproval: approval },
      });
      expect((await executor.executeAll([call], context("plan")))[0].denial).toBe("policy");
      expect(approval).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
    },
  );

  it("reviews unknown effects, permits host-classified reads, and retains ordinary legacy execution", async () => {
    const f = fixture();
    expect((await new ToolExecutor([f.tool]).executeAll([call], context("plan")))[0].denial).toBe("approval_required");
    const reviewed = new ToolExecutor([f.tool], {
      approval: { policy: "none", onApproval: async () => ({ approved: true }) },
    });
    expect((await reviewed.executeAll([call], context("plan")))[0].error).toBeUndefined();
    const read = new ToolExecutor([f.tool], {
      executionPolicy: { decide: () => ({ action: "allow" }), resolveEffect: () => "read" },
    });
    expect((await read.executeAll([call], context("plan")))[0].error).toBeUndefined();
    await new ToolExecutor([f.tool]).executeAll([call], context());
    expect(f.execute).toHaveBeenCalledTimes(3);
  });

  it("combines inherited and local policies without widening either", async () => {
    for (const inheritedAction of ["deny", "ask"] as const) {
      const f = fixture({ requiresApproval: false });
      const executor = new ToolExecutor([f.tool], { executionPolicy: { decide: () => ({ action: "allow" }) } });
      const [result] = await executor.executeAll(
        [call],
        context("execute", { decide: () => ({ action: inheritedAction }) }),
      );
      expect(result.denial).toBe(inheritedAction === "deny" ? "policy" : "approval_required");
      expect(f.execute).not.toHaveBeenCalled();
    }
  });

  it("evaluates parsed defaults and rechecks cancellation after approval", async () => {
    const controller = new AbortController();
    const f = fixture({ parameters: z.object({ value: z.string().default("default") }) });
    const decide = vi.fn((_call: ValidatedToolCall) => ({ action: "ask" as const }));
    const executor = new ToolExecutor([f.tool], {
      executionPolicy: { decide },
      approval: {
        policy: "none",
        onApproval: async () => {
          controller.abort();
          return { approved: true };
        },
      },
    });
    const ctx = new RunContext({ sessionId: "session", eventBus: new EventBus(), signal: controller.signal });
    const [result] = await executor.executeAll([{ ...call, arguments: {} }], ctx);
    expect(decide.mock.calls[0][0].args).toEqual({ value: "default" });
    expect(result.error).toMatch(/cancelled/i);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it.each(["hook", "event", "approval"] as const)(
    "rejects nested argument mutation by a %s observer after authorization",
    async (observer) => {
      const f = fixture({ parameters: z.object({ target: z.object({ id: z.string() }) }) });
      const mutate = (args: unknown) => {
        (args as { target: { id: string } }).target.id = "unauthorized";
      };
      const executor = new ToolExecutor([f.tool], {
        executionPolicy: {
          decide: (call) => ({ action: (call.args.target as { id: string }).id === "approved" ? "allow" : "deny" }),
        },
        ...(observer === "hook" ? { onToolCall: async (_ctx, _name, args) => mutate(args) } : {}),
        ...(observer === "approval"
          ? {
              approval: {
                policy: "all" as const,
                onApproval: async (request) => {
                  mutate(request.args);
                  return { approved: true };
                },
              },
            }
          : {}),
      });
      const ctx = context();
      if (observer === "event") ctx.eventBus.on("tool.call", ({ args }) => mutate(args));
      const [result] = await executor.executeAll([{ ...call, arguments: { target: { id: "approved" } } }], ctx);
      expect(result.denial).toBe("policy");
      expect(result.error).toMatch(/arguments changed/);
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.transform).not.toHaveBeenCalled();
    },
  );

  it("preserves Zod-transformed dates for policies and tool execution", async () => {
    let date!: Date;
    const execute = vi.fn(async (args: Record<string, unknown>) => {
      expect(args.date).toBe(date);
      return (args.date as Date).toISOString();
    });
    const f = fixture({ parameters: z.object({ date: z.coerce.date() }), execute });
    const executor = new ToolExecutor([f.tool], {
      executionPolicy: {
        decide: (call) => {
          date = call.args.date as Date;
          expect(date).toBeInstanceOf(Date);
          return { action: "allow" };
        },
      },
    });
    const [result] = await executor.executeAll([{ ...call, arguments: { date: "2026-10-04" } }], context());
    expect(result.error).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not start a result transform when the executing tool cancels its run", async () => {
    const controller = new AbortController();
    const f = fixture({
      execute: async () => {
        controller.abort();
        return "complete";
      },
    });
    const ctx = new RunContext({ sessionId: "session", eventBus: new EventBus(), signal: controller.signal });
    const [result] = await new ToolExecutor([f.tool]).executeAll([call], ctx);
    expect(result.denial).toBe("cancelled");
    expect(f.transform).not.toHaveBeenCalled();
  });
});
