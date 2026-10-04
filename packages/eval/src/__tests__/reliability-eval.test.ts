import type { Agent, RunOutput } from "@agentium/core";
import { describe, expect, it, vi } from "vitest";
import { ReliabilityEval } from "../reliability-eval.js";

function output(tools: string[] = []): RunOutput {
  return {
    text: "A nonempty answer",
    toolCalls: tools.map((toolName, index) => ({ toolCallId: String(index), toolName, result: "ok" })),
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };
}

describe("ReliabilityEval mandatory assertions", () => {
  it.each(["error", "denial"])("does not count a tool %s as a successful required tool", async (field) => {
    const result = output(["save"]);
    Object.assign(result.toolCalls[0], { [field]: field === "denial" ? "policy" : "failed" });
    const suite = await new ReliabilityEval({
      name: "required-success",
      agent: { run: async () => result } as unknown as Agent,
      cases: [{ name: "write", input: "work", expectedTools: ["save"] }],
    }).run();
    expect(suite.failed).toBe(1);
  });

  it("does not start a case whose parent signal was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn(async () => output());
    const suite = await new ReliabilityEval({
      name: "cancelled",
      agent: { run } as unknown as Agent,
      cases: [{ name: "work", input: "work", shouldError: true, runOpts: { signal: controller.signal } }],
    }).run();
    expect(run).not.toHaveBeenCalled();
    expect(suite.failed).toBe(1);
  });

  it("settles promptly on parent cancellation even if an agent ignores its signal", async () => {
    const controller = new AbortController();
    let childSignal: AbortSignal | undefined;
    const run = vi.fn((_input, opts) => {
      childSignal = opts.signal;
      queueMicrotask(() => controller.abort());
      return new Promise(() => {});
    });
    const suite = await new ReliabilityEval({
      name: "cancelled",
      agent: { run } as unknown as Agent,
      cases: [{ name: "work", input: "work", shouldError: true, runOpts: { signal: controller.signal } }],
    }).run();
    expect(suite.failed).toBe(1);
    expect(childSignal?.aborted).toBe(true);
    expect(suite.results[0].error).toMatch(/cancelled/);
  });

  it("fails when any required tool is missing even if the average meets the threshold", async () => {
    const agent = { run: vi.fn(async () => output(["read", "search", "validate"])) } as unknown as Agent;
    const result = await new ReliabilityEval({
      name: "required-tools",
      agent,
      cases: [{ name: "all required", input: "do work", expectedTools: ["read", "search", "validate", "save"] }],
    }).run();
    expect(result.averageScore).toBeGreaterThan(0.7);
    expect(result.results[0].scores.toolCalls.pass).toBe(false);
    expect(result.passed).toBe(0);
  });

  it("does not average away an expected error", async () => {
    const agent = { run: vi.fn(async () => output()) } as unknown as Agent;
    const result = await new ReliabilityEval({
      name: "errors",
      agent,
      threshold: 0,
      cases: [{ name: "must throw", input: "invalid", shouldError: true }],
    }).run();
    expect(result.failed).toBe(1);
  });

  it("fails stopped and canceled results", async () => {
    const agent = { run: vi.fn(async () => ({ ...output(), status: "stopped" as const })) } as unknown as Agent;
    const result = await new ReliabilityEval({
      name: "terminal",
      agent,
      threshold: 0,
      cases: [{ name: "complete", input: "work" }],
    }).run();
    expect(result.failed).toBe(1);
  });

  it("does not count an infrastructure timeout as an expected agent error, and aborts the run", async () => {
    let signal: AbortSignal | undefined;
    const agent = {
      run: vi.fn((_input, opts) => {
        signal = opts.signal;
        return new Promise(() => {});
      }),
    } as unknown as Agent;
    const result = await new ReliabilityEval({
      name: "timeout",
      agent,
      timeoutMs: 5,
      cases: [{ name: "must throw", input: "work", shouldError: true }],
    }).run();
    expect(result.failed).toBe(1);
    expect(signal?.aborted).toBe(true);
  });

  it("passes when all required tools execute, and when the agent throws an expected error", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(output(["read", "save"]))
      .mockRejectedValueOnce(new Error("invalid input"));
    const result = await new ReliabilityEval({
      name: "valid",
      agent: { run } as unknown as Agent,
      cases: [
        { name: "tools", input: "work", expectedTools: ["read", "save"] },
        { name: "error", input: "bad", shouldError: true },
      ],
    }).run();
    expect(result.passed).toBe(2);
  });
});
