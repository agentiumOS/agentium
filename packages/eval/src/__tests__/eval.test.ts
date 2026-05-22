import type { RunOutput } from "@agentium/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { contains } from "../scorers/contains.js";
import { custom } from "../scorers/custom.js";
import { jsonMatch } from "../scorers/json-match.js";
import { regexMatch } from "../scorers/regex.js";
import { EvalSuite } from "../suite.js";
import type { Scorer } from "../types.js";

function makeOutput(text: string, structured?: unknown): RunOutput {
  return {
    text,
    toolCalls: [],
    usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
    structured,
  };
}

function mockAgent(response: string | RunOutput) {
  const output = typeof response === "string" ? makeOutput(response) : response;
  return {
    run: vi.fn().mockResolvedValue(output),
  } as any;
}

function slowAgent(delayMs: number, response: string) {
  return {
    run: vi
      .fn()
      .mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(makeOutput(response)), delayMs))),
  } as any;
}

// ─── EvalSuite tests ──────────────────────────────────────────────────────

describe("EvalSuite", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("runs all cases and returns results", async () => {
    const agent = mockAgent("Paris is the capital of France");

    const suite = new EvalSuite({
      name: "geography",
      agent,
      cases: [
        { name: "france", input: "What is the capital of France?", expected: "Paris" },
        { name: "germany", input: "What is the capital of Germany?", expected: "Berlin" },
      ],
      scorers: [contains("Paris")],
    });

    const result = await suite.run();

    expect(result.total).toBe(2);
    expect(result.results).toHaveLength(2);
    expect(result.name).toBe("geography");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("respects concurrency limit", async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const agent = {
      run: vi.fn().mockImplementation(async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise((r) => setTimeout(r, 10));
        currentConcurrent--;
        return makeOutput("result");
      }),
    } as any;

    const suite = new EvalSuite({
      name: "concurrency-test",
      agent,
      cases: [
        { name: "c1", input: "q1" },
        { name: "c2", input: "q2" },
        { name: "c3", input: "q3" },
        { name: "c4", input: "q4" },
      ],
      scorers: [contains("result")],
      concurrency: 2,
    });

    await suite.run();

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it("isolates errors — failed case doesn't abort others", async () => {
    const agent = {
      run: vi
        .fn()
        .mockResolvedValueOnce(makeOutput("good answer"))
        .mockRejectedValueOnce(new Error("agent crashed"))
        .mockResolvedValueOnce(makeOutput("another good answer")),
    } as any;

    const suite = new EvalSuite({
      name: "error-isolation",
      agent,
      cases: [
        { name: "c1", input: "q1" },
        { name: "c2", input: "q2" },
        { name: "c3", input: "q3" },
      ],
      scorers: [contains("good")],
      concurrency: 1,
    });

    const result = await suite.run();

    expect(result.total).toBe(3);
    const errResult = result.results.find((r) => r.error);
    expect(errResult).toBeDefined();
    expect(errResult!.pass).toBe(false);
  });

  it("timeout works for slow agents", async () => {
    const agent = slowAgent(5000, "slow response");

    const suite = new EvalSuite({
      name: "timeout-test",
      agent,
      cases: [{ name: "slow", input: "test" }],
      scorers: [contains("slow")],
      timeoutMs: 50,
    });

    const result = await suite.run();

    expect(result.results[0].pass).toBe(false);
    expect(result.results[0].error).toContain("timed out");
  });

  it("scorer errors are caught and produce zero-score results", async () => {
    const agent = mockAgent("valid output");
    const brokenScorer: Scorer = {
      name: "broken",
      score: vi.fn().mockRejectedValue(new Error("scorer exploded")),
    };

    const suite = new EvalSuite({
      name: "scorer-error",
      agent,
      cases: [{ name: "case1", input: "test" }],
      scorers: [brokenScorer],
    });

    const result = await suite.run();

    const scores = result.results[0].scores;
    expect(scores.broken.score).toBe(0);
    expect(scores.broken.pass).toBe(false);
    expect(scores.broken.reason).toContain("scorer exploded");
  });

  it("results include pass/fail based on threshold", async () => {
    const agent = mockAgent("Hello World");

    const suite = new EvalSuite({
      name: "threshold-test",
      agent,
      cases: [
        { name: "match", input: "greet" },
        { name: "mismatch", input: "greet" },
      ],
      scorers: [contains("Hello")],
      threshold: 0.5,
    });

    const result = await suite.run();

    expect(result.results[0].pass).toBe(true);
    expect(result.passed).toBeGreaterThanOrEqual(1);
  });

  it("computes averageScore correctly", async () => {
    const agent = {
      run: vi.fn().mockResolvedValueOnce(makeOutput("yes match")).mockResolvedValueOnce(makeOutput("no")),
    } as any;

    const suite = new EvalSuite({
      name: "avg-score",
      agent,
      cases: [
        { name: "c1", input: "q1" },
        { name: "c2", input: "q2" },
      ],
      scorers: [contains("match")],
    });

    const result = await suite.run();

    expect(result.averageScore).toBe(0.5);
  });

  it("calls reporters after run", async () => {
    const agent = mockAgent("output");
    const reporter = { report: vi.fn() };

    const suite = new EvalSuite({
      name: "reporter-test",
      agent,
      cases: [{ name: "c1", input: "q" }],
      scorers: [contains("output")],
    });

    await suite.run([reporter]);

    expect(reporter.report).toHaveBeenCalledTimes(1);
    expect(reporter.report).toHaveBeenCalledWith(expect.objectContaining({ name: "reporter-test" }));
  });
});

// ─── Scorer tests ─────────────────────────────────────────────────────────

describe("contains scorer", () => {
  it("returns score 1 when text contains expected string", async () => {
    const scorer = contains("hello");
    const result = await scorer.score("input", makeOutput("say hello world"));
    expect(result.score).toBe(1);
    expect(result.pass).toBe(true);
  });

  it("returns score 0 when text does not contain expected string", async () => {
    const scorer = contains("hello");
    const result = await scorer.score("input", makeOutput("goodbye world"));
    expect(result.score).toBe(0);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("hello");
  });

  it("is case insensitive by default", async () => {
    const scorer = contains("HELLO");
    const result = await scorer.score("input", makeOutput("hello there"));
    expect(result.score).toBe(1);
  });

  it("respects caseSensitive option", async () => {
    const scorer = contains("HELLO", { caseSensitive: true });
    const result = await scorer.score("input", makeOutput("hello there"));
    expect(result.score).toBe(0);
  });

  it("handles null/undefined output text gracefully", async () => {
    const scorer = contains("test");
    const output = {
      text: undefined as any,
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
    const result = await scorer.score("input", output);
    expect(result.score).toBe(0);
  });
});

describe("regexMatch scorer", () => {
  it("returns score 1 when pattern matches", async () => {
    const scorer = regexMatch(/\d{3}-\d{4}/);
    const result = await scorer.score("input", makeOutput("call 555-1234"));
    expect(result.score).toBe(1);
    expect(result.pass).toBe(true);
  });

  it("returns score 0 when pattern does not match", async () => {
    const scorer = regexMatch(/\d{3}-\d{4}/);
    const result = await scorer.score("input", makeOutput("no phone here"));
    expect(result.score).toBe(0);
    expect(result.pass).toBe(false);
  });

  it("accepts string pattern", async () => {
    const scorer = regexMatch("^hello");
    const result = await scorer.score("input", makeOutput("hello world"));
    expect(result.score).toBe(1);
  });

  it("resets lastIndex for global regex between calls", async () => {
    const scorer = regexMatch(/test/g);
    const output = makeOutput("test value");

    const r1 = await scorer.score("i", output);
    const r2 = await scorer.score("i", output);

    expect(r1.score).toBe(1);
    expect(r2.score).toBe(1);
  });
});

describe("jsonMatch scorer", () => {
  it("returns score 1 for exact field match", async () => {
    const scorer = jsonMatch({ name: "Alice", age: 30 });
    const output = makeOutput("", { name: "Alice", age: 30 });
    const result = await scorer.score("input", output);
    expect(result.score).toBe(1);
    expect(result.pass).toBe(true);
  });

  it("returns score 1 when key order differs but content matches", async () => {
    const scorer = jsonMatch({ b: 2, a: 1 });
    const output = makeOutput("", { a: 1, b: 2 });
    const result = await scorer.score("input", output);
    expect(result.score).toBe(1);
  });

  it("handles nested object match", async () => {
    const scorer = jsonMatch({ user: { name: "Bob", settings: { theme: "dark" } } });
    const output = makeOutput("", { user: { name: "Bob", settings: { theme: "dark" } } });
    const result = await scorer.score("input", output);
    expect(result.score).toBe(1);
  });

  it("returns score 0 for no match", async () => {
    const scorer = jsonMatch({ name: "Alice" });
    const output = makeOutput("", { name: "Bob" });
    const result = await scorer.score("input", output);
    expect(result.score).toBe(0);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("Mismatches");
  });

  it("returns partial score for partial field match", async () => {
    const scorer = jsonMatch({ a: 1, b: 2 });
    const output = makeOutput("", { a: 1, b: 99 });
    const result = await scorer.score("input", output);
    expect(result.score).toBe(0.5);
    expect(result.pass).toBe(false);
  });

  it("returns score 0 when no structured output", async () => {
    const scorer = jsonMatch({ name: "Alice" });
    const output = makeOutput("plain text");
    const result = await scorer.score("input", output);
    expect(result.score).toBe(0);
    expect(result.reason).toContain("No structured output");
  });

  it("handles array deep equality", async () => {
    const scorer = jsonMatch({ items: [1, 2, 3] });
    const output = makeOutput("", { items: [1, 2, 3] });
    const result = await scorer.score("input", output);
    expect(result.score).toBe(1);
  });

  it("detects array mismatch", async () => {
    const scorer = jsonMatch({ items: [1, 2, 3] });
    const output = makeOutput("", { items: [1, 2, 4] });
    const result = await scorer.score("input", output);
    expect(result.score).toBe(0);
  });
});

describe("custom scorer", () => {
  it("calls the custom function with correct args", async () => {
    const fn = vi.fn().mockReturnValue({ score: 0.8, pass: true, reason: "custom" });
    const scorer = custom("my-scorer", fn);

    const output = makeOutput("output text");
    await scorer.score("input text", output, "expected");

    expect(fn).toHaveBeenCalledWith("input text", output, "expected");
  });

  it("returns the custom result", async () => {
    const scorer = custom("exact-check", (_input, output, expected) => ({
      score: output.text === expected ? 1 : 0,
      pass: output.text === expected,
    }));

    const r1 = await scorer.score("q", makeOutput("answer"), "answer");
    expect(r1.score).toBe(1);
    expect(r1.pass).toBe(true);

    const r2 = await scorer.score("q", makeOutput("wrong"), "answer");
    expect(r2.score).toBe(0);
    expect(r2.pass).toBe(false);
  });

  it("handles async custom functions", async () => {
    const scorer = custom("async-scorer", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { score: 0.75, pass: true };
    });

    const result = await scorer.score("i", makeOutput("o"));
    expect(result.score).toBe(0.75);
  });
});
