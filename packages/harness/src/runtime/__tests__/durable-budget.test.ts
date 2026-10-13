import type { ModelProvider } from "@agentium/core";
import { describe, expect, it } from "vitest";
import { HarnessBudgetLedger } from "../budget.js";
import { type ExecutionDriver, HarnessRuntime } from "../driver.js";

describe("durable root budget accounting", () => {
  it("restores completed charges and deduplicates the same logical tool admission", () => {
    const limits = { maxModelCalls: 2, maxToolCalls: 2, maxTokens: 20 };
    const ledger = new HarnessBudgetLedger(limits);
    expect(ledger.admitTool("node/call")).toBe(true);
    const call = ledger.reserve(2, 4);
    call.start();
    call.settle({ promptTokens: 2, completionTokens: 1, totalTokens: 3 });
    const restored = new HarnessBudgetLedger(limits, ledger.exportState());
    expect(restored.admitTool("node/call")).toBe(true);
    expect(restored.admitTool("other/call")).toBe(true);
    expect(restored.admitTool("third/call")).toBe(false);
    expect(restored.snapshot()).toMatchObject({
      tokens: { used: 3, reserved: 0 },
      modelCalls: { used: 1 },
      toolCalls: { used: 2 },
    });
  });

  it("charges interrupted reservations conservatively without replenishing allowances", () => {
    const limits = { maxModelCalls: 1, maxTokens: 10 };
    const ledger = new HarnessBudgetLedger(limits);
    const call = ledger.reserve(2, 4);
    call.start();
    const restored = new HarnessBudgetLedger(limits, ledger.exportState());
    expect(restored.snapshot()).toMatchObject({
      tokens: { used: 6, reserved: 0, remaining: 4 },
      modelCalls: { used: 1, reserved: 0, remaining: 0 },
      unknownUsageCalls: 1,
    });
    expect(() => restored.reserve(1, 1)).toThrow("budget");
  });

  it("retains protected finishing charges after an interrupted finishing call", () => {
    const limits = { maxModelCalls: 3, maxTokens: 20, finishingModelCalls: 1, finishingTokens: 6 };
    const ledger = new HarnessBudgetLedger(limits);
    const call = ledger.reserve(2, 4, true);
    call.start();
    const restored = new HarnessBudgetLedger(limits, ledger.exportState());
    expect(restored.snapshot()).toMatchObject({
      tokens: { used: 6, finishingReserved: 0 },
      modelCalls: { used: 1, finishingReserved: 0 },
    });
  });

  it("rejects changed limits and corrupt persisted counters", () => {
    const ledger = new HarnessBudgetLedger({ maxToolCalls: 2 });
    const state = ledger.exportState();
    expect(() => new HarnessBudgetLedger({ maxToolCalls: 3 }, state)).toThrow();
    expect(() => new HarnessBudgetLedger({ maxToolCalls: 2 }, { ...state, usedTools: -1 })).toThrow();
  });
});

it("persists model charges before provider dispatch and settled usage before completion", async () => {
  const saved: ReturnType<HarnessBudgetLedger["exportState"]>[] = [];
  const provider: ModelProvider = {
    providerId: "offline",
    modelId: "durable-budget",
    async generate() {
      expect(saved.at(-1)).toMatchObject({ usedCalls: 1, reservedTokens: 6, activeCalls: 1 });
      return {
        message: { role: "assistant", content: "done" },
        usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
        finishReason: "stop",
        raw: null,
      };
    },
    // biome-ignore lint/correctness/useYield: this fixture rejects streaming.
    async *stream() {
      throw new Error("Unused");
    },
  };
  const driver: ExecutionDriver = {
    id: "persist-budget",
    version: 1,
    capabilities: { controlledExecution: true, policyCoverage: "local", controls: [], durable: false },
    async start(_request, services) {
      const response = await services.model(provider, [{ role: "user", content: "task" }], { maxTokens: 4 });
      return { text: typeof response.message.content === "string" ? response.message.content : "" };
    },
  };
  const runtime = new HarnessRuntime({
    driver,
    grants: { toolIds: [], modelRoles: ["main"] },
    budgets: { maxModelCalls: 1, maxTokens: 10 },
    estimateInputTokens: () => 2,
  });
  const result = await runtime.run("task", {
    identity: { tenantId: "tenant", userId: "actor" },
    sessionId: "budget",
    recovery: {
      persistBudget: async (state) => {
        saved.push(state);
      },
    },
  });
  expect(result.status).toBe("completed");
  expect(saved.at(-1)).toMatchObject({ usedCalls: 1, usedTokens: 3, reservedTokens: 0, activeCalls: 0 });
});
