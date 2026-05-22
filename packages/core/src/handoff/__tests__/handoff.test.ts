import { describe, expect, it, vi } from "vitest";
import { RunContext } from "../../agent/run-context.js";
import { EventBus } from "../../events/event-bus.js";
import { HandoffManager } from "../handoff-manager.js";
import { createCompleteTool, createHandoffTool } from "../handoff-tool.js";
import { HandoffSignal } from "../types.js";

function mockAgent(name: string, response: string, throwHandoff?: HandoffSignal) {
  return {
    name,
    instructions: `I am ${name}`,
    run: vi.fn().mockImplementation(async () => {
      if (throwHandoff) throw throwHandoff;
      return {
        text: response,
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
    }),
  } as any;
}

describe("HandoffSignal", () => {
  it("carries target agent and reason", () => {
    const signal = new HandoffSignal("billing", "needs payment help");
    expect(signal.targetAgent).toBe("billing");
    expect(signal.reason).toBe("needs payment help");
    expect(signal.name).toBe("HandoffSignal");
  });
});

describe("createHandoffTool", () => {
  it("creates a transfer_to_agent tool with target descriptions", () => {
    const agent1 = mockAgent("billing", "");
    const agent2 = mockAgent("support", "");
    const tool = createHandoffTool([
      { agent: agent1, description: "Handles billing" },
      { agent: agent2, description: "General support" },
    ]);

    expect(tool.name).toBe("transfer_to_agent");
    expect(tool.description).toContain("billing");
    expect(tool.description).toContain("support");
  });

  it("throws HandoffSignal when executed", async () => {
    const agent = mockAgent("billing", "");
    const tool = createHandoffTool([{ agent, description: "Billing" }]);
    const ctx = new RunContext({
      sessionId: "s1",
      metadata: {},
      eventBus: new EventBus(),
      sessionState: {},
    });

    await expect(tool.execute({ agent: "billing", reason: "needs help" }, ctx)).rejects.toThrow(HandoffSignal);
  });
});

describe("createCompleteTool", () => {
  it("returns a summary string", async () => {
    const tool = createCompleteTool();
    const ctx = new RunContext({
      sessionId: "s1",
      metadata: {},
      eventBus: new EventBus(),
      sessionState: {},
    });
    const result = await tool.execute({ summary: "Done" }, ctx);
    expect(result).toContain("Done");
  });
});

describe("HandoffManager", () => {
  it("executes handoff to target agent", async () => {
    const billing = mockAgent("billing", "Here is your invoice");
    const manager = new HandoffManager({
      targets: [{ agent: billing, description: "Billing" }],
    });

    const signal = new HandoffSignal("billing", "payment question");
    const ctx = new RunContext({
      sessionId: "s1",
      metadata: {},
      eventBus: new EventBus(),
      sessionState: {},
    });

    const result = await manager.execute(
      signal,
      "main",
      "How much do I owe?",
      [{ role: "user", content: "How much do I owe?" }],
      ctx,
      ctx.eventBus,
    );

    expect(result.text).toBe("Here is your invoice");
    expect(result.handoffChain).toEqual(["main", "billing"]);
    expect(result.finalAgent).toBe("billing");
    expect(billing.run).toHaveBeenCalledOnce();
  });

  it("handles chained handoffs", async () => {
    const billing = mockAgent("billing", "", new HandoffSignal("escalation", "complex issue"));
    const escalation = mockAgent("escalation", "Escalated and resolved");

    const manager = new HandoffManager({
      targets: [
        { agent: billing, description: "Billing" },
        { agent: escalation, description: "Escalation" },
      ],
    });

    const signal = new HandoffSignal("billing", "payment");
    const ctx = new RunContext({
      sessionId: "s1",
      metadata: {},
      eventBus: new EventBus(),
      sessionState: {},
    });

    const result = await manager.execute(
      signal,
      "main",
      "help",
      [{ role: "user", content: "help" }],
      ctx,
      ctx.eventBus,
    );

    expect(result.handoffChain).toEqual(["main", "billing", "escalation"]);
    expect(result.finalAgent).toBe("escalation");
    expect(result.text).toBe("Escalated and resolved");
  });

  it("throws when target not found", async () => {
    const manager = new HandoffManager({ targets: [] });
    const signal = new HandoffSignal("unknown", "test");
    const ctx = new RunContext({
      sessionId: "s1",
      metadata: {},
      eventBus: new EventBus(),
      sessionState: {},
    });

    await expect(manager.execute(signal, "main", "test", [], ctx, ctx.eventBus)).rejects.toThrow("not found");
  });

  it("respects maxHandoffs limit", async () => {
    const looper = mockAgent("looper", "", new HandoffSignal("looper", "loop"));
    const manager = new HandoffManager({
      targets: [{ agent: looper, description: "Loops" }],
      maxHandoffs: 2,
    });

    const signal = new HandoffSignal("looper", "start");
    const ctx = new RunContext({
      sessionId: "s1",
      metadata: {},
      eventBus: new EventBus(),
      sessionState: {},
    });

    await expect(manager.execute(signal, "main", "test", [], ctx, ctx.eventBus)).rejects.toThrow(
      "Handoff cycle detected",
    );
  });
});
