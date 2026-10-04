import type { ModelProvider, ToolDef } from "@agentium/core";
import { ApprovalManager, EventBus, RunContext } from "@agentium/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";
import { BrowserAgent } from "../browser-agent.js";
import type { BrowserAction, BrowserAgentConfig } from "../types.js";

const browser = vi.hoisted(() => ({
  launch: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  getPageInfo: vi.fn(async () => ({ url: "https://example.test", title: "Fixture" })),
  listTabs: vi.fn(() => []),
  screenshot: vi.fn(async () => Buffer.alloc(0)),
  click: vi.fn(async () => {}),
  navigate: vi.fn(async () => {}),
}));
vi.mock("../browser-provider.js", () => ({
  BrowserProvider: class {
    constructor() {
      // biome-ignore lint/correctness/noConstructorReturn: injected browser double preserves shared spies.
      return browser;
    }
  },
}));
beforeEach(() => vi.clearAllMocks());

function fixture(overrides: Partial<BrowserAgentConfig> = {}, args: unknown = { value: "valid" }) {
  const execute = vi.fn(async () => "effect completed");
  const tool: ToolDef = {
    name: "effect",
    description: "Test effect",
    parameters: z.object({ value: z.string() }),
    execute,
  };
  const action: BrowserAction = { action: "tool", name: "effect", args: args as Record<string, unknown> };
  const generate = vi.fn(async (_messages?: unknown, _options?: { signal?: AbortSignal }) => ({
    message: {
      role: "assistant",
      content: JSON.stringify({ action: [action, { action: "done", result: "finished" }] }),
    },
  }));
  const model = { providerId: "fixture", modelId: "fixture", generate } as unknown as ModelProvider;
  const agent = new BrowserAgent({
    name: "browser-test",
    model,
    tools: [tool],
    maxSteps: 1,
    useVision: false,
    useDOM: false,
    waitAfterAction: 0,
    ...overrides,
  });
  return { agent, execute, tool, generate };
}

describe("BrowserAgent custom tool boundary", () => {
  it("forwards planner cancellation and refuses a late successful action", async () => {
    const controller = new AbortController();
    const f = fixture();
    f.generate.mockImplementationOnce(async (_messages, options) => {
      expect(options?.signal).toBe(controller.signal);
      controller.abort();
      return { message: { role: "assistant", content: JSON.stringify({ action: "done", result: "late" }) } };
    });
    const result = await f.agent.run("Do work", { signal: controller.signal });
    expect(result.success).toBe(false);
    expect(f.execute).not.toHaveBeenCalled();
    expect(result.result).not.toBe("late");
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("does not start a fallback model after the primary is cancelled", async () => {
    const controller = new AbortController();
    const fallback = vi.fn();
    const f = fixture({
      fallbackModel: { providerId: "fallback", modelId: "fallback", generate: fallback } as unknown as ModelProvider,
    });
    f.generate.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error("network timeout");
    });
    const result = await f.agent.run("Do work", { signal: controller.signal });
    expect(result.success).toBe(false);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("denies an explicitly approval-required tool without an approver", async () => {
    const f = fixture();
    f.tool.requiresApproval = true;
    const result = await f.agent.run("Use the registered tool");
    expect(f.execute).not.toHaveBeenCalled();
    expect(result.steps[0].ok).toBe(false);
  });

  it("validates arguments before effect execution and policy", async () => {
    const decide = vi.fn(() => ({ action: "allow" as const }));
    const f = fixture({ executionPolicy: { decide } }, { value: 123 });
    const result = await f.agent.run("Use the registered tool");
    expect(f.execute).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    expect(result.steps[0].ok).toBe(false);
  });

  it("enforces host deny even when the tool opts out of legacy approval", async () => {
    const f = fixture({ executionPolicy: { decide: () => ({ action: "deny", reason: "host restriction" }) } });
    f.tool.requiresApproval = false;
    const result = await f.agent.run("Use the registered tool");
    expect(f.execute).not.toHaveBeenCalled();
    expect(result.steps[0].ok).toBe(false);
  });

  it("executes once after synchronous public approval and inherits identity and cancellation", async () => {
    const eventBus = new EventBus();
    const f = fixture({ eventBus, approval: { policy: "all" } });
    const controller = new AbortController();
    eventBus.on("tool.approval.request", (request) => f.agent.approvalManager!.approve(request.requestId));
    const result = await f.agent.run("Use the registered tool", {
      sessionId: "session",
      userId: "actor",
      tenantId: "tenant",
      signal: controller.signal,
    });
    expect(result.steps[0].ok).toBe(true);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.execute).toHaveBeenCalledWith(
      { value: "valid" },
      expect.objectContaining({
        sessionId: "session",
        userId: "actor",
        tenantId: "tenant",
        signal: controller.signal,
      }),
    );
    expect(f.agent.approvalManager!.listPending()).toEqual([]);
  });

  it("forwards the parent context through asTool and retains mandatory parent policy", async () => {
    const f = fixture({ executionPolicy: { decide: () => ({ action: "allow" }) } });
    const controller = new AbortController();
    const parent = new RunContext({
      sessionId: "parent-session",
      userId: "parent-user",
      tenantId: "parent-tenant",
      signal: controller.signal,
      eventBus: new EventBus(),
      executionPolicy: { decide: () => ({ action: "deny" }) },
    });
    const run = vi.spyOn(f.agent, "run");
    await f.agent.asTool().execute({ task: "Use the registered tool" }, parent);
    expect(run).toHaveBeenCalledWith("Use the registered tool", { startUrl: undefined, context: parent });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("cancels pending approval without executing the tool", async () => {
    const eventBus = new EventBus();
    const controller = new AbortController();
    const f = fixture({ eventBus, approval: { policy: "all" } });
    eventBus.on("tool.approval.request", () => controller.abort());
    await f.agent.run("Use the registered tool", { signal: controller.signal });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.agent.approvalManager!.listPending()).toEqual([]);
  });

  it("rejects plan-mode native browser access before launch or model calls", async () => {
    const f = fixture({ initialActions: [{ action: "click", x: 10, y: 10 }] });
    const result = await f.agent.run("Click the page", { runMode: "plan", startUrl: "https://example.test" });
    expect(result.success).toBe(false);
    expect(result.result).toMatch(/plan mode/);
    expect(browser.launch).not.toHaveBeenCalled();
    expect(browser.navigate).not.toHaveBeenCalled();
    expect(browser.click).not.toHaveBeenCalled();
    expect(f.generate).not.toHaveBeenCalled();
  });
});

it("does not revoke an inherited parent's unrelated approval when browser work ends", async () => {
  const eventBus = new EventBus();
  const manager = new ApprovalManager({ policy: "all", eventBus });
  const parent = new RunContext({ sessionId: "parent-session", eventBus });
  const pendingParent = manager.check("parent-tool", {}, parent, "parent-agent");
  const parentRequest = manager.listPending()[0];
  const f = fixture({ approvalManager: manager, eventBus });
  // Browser's custom tool is independently exempt; the parent's approval must outlive this delegation.
  f.tool.requiresApproval = false;
  try {
    await f.agent.asTool().execute({ task: "Use the registered tool" }, parent);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(manager.listPending().map((request) => request.requestId)).toEqual([parentRequest.requestId]);
  } finally {
    manager.deny(parentRequest.requestId, "test cleanup");
    await pendingParent;
  }
});
