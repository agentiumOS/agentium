import type { RunOutput } from "@agentium/core";
import type { Scorer, ScorerResult } from "../types.js";

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => deepEqual(aObj[k], bObj[k]));
}

export function jsonMatch(expectedFields: Record<string, unknown>): Scorer {
  return {
    name: "json-match",
    async score(_input: string, output: RunOutput): Promise<ScorerResult> {
      if (!output.structured) {
        return { score: 0, pass: false, reason: "No structured output" };
      }

      const obj = output.structured as Record<string, unknown>;
      const totalFields = Object.keys(expectedFields).length;
      let matched = 0;
      const mismatches: string[] = [];

      for (const [key, expected] of Object.entries(expectedFields)) {
        if (deepEqual(obj[key], expected)) {
          matched++;
        } else {
          mismatches.push(`${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(obj[key])}`);
        }
      }

      const score = totalFields > 0 ? matched / totalFields : 1;
      const pass = score >= 1.0;

      return {
        score,
        pass,
        reason: pass ? undefined : `Mismatches: ${mismatches.join("; ")}`,
      };
    },
  };
}
