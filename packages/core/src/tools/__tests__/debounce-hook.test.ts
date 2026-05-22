import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RunContext } from "../../agent/run-context.js";
import { EventBus } from "../../events/event-bus.js";
import { defineTool } from "../define-tool.js";
import { ToolExecutor, ToolLoopError } from "../tool-executor.js";

function makeCtx(): RunContext {
  return new RunContext({ sessionId: "s1", eventBus: new EventBus() });
}

describe("ToolExecutor loop detection", () => {
  const echoTool = defineTool({
    name: "echo",
    description: "x",
    parameters: z.object({ q: z.string() }),
    execute: async ({ q }) => `echo:${q}`,
  });

  it("does nothing when loopDetection is disabled", async () => {
    const exec = new ToolExecutor([echoTool]);
    const ctx = makeCtx();
    for (let i = 0; i < 5; i++) {
      const [r] = await exec.executeAll([{ id: `c${i}`, name: "echo", arguments: { q: "a" } }], ctx);
      expect(r.result).toBe("echo:a");
    }
  });

  it("throws ToolLoopError when maxRepeats exceeded with action=abort", async () => {
    const exec = new ToolExecutor([echoTool], { loopDetection: { maxRepeats: 2, action: "abort" } });
    const ctx = makeCtx();
    // First 2 calls succeed.
    await exec.executeAll([{ id: "c1", name: "echo", arguments: { q: "a" } }], ctx);
    await exec.executeAll([{ id: "c2", name: "echo", arguments: { q: "a" } }], ctx);
    // Third (count=3) should throw.
    await expect(exec.executeAll([{ id: "c3", name: "echo", arguments: { q: "a" } }], ctx)).rejects.toThrow(
      ToolLoopError,
    );
  });

  it("returns a hint result when action=hint", async () => {
    const exec = new ToolExecutor([echoTool], { loopDetection: { maxRepeats: 1, action: "hint" } });
    const ctx = makeCtx();
    await exec.executeAll([{ id: "c1", name: "echo", arguments: { q: "a" } }], ctx);
    const [r] = await exec.executeAll([{ id: "c2", name: "echo", arguments: { q: "a" } }], ctx);
    expect(r.error).toBe("loop-detected");
    expect(typeof r.result).toBe("string");
    expect(r.result as string).toContain("loop-detected");
  });

  it("counts (toolName, args) signatures separately", async () => {
    const exec = new ToolExecutor([echoTool], { loopDetection: { maxRepeats: 1, action: "abort" } });
    const ctx = makeCtx();
    await exec.executeAll([{ id: "c1", name: "echo", arguments: { q: "a" } }], ctx);
    // Different args -> separate counter, should not trigger
    const [r] = await exec.executeAll([{ id: "c2", name: "echo", arguments: { q: "b" } }], ctx);
    expect(r.result).toBe("echo:b");
  });
});
