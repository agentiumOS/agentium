import { describe, expect, it } from "vitest";
import { z } from "zod/v3";
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
  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid concurrency %s", (concurrency) => {
    expect(() => new ToolExecutor([makeTool()], { concurrency })).toThrow(/positive safe integer/);
  });

  it("rejects ambiguous duplicate tool names", () => {
    expect(() => new ToolExecutor([makeTool(), makeTool()])).toThrow(/Duplicate tool name/);
  });

  it("keeps nested cached inputs distinct and scopes cached results to the run", async () => {
    let calls = 0;
    const executor = new ToolExecutor([
      makeTool({
        parameters: z.object({ filter: z.object({ tenant: z.string() }) }),
        cache: { ttl: 10000 },
        execute: async (args, ctx) => {
          calls++;
          return `${(args.filter as { tenant: string }).tenant}:${ctx.userId}`;
        },
      }),
    ]);
    const ctx = new RunContext({ sessionId: "session", userId: "alice", eventBus: new EventBus() });
    const first = { id: "a", name: "echo", arguments: { filter: { tenant: "one" } } };
    const second = { id: "b", name: "echo", arguments: { filter: { tenant: "two" } } };
    expect((await executor.executeAll([first], ctx))[0].result).toBe("one:alice");
    expect((await executor.executeAll([second], ctx))[0].result).toBe("two:alice");
    await executor.executeAll([first], ctx);
    expect(calls).toBe(2);
    const other = new RunContext({ sessionId: "session", userId: "bob", eventBus: new EventBus() });
    expect((await executor.executeAll([first], other))[0].result).toBe("one:bob");
    expect(calls).toBe(3);
  });

  it("discards transformed output if cancellation occurs during the transform", async () => {
    const controller = new AbortController();
    const bus = new EventBus();
    const published: unknown[] = [];
    bus.on("tool.result", ({ result }) => published.push(result));
    const executor = new ToolExecutor([
      makeTool({
        cache: { ttl: 10000 },
        toModelOutput: async () => {
          controller.abort();
          return "must not publish";
        },
      }),
    ]);
    const ctx = new RunContext({ sessionId: "session", eventBus: bus, signal: controller.signal });
    const [result] = await executor.executeAll([{ id: "a", name: "echo", arguments: { text: "hello" } }], ctx);
    expect(result.denial).toBe("cancelled");
    expect(published).not.toContain("must not publish");
  });

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
