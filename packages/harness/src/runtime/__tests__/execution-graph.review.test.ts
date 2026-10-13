import {
  DurableRecoveryRequiredError,
  InMemoryDurableTaskStore,
  type ModelProvider,
  RootExecutionController,
} from "@agentium/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type ExecutionDriver, HarnessRuntime } from "../driver.js";
import { ExecutionGraphRuntime, type ExecutionGraphRuntimeOptions } from "../execution-graph.js";
import type { ExecutionGraphProgram, ExecutionPlan, GraphBinding, GraphToolBinding } from "../graph-contracts.js";

const identity = { tenantId: "tenant", actorId: "actor", sessionId: "session", runId: "run", rootRunId: "run" };
const key = { tenantId: "tenant", taskId: "review" };
const schema = z.object({ value: z.number() });
const plan = (binding: string, args = {}): ExecutionPlan => ({
  schemaVersion: 1,
  revision: 1,
  nodes: [{ id: "node", binding, version: "1", args }],
});
function tool(execute: (value: number) => Promise<string>): GraphToolBinding {
  return {
    id: "tool",
    version: "1",
    kind: "tool",
    input: schema,
    output: z.string(),
    recovery: "pure",
    tool: {
      name: "tool",
      description: "approved",
      parameters: schema,
      execute: (args) => execute(args.value as number),
    },
  };
}
function options(program: ExecutionGraphProgram, catalog: GraphBinding[]): ExecutionGraphRuntimeOptions {
  return {
    program,
    catalog,
    store: new InMemoryDurableTaskStore(),
    harness: {
      grants: { toolIds: ["tool"], modelRoles: ["main"] },
      budgets: { maxToolCalls: 1, maxModelCalls: 20, maxTokens: 1000 },
      estimateInputTokens: () => 1,
    },
  };
}

describe("execution graph review regressions", () => {
  it("reconciles an accepted effect through its originating operation when connectors share destination and version", async () => {
    let effects = 0;
    let correct = 0;
    let wrong = 0;
    const a = tool(async () => "unused");
    a.recovery = {
      destination: "shared",
      connector: {
        version: "1",
        async dispatch() {
          effects++;
          throw new Error("accepted but receipt lost");
        },
        async reconcile() {
          correct++;
          return { outcome: "confirmed", resultRef: "receipt:a", evidenceRef: "evidence:a" };
        },
      },
      resolveResult: async () => "A",
    };
    const b = {
      ...a,
      id: "other",
      tool: { ...a.tool, name: "other" },
      recovery: {
        destination: "shared",
        connector: {
          version: "1",
          async dispatch() {
            throw new Error("wrong dispatch");
          },
          async reconcile() {
            wrong++;
            return { outcome: "absent" as const, evidenceRef: "evidence:b" };
          },
        },
        resolveResult: async () => "B",
      },
    } satisfies GraphToolBinding;
    const runtime = new ExecutionGraphRuntime(
      options({ id: "effect", version: "1", plan: plan("tool", { value: 1 }) }, [b, a]),
    );
    await runtime.create({ id: key.taskId, identity, input: {} });
    await expect(runtime.run(key, "first")).rejects.toBeInstanceOf(DurableRecoveryRequiredError);
    const result = await runtime.run(key, "second");
    expect(result.task.state).toBe("completed");
    expect(result.output).toEqual({ node: "A" });
    expect({ effects, correct, wrong }).toEqual({ effects: 1, correct: 1, wrong: 0 });
  });

  it("fails a denied root attempt without inventing an uncertain destination effect", async () => {
    let dispatches = 0;
    const binding = tool(async () => "unused");
    binding.recovery = {
      destination: "destination",
      connector: {
        version: "1",
        async dispatch() {
          dispatches++;
          return { resultRef: "receipt" };
        },
      },
      resolveResult: async () => "value",
    };
    const config = options({ id: "effect", version: "1", plan: plan("tool", { value: 1 }) }, [binding]);
    config.limits = { maxWorkAttempts: 0 };
    const runtime = new ExecutionGraphRuntime(config);
    await runtime.create({ id: key.taskId, identity, input: {} });
    await expect(runtime.run(key, "worker")).rejects.toMatchObject({ code: "root_attempt_limit" });
    const result = await runtime.inspect(key);
    expect(result.task.state).toBe("failed");
    expect(
      Object.values(result.task.actions).every((action) => action.state !== "unknown" && action.state !== "executing"),
    ).toBe(true);
    expect(dispatches).toBe(0);
  });

  it("bounds accumulated depth through dynamically planned child episodes", async () => {
    let calls = 0;
    let effects = 0;
    const provider: ModelProvider = {
      providerId: "offline",
      modelId: "recursive",
      async generate() {
        calls++;
        return {
          message: {
            role: "assistant",
            content: JSON.stringify(calls < 13 ? plan("nested") : plan("tool", { value: 1 })),
          },
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: "stop",
          raw: null,
        };
      },
      // biome-ignore lint/correctness/useYield: only complete planning is exercised.
      async *stream() {
        throw new Error("unused");
      },
    };
    const program: ExecutionGraphProgram = {
      id: "recursive",
      version: "1",
      planner: {
        provider,
        hostInstructions: "Use approved bindings",
        maxCorrections: 0,
        maxOutputTokens: 10,
        stream: { maxFrameBytes: 4096, maxTotalBytes: 4096, maxFrames: 1 },
      },
    };
    const nested: GraphBinding = {
      id: "nested",
      version: "1",
      kind: "graph",
      input: z.object({}),
      output: z.unknown(),
      program,
    };
    const config = options(program, [
      tool(async () => {
        effects++;
        return "effect";
      }),
      nested,
    ]);
    config.limits = { plan: { maxDepth: 8 }, maxExpandedNodes: 30, maxPlanRevisions: 30, maxWorkAttempts: 30 };
    const runtime = new ExecutionGraphRuntime(config);
    await runtime.create({ id: key.taskId, identity, input: {} });
    await expect(runtime.run(key, "worker")).rejects.toThrow();
    expect(calls).toBe(8);
    expect(effects).toBe(0);
    const result = await runtime.inspect(key);
    expect(result.task.state).toBe("failed");
    expect(
      Object.entries(result.graph.metadata)
        .filter(([name]) => name.startsWith("episodeDepth:"))
        .map(([, depth]) => depth)
        .sort((left, right) => Number(left) - Number(right)),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("pins static arguments, budgets, grants and executable bindings against later caller mutation", async () => {
    const observed: number[] = [];
    const original = tool(async (value) => {
      observed.push(value);
      return String(value);
    });
    const source = { id: "static", version: "1", plan: plan("tool", { value: 1 }) };
    const config = options(source, [original]);
    const runtime = new ExecutionGraphRuntime(config);
    await runtime.create({ id: key.taskId, identity, input: {} });
    source.plan.nodes[0].args.value = 999;
    config.harness.budgets!.maxToolCalls = 50;
    config.harness.grants.toolIds = [];
    original.tool.execute = async () => "replaced";
    const result = await runtime.run(key, "worker");
    expect(result.output).toEqual({ node: "1" });
    expect(observed).toEqual([1]);
    expect(result.graph.budget).toMatchObject({ limits: { maxToolCalls: 1 }, usedTools: 1 });
  });

  it("pins child programs before a running callback mutates the caller's catalog", async () => {
    const child: ExecutionGraphProgram = { id: "child", version: "1", plan: plan("tool", { value: 2 }) };
    const nested: GraphBinding = {
      id: "nested",
      version: "1",
      kind: "graph",
      input: z.object({}),
      output: z.unknown(),
      program: child,
    };
    const observed: number[] = [];
    const binding = tool(async (value) => {
      observed.push(value);
      if (child.plan) child.plan.nodes[0].args.value = 999;
      return String(value);
    });
    const config = options(
      {
        id: "root",
        version: "1",
        plan: {
          schemaVersion: 1,
          revision: 1,
          nodes: [
            { id: "first", binding: "tool", version: "1", args: { value: 1 } },
            { id: "child", binding: "nested", version: "1", args: {}, dependsOn: ["first"] },
          ],
        },
      },
      [binding, nested],
    );
    config.harness.budgets!.maxToolCalls = 2;
    const runtime = new ExecutionGraphRuntime(config);
    await runtime.create({ id: key.taskId, identity, input: {} });
    const result = await runtime.run(key, "worker");
    expect(result.output).toEqual({ first: "1", child: { node: "2" } });
    expect(observed).toEqual([1, 2]);
  });

  it("closes a cancelled provider stream while its root permit is still owned", async () => {
    const abort = new AbortController();
    const root = new RootExecutionController({ maxConcurrentWork: 1 }, { signal: abort.signal });
    let finalizers = 0;
    const provider: ModelProvider = {
      providerId: "offline",
      modelId: "cleanup",
      async generate() {
        throw new Error("unused");
      },
      async *stream() {
        try {
          yield { type: "text", text: "prefix" };
        } finally {
          expect(root.snapshot().active).toBe(1);
          finalizers++;
        }
      },
    };
    const driver: ExecutionDriver = {
      id: "cleanup",
      version: 1,
      capabilities: { controlledExecution: true, policyCoverage: "local", controls: [], durable: false },
      async start(_request, services) {
        const iterator = services.streamModel(provider, [{ role: "user", content: "task" }], { maxTokens: 2 });
        expect(await iterator.next()).toMatchObject({ value: { type: "text" } });
        abort.abort();
        await iterator.return(undefined);
        return { text: "unused" };
      },
    };
    const runtime = new HarnessRuntime({
      driver,
      grants: { toolIds: [], modelRoles: ["main"] },
      budgets: { maxModelCalls: 1, maxTokens: 10 },
      estimateInputTokens: () => 1,
    });
    const result = await runtime.run("task", {
      identity: { tenantId: "tenant", userId: "actor" },
      sessionId: "cleanup",
      rootExecution: root,
      signal: root.signal,
    });
    expect(result.status).toBe("cancelled");
    expect(finalizers).toBe(1);
    expect(root.snapshot()).toMatchObject({ active: 0, queued: 0, workAttempts: 1 });
  });
});
