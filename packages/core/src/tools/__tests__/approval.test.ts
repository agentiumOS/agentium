import { afterEach, describe, expect, it, vi } from "vitest";
import { RunContext } from "../../agent/run-context.js";
import { EventBus } from "../../events/event-bus.js";
import { ApprovalManager } from "../approval.js";

function makeCtx(): RunContext {
  return new RunContext({
    sessionId: "test-session",
    eventBus: new EventBus(),
  });
}

describe("ApprovalManager.needsApproval", () => {
  it("returns false when policy is 'none'", () => {
    const mgr = new ApprovalManager({ policy: "none" });
    expect(mgr.needsApproval("anyTool", {})).toBe(false);
  });

  it("returns true when policy is 'all'", () => {
    const mgr = new ApprovalManager({ policy: "all" });
    expect(mgr.needsApproval("anyTool", {})).toBe(true);
  });

  it("returns true when tool is in policy array", () => {
    const mgr = new ApprovalManager({ policy: ["deleteTool"] });
    expect(mgr.needsApproval("deleteTool", {})).toBe(true);
    expect(mgr.needsApproval("readTool", {})).toBe(false);
  });

  it("per-tool requiresApproval: true overrides policy", () => {
    const mgr = new ApprovalManager({ policy: "none" });
    expect(mgr.needsApproval("tool", {}, true)).toBe(true);
  });

  it("per-tool requiresApproval: false overrides policy", () => {
    const mgr = new ApprovalManager({ policy: "all" });
    expect(mgr.needsApproval("tool", {}, false)).toBe(false);
  });

  it("per-tool requiresApproval function is called with args", () => {
    const mgr = new ApprovalManager({ policy: "none" });
    const fn = (args: Record<string, unknown>) => args.force === true;
    expect(mgr.needsApproval("tool", { force: true }, fn)).toBe(true);
    expect(mgr.needsApproval("tool", { force: false }, fn)).toBe(false);
  });
});

describe("ApprovalManager callback mode", () => {
  it("approves when callback returns approved: true", async () => {
    const mgr = new ApprovalManager({
      policy: "all",
      onApproval: async () => ({ approved: true, reason: "ok" }),
    });

    const decision = await mgr.check("tool", {}, makeCtx(), "agent");
    expect(decision.approved).toBe(true);
    expect(decision.reason).toBe("ok");
  });

  it("denies when callback returns approved: false", async () => {
    const mgr = new ApprovalManager({
      policy: "all",
      onApproval: async () => ({ approved: false, reason: "nope" }),
    });

    const decision = await mgr.check("tool", {}, makeCtx(), "agent");
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe("nope");
  });

  it("auto-denies on timeout", async () => {
    const mgr = new ApprovalManager({
      policy: "all",
      timeout: 100,
      onApproval: async () => {
        await new Promise((r) => setTimeout(r, 500));
        return { approved: true };
      },
    });

    const decision = await mgr.check("tool", {}, makeCtx(), "agent");
    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/timed out/i);
  });
});

describe("ApprovalManager event mode", () => {
  it("resolves when approve() is called externally", async () => {
    const bus = new EventBus();
    const mgr = new ApprovalManager({ policy: "all", eventBus: bus });

    bus.on("tool.approval.request", ({ requestId }) => {
      setTimeout(() => mgr.approve(requestId, "looks good"), 50);
    });

    const decision = await mgr.check("tool", {}, makeCtx(), "agent");
    expect(decision.approved).toBe(true);
    expect(decision.reason).toBe("looks good");
  });

  it("resolves when deny() is called externally", async () => {
    const bus = new EventBus();
    const mgr = new ApprovalManager({ policy: "all", eventBus: bus });

    bus.on("tool.approval.request", ({ requestId }) => {
      setTimeout(() => mgr.deny(requestId, "too risky"), 50);
    });

    const decision = await mgr.check("tool", {}, makeCtx(), "agent");
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe("too risky");
  });

  it("auto-denies on timeout in event mode", async () => {
    const mgr = new ApprovalManager({ policy: "all", timeout: 100 });

    const decision = await mgr.check("tool", {}, makeCtx(), "agent");
    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/timed out/i);
  });
});

describe("ApprovalManager lifecycle", () => {
  afterEach(() => vi.useRealTimers());

  it("registers before a synchronous event listener approves", async () => {
    const bus = new EventBus();
    const manager = new ApprovalManager({ policy: "all", eventBus: bus });
    bus.on("tool.approval.request", ({ requestId }) => {
      expect(manager.listPending()).toHaveLength(1);
      manager.approve(requestId);
    });
    expect((await manager.check("tool", {}, makeCtx(), "agent")).approved).toBe(true);
    expect(manager.listPending()).toEqual([]);
  });

  it("isolates concurrent runs and exposes scoped requests", async () => {
    const manager = new ApprovalManager({ policy: "all" });
    const first = new RunContext({ sessionId: "s1", runId: "r1", tenantId: "a", eventBus: new EventBus() });
    const second = new RunContext({ sessionId: "s2", runId: "r2", tenantId: "b", eventBus: new EventBus() });
    const p1 = manager.check("tool", {}, first, "agent");
    const p2 = manager.check("tool", {}, second, "agent");
    const [request] = manager.listPending({ tenantId: "a" });
    expect(request.runId).toBe("r1");
    manager.approve("unknown");
    manager.approve(request.requestId);
    expect((await p1).approved).toBe(true);
    expect(manager.listPending()).toHaveLength(1);
    manager.cancelRun("r1");
    expect(manager.listPending()).toHaveLength(1);
    manager.cancelRun("r2");
    expect((await p2).approved).toBe(false);
  });

  it("clears callback timers after completion and rejection", async () => {
    vi.useFakeTimers();
    const manager = new ApprovalManager({ policy: "all", onApproval: async () => ({ approved: true }) });
    await manager.check("tool", {}, makeCtx(), "agent");
    expect(vi.getTimerCount()).toBe(0);
    expect(manager.listPending()).toEqual([]);
    const failing = new ApprovalManager({
      policy: "all",
      onApproval: async () => {
        throw new Error("callback failed");
      },
    });
    await expect(failing.check("tool", {}, makeCtx(), "agent")).rejects.toThrow("callback failed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels pending callbacks and ignores late approval", async () => {
    vi.useFakeTimers();
    let complete!: (decision: { approved: boolean }) => void;
    const controller = new AbortController();
    const manager = new ApprovalManager({
      policy: "all",
      onApproval: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    });
    const promise = manager.check(
      "tool",
      {},
      new RunContext({ sessionId: "s", eventBus: new EventBus(), signal: controller.signal }),
      "agent",
    );
    controller.abort();
    expect((await promise).approved).toBe(false);
    complete({ approved: true });
    await Promise.resolve();
    expect(manager.listPending()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("close denies pending and future requests without timers", async () => {
    vi.useFakeTimers();
    const manager = new ApprovalManager({ policy: "all" });
    const promise = manager.check("tool", {}, makeCtx(), "agent");
    manager.close();
    expect((await promise).approved).toBe(false);
    expect((await manager.check("tool", {}, makeCtx(), "agent")).approved).toBe(false);
    expect(manager.listPending()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cleans pending state when a timeout is configured to throw", async () => {
    vi.useFakeTimers();
    const manager = new ApprovalManager({ policy: "all", timeout: 10, timeoutAction: "throw" });
    const result = expect(manager.check("tool", {}, makeCtx(), "agent")).rejects.toThrow("Approval timed out");
    await vi.advanceTimersByTimeAsync(10);
    await result;
    expect(manager.listPending()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
