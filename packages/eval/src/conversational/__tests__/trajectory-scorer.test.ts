import { describe, expect, it } from "vitest";
import { scoreTrajectory } from "../trajectory-scorer.js";
import type { ConversationTurn } from "../types.js";

function makeTurns(toolCalls: string[][]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const tc of toolCalls) {
    turns.push({ role: "user", content: "test" });
    turns.push({ role: "assistant", content: "result", toolCalls: tc });
  }
  return turns;
}

describe("scoreTrajectory", () => {
  describe("requiredTools", () => {
    it("passes when all required tools are called", () => {
      const turns = makeTurns([["search", "format"], ["send_email"]]);
      const result = scoreTrajectory(turns, {
        requiredTools: ["search", "send_email"],
      });
      expect(result.pass).toBe(true);
      expect(result.requiredToolsPresent).toBe(true);
    });

    it("fails when required tools are missing", () => {
      const turns = makeTurns([["search"]]);
      const result = scoreTrajectory(turns, {
        requiredTools: ["search", "send_email"],
      });
      expect(result.pass).toBe(false);
      expect(result.requiredToolsPresent).toBe(false);
      expect(result.details).toContain("send_email");
    });
  });

  describe("orderedTools", () => {
    it("passes when tools are in correct order", () => {
      const turns = makeTurns([["search"], ["validate"], ["submit"]]);
      const result = scoreTrajectory(turns, {
        orderedTools: ["search", "validate", "submit"],
      });
      expect(result.pass).toBe(true);
      expect(result.orderedToolsMatch).toBe(true);
    });

    it("fails when tools are out of order", () => {
      const turns = makeTurns([["submit"], ["search"]]);
      const result = scoreTrajectory(turns, {
        orderedTools: ["search", "submit"],
      });
      expect(result.pass).toBe(false);
      expect(result.orderedToolsMatch).toBe(false);
    });

    it("passes with extra tools interspersed", () => {
      const turns = makeTurns([["search", "extra"], ["validate"], ["submit"]]);
      const result = scoreTrajectory(turns, {
        orderedTools: ["search", "validate", "submit"],
      });
      expect(result.pass).toBe(true);
    });
  });

  describe("forbiddenTools", () => {
    it("passes when forbidden tools are not called", () => {
      const turns = makeTurns([["search", "format"]]);
      const result = scoreTrajectory(turns, {
        forbiddenTools: ["delete_account", "drop_table"],
      });
      expect(result.pass).toBe(true);
      expect(result.forbiddenToolsAbsent).toBe(true);
    });

    it("fails when forbidden tools are called", () => {
      const turns = makeTurns([["search"], ["delete_account"]]);
      const result = scoreTrajectory(turns, {
        forbiddenTools: ["delete_account"],
      });
      expect(result.pass).toBe(false);
      expect(result.forbiddenToolsAbsent).toBe(false);
      expect(result.details).toContain("delete_account");
    });
  });

  describe("maxToolCalls", () => {
    it("passes when within limit", () => {
      const turns = makeTurns([["a", "b"], ["c"]]);
      const result = scoreTrajectory(turns, { maxToolCalls: 5 });
      expect(result.pass).toBe(true);
      expect(result.withinToolCallLimit).toBe(true);
    });

    it("fails when exceeding limit", () => {
      const turns = makeTurns([
        ["a", "b", "c"],
        ["d", "e", "f"],
      ]);
      const result = scoreTrajectory(turns, { maxToolCalls: 3 });
      expect(result.pass).toBe(false);
      expect(result.withinToolCallLimit).toBe(false);
    });
  });

  describe("combined assertions", () => {
    it("all pass together", () => {
      const turns = makeTurns([["search"], ["format"], ["send"]]);
      const result = scoreTrajectory(turns, {
        requiredTools: ["search", "send"],
        orderedTools: ["search", "format", "send"],
        forbiddenTools: ["delete"],
        maxToolCalls: 5,
      });
      expect(result.pass).toBe(true);
    });

    it("fails if any assertion fails", () => {
      const turns = makeTurns([["search"], ["delete"]]);
      const result = scoreTrajectory(turns, {
        requiredTools: ["search"],
        forbiddenTools: ["delete"],
      });
      expect(result.pass).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("handles empty turns", () => {
      const result = scoreTrajectory([], { requiredTools: ["search"] });
      expect(result.pass).toBe(false);
    });

    it("handles turns with no tool calls", () => {
      const turns: ConversationTurn[] = [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ];
      const result = scoreTrajectory(turns, { maxToolCalls: 5 });
      expect(result.pass).toBe(true);
    });
  });
});
