import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RunContext } from "../../agent/run-context.js";
import { EventBus } from "../../events/event-bus.js";
import { ToolExecutor } from "../tool-executor.js";
import type { ToolDef } from "../types.js";

function makeTool(overrides?: Partial<ToolDef>): ToolDef {
  return {
    name: "echo",
    description: "echo input",
    parameters: z.object({ text: z.string() }),
    execute: async ({ text }: any) => `echo: ${text}`,
    ...overrides,
  };
}

function makeCtx(): RunContext {
  return new RunContext({
    sessionId: "test",
    eventBus: new EventBus(),
  });
}

describe("ToolExecutor", () => {
  it("executes a tool and returns result", async () => {
    const executor = new ToolExecutor([makeTool()]);
    const results = await executor.executeAll([{ id: "tc1", name: "echo", arguments: { text: "hello" } }], makeCtx());

    expect(results).toHaveLength(1);
    expect(results[0].result).toBe("echo: hello");
    expect(results[0].toolName).toBe("echo");
  });

  it("returns error for unknown tool", async () => {
    const executor = new ToolExecutor([makeTool()]);
    const results = await executor.executeAll([{ id: "tc1", name: "unknown", arguments: {} }], makeCtx());

    expect(results[0].error).toMatch(/not found/i);
  });

  it("returns error for invalid arguments", async () => {
    const executor = new ToolExecutor([makeTool()]);
    const results = await executor.executeAll([{ id: "tc1", name: "echo", arguments: { text: 123 } }], makeCtx());

    expect(results[0].error).toMatch(/invalid/i);
  });

  it("caches results when tool has cache config", async () => {
    let callCount = 0;
    const tool = makeTool({
      execute: async () => {
        callCount++;
        return "result";
      },
      cache: { ttl: 10_000 },
    });

    const executor = new ToolExecutor([tool]);
    const ctx = makeCtx();
    const args = { text: "hello" };

    await executor.executeAll([{ id: "tc1", name: "echo", arguments: args }], ctx);
    await executor.executeAll([{ id: "tc2", name: "echo", arguments: args }], ctx);

    expect(callCount).toBe(1);
  });

  it("emits tool.call and tool.result events", async () => {
    const bus = new EventBus();
    const calls: string[] = [];
    bus.on("tool.call", () => calls.push("call"));
    bus.on("tool.result", () => calls.push("result"));

    const executor = new ToolExecutor([makeTool()]);
    const ctx = new RunContext({ sessionId: "test", eventBus: bus });

    await executor.executeAll([{ id: "tc1", name: "echo", arguments: { text: "hi" } }], ctx);

    expect(calls).toEqual(["call", "result"]);
  });

  it("denies tool call when approval manager rejects", async () => {
    const executor = new ToolExecutor([makeTool({ requiresApproval: true })], {
      approval: {
        policy: "all",
        onApproval: async () => ({ approved: false, reason: "denied by test" }),
        eventBus: new EventBus(),
      },
      agentName: "test-agent",
    });

    const results = await executor.executeAll([{ id: "tc1", name: "echo", arguments: { text: "hi" } }], makeCtx());

    expect(results[0].result).toMatch(/DENIED/);
    expect(results[0].error).toMatch(/denied by test/);
  });

  it("getToolDefinitions returns JSON schema", () => {
    const executor = new ToolExecutor([makeTool()]);
    const defs = executor.getToolDefinitions();

    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("echo");
    expect(defs[0].parameters).toHaveProperty("type", "object");
  });
});
