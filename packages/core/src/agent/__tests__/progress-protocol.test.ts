import { describe, expect, it } from "vitest";
import { estimateProgress, toolResultPreview } from "../progress-protocol.js";

describe("estimateProgress", () => {
  it("returns 0 for first roundtrip in LLM phase", () => {
    expect(estimateProgress(0, 10, "llm")).toBe(0);
  });

  it("returns increasing progress", () => {
    const p1 = estimateProgress(1, 10, "llm");
    const p5 = estimateProgress(5, 10, "llm");
    const p9 = estimateProgress(9, 10, "llm");

    expect(p5).toBeGreaterThan(p1);
    expect(p9).toBeGreaterThan(p5);
  });

  it("tools phase adds offset vs LLM phase", () => {
    const llm = estimateProgress(3, 10, "llm");
    const tools = estimateProgress(3, 10, "tools");
    expect(tools).toBeGreaterThanOrEqual(llm);
  });

  it("never exceeds 99", () => {
    expect(estimateProgress(10, 10, "tools")).toBeLessThanOrEqual(99);
    expect(estimateProgress(100, 10, "tools")).toBeLessThanOrEqual(99);
  });

  it("handles edge case of maxRoundtrips = 1", () => {
    const p = estimateProgress(1, 1, "llm");
    expect(p).toBeLessThanOrEqual(99);
    expect(p).toBeGreaterThan(0);
  });
});

describe("toolResultPreview", () => {
  it("returns full text for short results", () => {
    expect(toolResultPreview("Hello world")).toBe("Hello world");
  });

  it("truncates long results", () => {
    const long = "x".repeat(200);
    const preview = toolResultPreview(long, 50);
    expect(preview.length).toBe(50);
    expect(preview.endsWith("...")).toBe(true);
  });

  it("normalizes whitespace", () => {
    const messy = "hello   world\n\nfoo\tbar";
    expect(toolResultPreview(messy)).toBe("hello world foo bar");
  });

  it("respects custom maxLength", () => {
    const text = "a".repeat(30);
    const preview = toolResultPreview(text, 20);
    expect(preview.length).toBe(20);
  });

  it("handles empty string", () => {
    expect(toolResultPreview("")).toBe("");
  });
});
