import { describe, expect, it } from "vitest";
import { CostTracker } from "../cost/cost-tracker.js";

describe("CostTracker incremental", () => {
  it("track persists an entry", () => {
    const tracker = new CostTracker({
      budget: { maxCostPerRun: 1.0 },
    });

    tracker.track({
      runId: "r1",
      agentName: "bot",
      modelId: "gpt-4o",
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });

    const entries = tracker.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].runId).toBe("r1");
  });

  it("isBudgetExceeded returns true when over budget", () => {
    const tracker = new CostTracker({
      pricing: { "test-model": { promptPer1k: 10, completionPer1k: 10 } },
      budget: { maxCostPerRun: 0.001 },
    });

    tracker.track({
      runId: "r1",
      agentName: "bot",
      modelId: "test-model",
      usage: { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 },
    });

    expect(tracker.isBudgetExceeded("r1")).toBe(true);
  });

  it("isBudgetExceeded returns false when under budget", () => {
    const tracker = new CostTracker({
      budget: { maxCostPerRun: 100.0 },
    });

    tracker.track({
      runId: "r1",
      agentName: "bot",
      modelId: "gpt-4o",
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });

    expect(tracker.isBudgetExceeded("r1")).toBe(false);
  });

  it("estimateRemaining returns budget headroom", () => {
    const tracker = new CostTracker({
      budget: { maxTokensPerRun: 10000 },
    });

    tracker.track({
      runId: "r1",
      agentName: "bot",
      modelId: "gpt-4o",
      usage: { promptTokens: 3000, completionTokens: 2000, totalTokens: 5000 },
    });

    const remaining = tracker.estimateRemaining("r1");
    expect(remaining.tokensRemaining).toBe(5000);
  });

  it("estimateRemaining returns null when no budget", () => {
    const tracker = new CostTracker();
    const remaining = tracker.estimateRemaining("r1");
    expect(remaining.costRemaining).toBeNull();
    expect(remaining.tokensRemaining).toBeNull();
  });
});
