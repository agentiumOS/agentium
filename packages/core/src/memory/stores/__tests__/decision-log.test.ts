import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorage } from "../../../storage/in-memory.js";
import { DecisionLog } from "../decision-log.js";

describe("DecisionLog", () => {
  let storage: InMemoryStorage;
  let log: DecisionLog;

  beforeEach(() => {
    storage = new InMemoryStorage();
    log = new DecisionLog(storage);
  });

  it("logs a decision", async () => {
    const decision = await log.logDecision("test-agent", {
      decision: "Used search_kb",
      reasoning: "User question matched known docs",
      decisionType: "tool_selection",
    });
    expect(decision.id).toBeDefined();
    expect(decision.agentName).toBe("test-agent");
    expect(decision.decision).toBe("Used search_kb");
  });

  it("retrieves decisions", async () => {
    await log.logDecision("agent", { decision: "A", reasoning: "R1", decisionType: "approach" });
    await log.logDecision("agent", { decision: "B", reasoning: "R2", decisionType: "approach" });
    const decisions = await log.getDecisions("agent");
    expect(decisions).toHaveLength(2);
    const names = decisions.map((d) => d.decision).sort();
    expect(names).toEqual(["A", "B"]);
  });

  it("limits decisions with limit param", async () => {
    for (let i = 0; i < 10; i++) {
      await log.logDecision("agent", { decision: `D${i}`, reasoning: "R", decisionType: "other" });
    }
    const limited = await log.getDecisions("agent", 3);
    expect(limited).toHaveLength(3);
  });

  it("records outcome on a decision", async () => {
    const d = await log.logDecision("agent", {
      decision: "Chose option A",
      reasoning: "Seemed better",
      decisionType: "approach",
    });
    await log.recordOutcome("agent", d.id, "User was satisfied", "good");

    const decisions = await log.getDecisions("agent");
    expect(decisions[0].outcome).toBe("User was satisfied");
    expect(decisions[0].outcomeQuality).toBe("good");
  });

  it("searches decisions by keyword", async () => {
    await log.logDecision("agent", { decision: "Used Kafka", reasoning: "High throughput", decisionType: "approach" });
    await log.logDecision("agent", { decision: "Used Redis", reasoning: "Low latency", decisionType: "approach" });

    const results = await log.searchDecisions("agent", "Kafka");
    expect(results).toHaveLength(1);
    expect(results[0].decision).toBe("Used Kafka");
  });

  it("generates context string", async () => {
    await log.logDecision("agent", {
      decision: "Chose tool X",
      reasoning: "Best fit",
      decisionType: "tool_selection",
    });
    const ctx = await log.getContextString("agent");
    expect(ctx).toContain("Recent decisions:");
    expect(ctx).toContain("Chose tool X");
  });

  it("returns tools", () => {
    const tools = log.getTools();
    expect(tools).toHaveLength(3);
    const names = tools.map((t) => t.name);
    expect(names).toContain("log_decision");
    expect(names).toContain("record_outcome");
    expect(names).toContain("search_decisions");
  });

  it("clears decisions for an agent", async () => {
    await log.logDecision("agent", { decision: "D1", reasoning: "R", decisionType: "other" });
    await log.clear("agent");
    const decisions = await log.getDecisions("agent");
    expect(decisions).toHaveLength(0);
  });
});
