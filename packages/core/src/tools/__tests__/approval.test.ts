import { describe, expect, it } from "vitest";
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
