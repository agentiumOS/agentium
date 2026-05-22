import { describe, expect, it } from "vitest";
import { CostTracker } from "../cost-tracker.js";

describe("CostTracker", () => {
  it("tracks a cost entry with calculated cost", () => {
    const tracker = new CostTracker();
    const entry = tracker.track({
      runId: "r1",
      agentName: "assistant",
      modelId: "gpt-4o",
      usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
    });

    expect(entry.cost).toBeGreaterThan(0);
    expect(entry.timestamp).toBeInstanceOf(Date);
  });

  it("calculates cost based on model pricing", () => {
    const tracker = new CostTracker({
      pricing: {
        "test-model": { promptPer1k: 1.0, completionPer1k: 2.0 },
      },
    });

    const entry = tracker.track({
      runId: "r1",
      agentName: "a",
      modelId: "test-model",
      usage: { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 },
    });

    expect(entry.cost).toBe(3.0);
  });

  it("returns zero cost for unknown models", () => {
    const tracker = new CostTracker();
    const entry = tracker.track({
      runId: "r1",
      agentName: "a",
      modelId: "unknown-model-xyz",
      usage: { promptTokens: 100, completionTokens: 100, totalTokens: 200 },
    });

    expect(entry.cost).toBe(0);
  });

  it("generates a summary by agent and model", () => {
    const tracker = new CostTracker({
      pricing: { m1: { promptPer1k: 1.0, completionPer1k: 1.0 } },
    });

    tracker.track({
      runId: "r1",
      agentName: "a",
      modelId: "m1",
      usage: { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 },
    });
    tracker.track({
      runId: "r2",
      agentName: "b",
      modelId: "m1",
      usage: { promptTokens: 500, completionTokens: 500, totalTokens: 1000 },
    });

    const summary = tracker.getSummary();
    expect(summary.entries).toBe(2);
    expect(summary.totalCost).toBe(3.0);
    expect(summary.byAgent.a.runs).toBe(1);
    expect(summary.byAgent.b.runs).toBe(1);
    expect(summary.byModel.m1.tokens.totalTokens).toBe(3000);
  });

  it("filters summary by agent name", () => {
    const tracker = new CostTracker({
      pricing: { m1: { promptPer1k: 1.0, completionPer1k: 1.0 } },
    });

    tracker.track({
      runId: "r1",
      agentName: "a",
      modelId: "m1",
      usage: { promptTokens: 1000, completionTokens: 0, totalTokens: 1000 },
    });
    tracker.track({
      runId: "r2",
      agentName: "b",
      modelId: "m1",
      usage: { promptTokens: 2000, completionTokens: 0, totalTokens: 2000 },
    });

    const summary = tracker.getSummary({ agentName: "a" });
    expect(summary.entries).toBe(1);
    expect(summary.totalCost).toBe(1.0);
  });

  it("enforces session budget", () => {
    const tracker = new CostTracker({
      pricing: { m1: { promptPer1k: 10.0, completionPer1k: 10.0 } },
      budget: { maxCostPerSession: 5.0, onBudgetExceeded: "throw" },
    });

    tracker.track({
      runId: "r1",
      agentName: "a",
      modelId: "m1",
      sessionId: "s1",
      usage: { promptTokens: 1000, completionTokens: 0, totalTokens: 1000 },
    });

    expect(() => tracker.checkBudget("r2", "s1")).toThrow("Session budget exceeded");
  });

  it("enforces user budget", () => {
    const tracker = new CostTracker({
      pricing: { m1: { promptPer1k: 10.0, completionPer1k: 10.0 } },
      budget: { maxCostPerUser: 5.0, onBudgetExceeded: "throw" },
    });

    tracker.track({
      runId: "r1",
      agentName: "a",
      modelId: "m1",
      userId: "u1",
      usage: { promptTokens: 1000, completionTokens: 0, totalTokens: 1000 },
    });

    expect(() => tracker.checkBudget("r2", undefined, "u1")).toThrow("User budget exceeded");
  });

  it("does not throw when budget not exceeded", () => {
    const tracker = new CostTracker({
      pricing: { m1: { promptPer1k: 0.001, completionPer1k: 0.001 } },
      budget: { maxCostPerSession: 100.0, onBudgetExceeded: "throw" },
    });

    tracker.track({
      runId: "r1",
      agentName: "a",
      modelId: "m1",
      sessionId: "s1",
      usage: { promptTokens: 100, completionTokens: 100, totalTokens: 200 },
    });

    expect(() => tracker.checkBudget("r2", "s1")).not.toThrow();
  });

  it("provides per-category cost breakdown", () => {
    const tracker = new CostTracker({
      pricing: {
        "test-reasoning": { promptPer1k: 1.0, completionPer1k: 2.0, reasoningPer1k: 3.0, cachedPromptPer1k: 0.25 },
      },
    });

    const entry = tracker.track({
      runId: "r1",
      agentName: "a",
      modelId: "test-reasoning",
      usage: {
        promptTokens: 2000,
        completionTokens: 500,
        totalTokens: 3000,
        reasoningTokens: 500,
        cachedTokens: 1000,
      },
    });

    // non-cached prompt = 2000 - 1000 = 1000 tokens
    expect(entry.breakdown.input).toBeCloseTo(1.0); // 1000/1000 * 1.0
    expect(entry.breakdown.output).toBeCloseTo(1.0); // 500/1000 * 2.0
    expect(entry.breakdown.reasoning).toBeCloseTo(1.5); // 500/1000 * 3.0
    expect(entry.breakdown.cached).toBeCloseTo(0.25); // 1000/1000 * 0.25
    expect(entry.breakdown.total).toBeCloseTo(3.75);
    expect(entry.cost).toBeCloseTo(3.75);
  });

  it("includes breakdown in summary", () => {
    const tracker = new CostTracker({
      pricing: { m1: { promptPer1k: 1.0, completionPer1k: 2.0 } },
    });

    tracker.track({
      runId: "r1",
      agentName: "a",
      modelId: "m1",
      usage: { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 },
    });

    const summary = tracker.getSummary();
    expect(summary.totalBreakdown.input).toBeCloseTo(1.0);
    expect(summary.totalBreakdown.output).toBeCloseTo(2.0);
    expect(summary.totalBreakdown.total).toBeCloseTo(3.0);
    expect(summary.byAgent.a.breakdown.total).toBeCloseTo(3.0);
    expect(summary.byModel.m1.breakdown.total).toBeCloseTo(3.0);
  });

  it("handles audio token pricing", () => {
    const tracker = new CostTracker({
      pricing: {
        "audio-model": {
          promptPer1k: 0.005,
          completionPer1k: 0.02,
          audioInputPer1k: 0.04,
          audioOutputPer1k: 0.08,
        },
      },
    });

    const entry = tracker.track({
      runId: "r1",
      agentName: "a",
      modelId: "audio-model",
      usage: {
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
        audioInputTokens: 2000,
        audioOutputTokens: 1000,
      },
    });

    expect(entry.breakdown.input).toBeCloseTo(0.005);
    expect(entry.breakdown.output).toBeCloseTo(0.01);
    expect(entry.breakdown.audioInput).toBeCloseTo(0.08);
    expect(entry.breakdown.audioOutput).toBeCloseTo(0.08);
    expect(entry.breakdown.total).toBeCloseTo(0.175);
  });

  it("resets all entries", () => {
    const tracker = new CostTracker();
    tracker.track({
      runId: "r1",
      agentName: "a",
      modelId: "m1",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
    expect(tracker.getEntries().length).toBe(1);

    tracker.reset();
    expect(tracker.getEntries().length).toBe(0);
  });
});
