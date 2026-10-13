import { Agent, InMemoryDurableTaskStore, type ModelProvider, validateRootExecutionCounts } from "@agentium/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ExecutionGraphRuntime } from "../execution-graph.js";
import type { ExecutionGraphProgram, ExecutionPlanNode, GraphBinding } from "../graph-contracts.js";

const identity = { tenantId: "tenant", actorId: "actor", sessionId: "session", runId: "run", rootRunId: "run" };
const input = z.object({ value: z.number() });
function tool(id: string, execute: (value: number) => Promise<string>): GraphBinding {
  return {
    id,
    version: "1",
    kind: "tool",
    input,
    output: z.string(),
    recovery: "pure",
    tool: {
      name: id,
      description: id,
      parameters: input,
      execute: (args) => execute(args.value as number),
    },
  };
}
function program(nodes: ExecutionPlanNode[]): ExecutionGraphProgram {
  return { id: "test", version: "1", plan: { schemaVersion: 1, revision: 1, nodes, maxConcurrency: 5 } };
}
function options(catalog: GraphBinding[], source: ExecutionGraphProgram, limits = {}) {
  return {
    program: source,
    catalog,
    limits,
    store: new InMemoryDurableTaskStore(),
    harness: {
      grants: {
        toolIds: catalog.filter((b) => b.kind === "tool").map((b) => (b.kind === "tool" ? b.tool.name : "")),
        modelRoles: ["main"],
      },
      budgets: { maxToolCalls: 20, maxModelCalls: 5, maxTokens: 200 },
      estimateInputTokens: () => 1,
    },
  };
}
describe("execution graph adapter foundation", () => {
  it("materializes and journals a dependency episode through the existing Workflow", async () => {
    const calls: number[] = [];
    const runtime = new ExecutionGraphRuntime(
      options(
        [
          tool("read", async (v) => {
            calls.push(v);
            return String(v);
          }),
        ],
        program([
          { id: "first", binding: "read", version: "1", args: { value: 1 } },
          { id: "second", binding: "read", version: "1", args: { value: 2 }, dependsOn: ["first"] },
        ]),
      ),
    );
    const task = await runtime.create({ id: "task", identity, input: {} });
    const result = await runtime.run({ tenantId: "tenant", taskId: task.id }, "worker");
    expect(result.task.state).toBe("completed");
    expect(result.output).toEqual({ first: "1", second: "2" });
    expect(calls).toEqual([1, 2]);
    expect(Object.values(result.graph.nodes).filter((n) => n.status === "completed")).toHaveLength(4);
    await runtime.run({ tenantId: "tenant", taskId: task.id }, "another");
    expect(calls).toEqual([1, 2]);
  });
  it("shares a capacity-one controller through nested episodes without a parent permit", async () => {
    let active = 0;
    let high = 0;
    const read = tool("read", async (v) => {
      high = Math.max(high, ++active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      return String(v);
    });
    const child = program([
      { id: "a", binding: "read", version: "1", args: { value: 1 } },
      { id: "b", binding: "read", version: "1", args: { value: 2 } },
    ]);
    const nested: GraphBinding = {
      id: "nested",
      version: "1",
      kind: "graph",
      input: z.object({}),
      output: z.record(z.string(), z.string()),
      program: child,
    };
    const runtime = new ExecutionGraphRuntime(
      options(
        [read, nested],
        program([
          { id: "left", binding: "nested", version: "1", args: {} },
          { id: "right", binding: "nested", version: "1", args: {} },
        ]),
        { maxConcurrentWork: 1, maxExpandedNodes: 6, maxWorkAttempts: 4 },
      ),
    );
    await runtime.create({ id: "nested", identity, input: {} });
    const result = await runtime.run({ tenantId: "tenant", taskId: "nested" }, "worker");
    expect(result.task.state).toBe("completed");
    expect(high).toBe(1);
    expect(active).toBe(0);
    expect(validateRootExecutionCounts(result.graph.admission).workAttempts).toBe(4);
    expect(validateRootExecutionCounts(result.graph.admission).expandedIds).toHaveLength(6);
  });
  it("rejects an unsafe catalog before any effect is admitted", () => {
    const unsafe = tool("write", async () => "effect");
    if (unsafe.kind === "tool") delete unsafe.recovery;
    expect(() => new ExecutionGraphRuntime({ ...options([unsafe], program([])), requireDurable: true })).toThrow();
  });
  it("runs a real Agent node with approved catalog tools through the same journal", async () => {
    let calls = 0;
    let effects = 0;
    const provider: ModelProvider = {
      providerId: "offline",
      modelId: "fixture",
      async generate() {
        calls++;
        return {
          message: {
            role: "assistant",
            content: calls === 1 ? null : "done",
            ...(calls === 1 ? { toolCalls: [{ id: "stable", name: "read", arguments: { value: 7 } }] } : {}),
          },
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: calls === 1 ? "tool_calls" : "stop",
          raw: null,
        };
      },
      // biome-ignore lint/correctness/useYield: this fixture rejects streaming.
      async *stream() {
        throw new Error("unused");
      },
    };
    const agent = new Agent({
      name: "worker",
      model: provider,
      instructions: "Use the approved read tool",
      maxTokens: 10,
      maxToolRoundtrips: 2,
      register: false,
    });
    const binding: GraphBinding = {
      id: "agent",
      version: "1",
      kind: "agent",
      input: z.object({}),
      output: z.object({ text: z.string() }).passthrough(),
      agent,
      tools: ["read"],
    };
    const runtime = new ExecutionGraphRuntime(
      options(
        [
          tool("read", async () => {
            effects++;
            return "7";
          }),
          binding,
        ],
        program([{ id: "agent", binding: "agent", version: "1", args: {} }]),
        { maxConcurrentWork: 1 },
      ),
    );
    await runtime.create({ id: "agent", identity, input: {} });
    const result = await runtime.run({ tenantId: "tenant", taskId: "agent" }, "worker");
    expect(result.task.state).toBe("completed");
    expect(result.output).toMatchObject({ agent: { text: "done" } });
    expect(effects).toBe(1);
    expect(calls).toBe(2);
    expect(Object.keys(result.graph.models).filter((id) => id.includes("/model/"))).toHaveLength(2);
  });
});
