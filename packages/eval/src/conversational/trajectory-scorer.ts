import type { ConversationTurn, ExpectedTrajectory, TrajectoryMatchResult } from "./types.js";

export function scoreTrajectory(turns: ConversationTurn[], expected: ExpectedTrajectory): TrajectoryMatchResult {
  const allToolCalls = turns.flatMap((t) => t.toolCalls ?? []);
  const details: string[] = [];
  let pass = true;

  let requiredToolsPresent: boolean | undefined;
  if (expected.requiredTools) {
    const missing = expected.requiredTools.filter((t) => !allToolCalls.includes(t));
    requiredToolsPresent = missing.length === 0;
    if (!requiredToolsPresent) {
      pass = false;
      details.push(`Missing required tools: ${missing.join(", ")}`);
    } else {
      details.push("All required tools were called");
    }
  }

  let orderedToolsMatch: boolean | undefined;
  if (expected.orderedTools) {
    let lastIdx = -1;
    orderedToolsMatch = true;
    for (const tool of expected.orderedTools) {
      const idx = allToolCalls.indexOf(tool, lastIdx + 1);
      if (idx === -1) {
        orderedToolsMatch = false;
        break;
      }
      lastIdx = idx;
    }
    if (!orderedToolsMatch) {
      pass = false;
      details.push(
        `Tool order mismatch. Expected: ${expected.orderedTools.join(" → ")}, Got: ${allToolCalls.join(" → ")}`,
      );
    } else {
      details.push("Tool call order matches expected sequence");
    }
  }

  let forbiddenToolsAbsent: boolean | undefined;
  if (expected.forbiddenTools) {
    const called = expected.forbiddenTools.filter((t) => allToolCalls.includes(t));
    forbiddenToolsAbsent = called.length === 0;
    if (!forbiddenToolsAbsent) {
      pass = false;
      details.push(`Forbidden tools were called: ${called.join(", ")}`);
    } else {
      details.push("No forbidden tools were called");
    }
  }

  let withinToolCallLimit: boolean | undefined;
  if (expected.maxToolCalls !== undefined) {
    withinToolCallLimit = allToolCalls.length <= expected.maxToolCalls;
    if (!withinToolCallLimit) {
      pass = false;
      details.push(`Tool call count ${allToolCalls.length} exceeds limit ${expected.maxToolCalls}`);
    } else {
      details.push(`Tool calls (${allToolCalls.length}) within limit (${expected.maxToolCalls})`);
    }
  }

  return {
    pass,
    details: details.join(". "),
    requiredToolsPresent,
    orderedToolsMatch,
    forbiddenToolsAbsent,
    withinToolCallLimit,
  };
}
