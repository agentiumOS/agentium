import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { EventBus } from "../../events/event-bus.js";
import type { ModelProvider } from "../../models/provider.js";
import type { ModelResponse } from "../../models/types.js";
import { defineTool } from "../../tools/define-tool.js";
import { ToolExecutor } from "../../tools/tool-executor.js";
import { StepRunner } from "../../workflow/step-runner.js";
import type { StepDef } from "../../workflow/types.js";
import { Agent } from "../agent.js";
import { RootExecutionController, type RootExecutionCounts, withRootExecutionProvider } from "../root-execution.js";
import { RunContext } from "../run-context.js";
import { executionFixture } from "./execution-fixture.js";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 1));
}
const answer: ModelResponse = {
  message: { role: "assistant", content: "done" },
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  finishReason: "stop",
  raw: {},
};
function context(rootExecution: RootExecutionController) {
  return new RunContext({ sessionId: "root", runId: "root", eventBus: new EventBus(), rootExecution });
}
afterEach(() => vi.useRealTimers());

describe("root leaf admission", () => {
  it("runs cleanup after cancellation while retaining the admitted slot and attempt", async () => {
    const cancel = new AbortController();
    const root = new RootExecutionController({ maxConcurrentWork: 1 }, { signal: cancel.signal });
    const lease = await root.acquire("model", "stream");
    cancel.abort();
    await expect(lease.run(async () => "new work")).rejects.toMatchObject({ code: "root_cancelled" });
    const gate = deferred();
    let entered = false;
    const cleaning = lease.cleanup(async () => {
      entered = true;
      await gate.promise;
      return "closed";
    });
    await tick();
    expect(entered).toBe(true);
    expect(root.snapshot()).toMatchObject({ active: 1, workAttempts: 1 });
    await expect(lease.release()).rejects.toMatchObject({ code: "root_state_invalid" });
    gate.resolve();
    await expect(cleaning).resolves.toBe("closed");
    expect(root.snapshot().active).toBe(1);
    await lease.release();
    expect(root.snapshot()).toMatchObject({ active: 0, workAttempts: 1 });
  });
  it("rejects concurrent or released cleanup callbacks and nested controlled work", async () => {
    const root = new RootExecutionController({ maxConcurrentWork: 1 });
    const other = new RootExecutionController({ maxConcurrentWork: 1 });
    const lease = await root.acquire("model", "stream");
    const gate = deferred();
    const cleaning = lease.cleanup(async () => {
      await gate.promise;
    });
    await expect(lease.cleanup(async () => {})).rejects.toMatchObject({ code: "root_state_invalid" });
    await expect(lease.run(async () => {})).rejects.toMatchObject({ code: "root_state_invalid" });
    gate.resolve();
    await cleaning;
    await expect(lease.cleanup(() => other.run("tool", "nested", async () => "unsafe"))).rejects.toMatchObject({
      code: "root_nested_leaf",
    });
    expect(other.snapshot().workAttempts).toBe(0);
    await expect(other.run("function", "outer", () => lease.cleanup(async () => "unsafe"))).rejects.toMatchObject({
      code: "root_nested_leaf",
    });
    const running = lease.run(async () => {
      await gate.promise;
    });
    await expect(lease.cleanup(async () => {})).rejects.toMatchObject({ code: "root_state_invalid" });
    await running;
    await lease.release();
    await expect(lease.cleanup(async () => {})).rejects.toMatchObject({ code: "root_state_invalid" });
    expect(root.snapshot()).toMatchObject({ active: 0, workAttempts: 1 });
  });
  it("retains nested dispatch guards in standalone provider finalization after abort", async () => {
    const cancel = new AbortController();
    const finalizer = deferred();
    const root = new RootExecutionController({ maxConcurrentWork: 1 }, { signal: cancel.signal });
    const other = new RootExecutionController({ maxConcurrentWork: 1 });
    let closed = false;
    let nested = 0;
    let nestedError: unknown;
    const model: ModelProvider = {
      providerId: "fixture",
      modelId: "fixture",
      generate: async () => answer,
      async *stream() {
        try {
          yield { type: "text", text: "partial" };
        } finally {
          closed = true;
          try {
            await other.run("tool", "nested-finalizer", async () => {
              nested++;
            });
          } catch (cause) {
            nestedError = cause;
          }
          await finalizer.promise;
        }
      },
    };
    const stream = withRootExecutionProvider(model, root, "agent").stream([]);
    await stream.next();
    cancel.abort();
    const closing = stream.return(undefined);
    await tick();
    try {
      expect(closed).toBe(true);
      expect(nested).toBe(0);
      expect(nestedError).toMatchObject({ code: "root_nested_leaf" });
      expect(root.snapshot()).toMatchObject({ active: 1, workAttempts: 1 });
    } finally {
      finalizer.resolve();
      await closing;
    }
    expect(root.snapshot()).toMatchObject({ active: 0, workAttempts: 1 });
  });
  it("limits aggregate work from independent producers and releases each permit", async () => {
    const root = new RootExecutionController({ maxConcurrentWork: 2 });
    const gate = deferred();
    let active = 0;
    let highWater = 0;
    let started = 0;
    const operations = Array.from({ length: 5 }, (_, i) =>
      root.run("tool", `tool:${i}`, async () => {
        started++;
        highWater = Math.max(highWater, ++active);
        await gate.promise;
        active--;
        return i;
      }),
    );
    try {
      await tick();
      expect(started).toBe(2);
      expect(root.snapshot()).toMatchObject({ active: 2, queued: 3 });
    } finally {
      gate.resolve();
      await Promise.allSettled(operations);
    }
    expect(highWater).toBe(2);
    expect(root.snapshot()).toMatchObject({ active: 0, queued: 0, workAttempts: 5, highWater: 2 });
  });
  it("preserves FIFO order while cancelling a queued waiter without dispatch or charge", async () => {
    const root = new RootExecutionController({ maxConcurrentWork: 1 });
    const first = await root.acquire("model", "stream");
    const cancelled = new AbortController();
    const order: string[] = [];
    const a = root
      .run(
        "tool",
        "a",
        async () => {
          order.push("a");
        },
        cancelled.signal,
      )
      .catch((error: unknown) => error);
    const b = root.run("tool", "b", async () => {
      order.push("b");
    });
    await tick();
    cancelled.abort();
    await first.release();
    await Promise.all([a, b]);
    expect(order).toEqual(["b"]);
    expect(root.snapshot()).toMatchObject({ active: 0, queued: 0, workAttempts: 2 });
  });
  it("rejects nested leaf dispatch rather than deadlocking or bypassing aggregate capacity", async () => {
    const root = new RootExecutionController({ maxConcurrentWork: 1 });
    let nested = 0;
    await expect(
      root.run("function", "parent", () =>
        root.run("tool", "child", async () => {
          nested++;
        }),
      ),
    ).rejects.toMatchObject({ code: "root_nested_leaf" });
    expect(nested).toBe(0);
    expect(root.snapshot()).toMatchObject({ active: 0, workAttempts: 1 });
    await expect(root.run("tool", "next", async () => 42)).resolves.toBe(42);
  });
  it("releases thrown operations once and does not replenish attempt allowance", async () => {
    const root = new RootExecutionController({ maxWorkAttempts: 1 });
    await expect(
      root.run("tool", "failed", async () => {
        throw new Error("effect failed");
      }),
    ).rejects.toThrow("effect failed");
    let outbound = 0;
    await expect(
      root.run("tool", "retry", async () => {
        outbound++;
      }),
    ).rejects.toMatchObject({ code: "root_attempt_limit" });
    expect(outbound).toBe(0);
    expect(root.snapshot()).toMatchObject({ active: 0, workAttempts: 1 });
  });
  it("keeps started work owned until it settles after cancellation", async () => {
    const cancel = new AbortController();
    const gate = deferred();
    const root = new RootExecutionController({ maxConcurrentWork: 1 }, { signal: cancel.signal });
    const running = root.run("tool", "running", async () => {
      await gate.promise;
    });
    await tick();
    cancel.abort();
    expect(root.snapshot().active).toBe(1);
    await expect(root.run("tool", "late", async () => {})).rejects.toMatchObject({ code: "root_cancelled" });
    gate.resolve();
    await running;
    expect(root.snapshot().active).toBe(0);
  });
  it("stops queued work on the retained absolute deadline", async () => {
    vi.useFakeTimers();
    const root = new RootExecutionController({ maxConcurrentWork: 1 }, { deadline: Date.now() + 10 });
    const lease = await root.acquire("model", "live");
    const queued = root.run("tool", "later", async () => "unsafe").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(11);
    expect(await queued).toMatchObject({ code: "root_deadline" });
    await lease.release();
    expect(root.snapshot()).toMatchObject({ queued: 0, active: 0, workAttempts: 1 });
  });
  it("holds streaming provider capacity across yields and releases on return", async () => {
    const root = new RootExecutionController({ maxConcurrentWork: 1 });
    const model: ModelProvider = {
      providerId: "fixture",
      modelId: "fixture",
      generate: async () => answer,
      async *stream() {
        yield { type: "text", text: "partial" };
        yield { type: "finish", finishReason: "stop", usage: answer.usage };
      },
    };
    const provider = withRootExecutionProvider(model, root, "agent");
    const stream = provider.stream([]);
    await stream.next();
    let started = 0;
    const next = root.run("tool", "wait", async () => {
      started++;
    });
    await tick();
    try {
      expect(started).toBe(0);
      expect(root.snapshot().active).toBe(1);
    } finally {
      await stream.return(undefined);
      await next;
    }
    expect(root.snapshot()).toMatchObject({ active: 0, workAttempts: 2 });
  });
});

describe("root lifetime accounting and durable port", () => {
  it("reserves an entire expansion atomically, deduplicates recovery and never refunds removals", async () => {
    const root = new RootExecutionController({ maxExpandedNodes: 3, maxPlanRevisions: 1 });
    await root.expand(["a", "b"]);
    await root.expand(["a", "b"]);
    await root.revision("r1");
    await root.revision("r1");
    await expect(root.expand(["c", "d"])).rejects.toMatchObject({ code: "root_expansion_limit" });
    expect(root.snapshot()).toMatchObject({ expandedNodes: 2, planRevisions: 1 });
    await root.expand(["c"]);
    await expect(root.revision("r2")).rejects.toMatchObject({ code: "root_revision_limit" });
    expect(root.snapshot().expandedNodes).toBe(3);
  });
  it("restores attempts and expansions and rejects widened limits or changed deadlines", async () => {
    let stored: RootExecutionCounts | undefined;
    const persistence = {
      update: async (mutate: (current: RootExecutionCounts | undefined) => RootExecutionCounts) => {
        stored = structuredClone(mutate(stored === undefined ? undefined : structuredClone(stored)));
        return structuredClone(stored);
      },
    };
    const limits = { maxWorkAttempts: 2, maxExpandedNodes: 2 };
    const deadline = Date.now() + 60_000;
    const first = new RootExecutionController(limits, { persistence, deadline });
    await first.expand(["a"]);
    await first.run("tool", "one", async () => {});
    const second = new RootExecutionController(limits, { persistence, deadline });
    await second.expand(["a", "b"]);
    await second.run("tool", "two", async () => {});
    await expect(second.run("tool", "three", async () => {})).rejects.toMatchObject({ code: "root_attempt_limit" });
    expect(second.snapshot()).toMatchObject({ expandedNodes: 2, workAttempts: 2 });
    await expect(
      new RootExecutionController({ maxWorkAttempts: 3, maxExpandedNodes: 2 }, { persistence, deadline }).expand([]),
    ).rejects.toMatchObject({ code: "root_state_invalid" });
    await expect(
      new RootExecutionController(limits, { persistence, deadline: deadline + 1 }).expand([]),
    ).rejects.toMatchObject({ code: "root_state_invalid" });
  });
  it("rejects corrupt restored accounting and never dispatches after persistence failure", async () => {
    const bad = new RootExecutionController(
      {},
      {
        persistence: {
          update: async () => ({ schemaVersion: 1, limits: {}, expandedIds: [], revisionIds: [], workAttempts: -1 }),
        },
      },
    );
    let effects = 0;
    await expect(
      bad.run("tool", "bad", async () => {
        effects++;
      }),
    ).rejects.toMatchObject({ code: "root_state_invalid" });
    const failed = new RootExecutionController(
      {},
      {
        persistence: {
          update: async () => {
            throw new Error("store unavailable");
          },
        },
      },
    );
    await expect(
      failed.run("tool", "fail", async () => {
        effects++;
      }),
    ).rejects.toThrow("store unavailable");
    expect(effects).toBe(0);
    expect(failed.snapshot().active).toBe(0);
  });
});

describe("root integration boundaries", () => {
  it("limits two independent Agent tool batches and model requests using the same root", async () => {
    const root = new RootExecutionController({ maxConcurrentWork: 2 });
    let active = 0;
    let highWater = 0;
    let effects = 0;
    const work = async () => {
      highWater = Math.max(highWater, ++active);
      await tick();
      active--;
    };
    const tools = [0, 1, 2].map((i) =>
      defineTool({
        name: `tool${i}`,
        description: "fixture",
        parameters: z.object({}),
        execute: async () => {
          effects++;
          await work();
          return "done";
        },
      }),
    );
    const agents = ["a", "b"].map((name) => {
      let calls = 0;
      const provider: ModelProvider = {
        providerId: "fixture",
        modelId: "fixture",
        generate: async () => {
          await work();
          return ++calls === 1
            ? {
                ...answer,
                message: {
                  role: "assistant",
                  content: null,
                  toolCalls: tools.map((tool, i) => ({ id: `${name}:${i}`, name: tool.name, arguments: {} })),
                },
                finishReason: "tool_calls",
              }
            : answer;
        },
        async *stream() {
          yield { type: "finish", finishReason: "stop", usage: answer.usage };
        },
      };
      return new Agent({ name, model: provider, tools, register: false });
    });
    const outputs = await Promise.all(
      agents.map((agent) => agent.run("task", { rootExecution: root, ephemeral: true })),
    );
    expect(outputs.map((output) => output.status)).toEqual(["completed", "completed"]);
    expect(effects).toBe(6);
    expect(highWater).toBeLessThanOrEqual(2);
    expect(root.snapshot()).toMatchObject({ active: 0, workAttempts: 10 });
  });
  it("lets journaled tools reuse a result outside attempt admission while preserving schema and grants", async () => {
    const root = new RootExecutionController({ maxWorkAttempts: 0 });
    let effects = 0;
    const tool = defineTool({
      name: "read",
      description: "fixture",
      parameters: z.object({ id: z.string() }),
      execute: async () => {
        effects++;
        return "live";
      },
    });
    let reused = 0;
    const services = executionFixture({
      rootExecution: root,
      invokeTool: async () => {
        reused++;
        return "saved";
      },
    });
    const ctx = new RunContext({ sessionId: "child", eventBus: new EventBus(), executionServices: services });
    const executor = new ToolExecutor([tool]);
    const [result] = await executor.executeAll([{ id: "call", name: "read", arguments: { id: "known" } }], ctx);
    expect(result.result).toBe("saved");
    expect(effects).toBe(0);
    expect(root.snapshot().workAttempts).toBe(0);
    expect(reused).toBe(1);
    const [invalid] = await executor.executeAll([{ id: "bad", name: "read", arguments: {} }], ctx);
    expect(invalid.error).toMatch(/Invalid arguments/);
    expect(reused).toBe(1);
  });
  it("releases tool capacity before toModelOutput starts a controlled model operation", async () => {
    const root = new RootExecutionController({ maxConcurrentWork: 1 });
    const tool = defineTool({
      name: "format",
      description: "fixture",
      parameters: z.object({}),
      execute: async () => "raw",
      toModelOutput: async () => root.run("model", "formatting", async () => "formatted"),
    });
    const [result] = await new ToolExecutor([tool]).executeAll(
      [{ id: "call", name: "format", arguments: {} }],
      context(root),
    );
    expect(result.result).toBe("formatted");
    expect(root.snapshot()).toMatchObject({ active: 0, workAttempts: 2 });
  });
  it("limits nested graphs and repeated Agent orchestration without parent slots", async () => {
    const root = new RootExecutionController({ maxConcurrentWork: 1 });
    let active = 0;
    let highWater = 0;
    const effect = (name: string): StepDef<Record<string, unknown>> => ({
      name,
      run: async () => {
        highWater = Math.max(highWater, ++active);
        await tick();
        active--;
        return { [name]: true };
      },
    });
    const steps: StepDef<Record<string, unknown>>[] = [
      {
        name: "outer",
        parallel: [
          {
            name: "loop",
            repeat: [
              {
                name: "nested",
                graph: [
                  { id: "a", step: effect("a") },
                  { id: "b", step: effect("b") },
                ],
              },
            ],
            while: (_state, i) => i < 2,
            maxIterations: 2,
          },
          {
            name: "sibling",
            graph: [
              { id: "c", step: effect("c") },
              { id: "d", step: effect("d") },
            ],
          },
        ],
      },
    ];
    const outcome = await new StepRunner().executeSteps(steps, {}, context(root));
    expect(outcome.results.every((result) => result.status === "done")).toBe(true);
    expect(highWater).toBe(1);
    expect(root.snapshot()).toMatchObject({ active: 0, workAttempts: 6 });
  });
  it("rejects the entire next graph episode before its effects when expansion is exhausted", async () => {
    const root = new RootExecutionController({ maxExpandedNodes: 2 });
    let effects = 0;
    const step: StepDef<Record<string, unknown>> = {
      name: "episode",
      graph: [0, 1].map((id) => ({
        id: String(id),
        step: {
          name: `effect${id}`,
          run: async () => {
            effects++;
            return {};
          },
        },
      })),
    };
    await expect(new StepRunner().executeSteps([step], {}, context(root))).rejects.toMatchObject({
      code: "root_expansion_limit",
    });
    expect(effects).toBe(0);
    expect(root.snapshot().expandedNodes).toBe(1);
  });
});

describe("recovery descriptor and root authority", () => {
  const provider: ModelProvider = {
    providerId: "fixture",
    modelId: "fixture",
    generate: async () => answer,
    async *stream() {
      yield { type: "finish", finishReason: "stop", usage: answer.usage };
    },
  };
  it("reports static tool names without credentials and flags config outside recoverable ports", () => {
    const tool = defineTool({
      name: "approved",
      description: "fixture",
      parameters: z.object({}),
      execute: async () => "done",
    });
    const supported = new Agent({
      name: "safe",
      model: provider,
      tools: [tool],
      maxTokens: 20,
      maxToolRoundtrips: 2,
      register: false,
    });
    expect(supported.getRecoveryDescriptor()).toEqual({ toolNames: ["approved"], unsupported: [] });
    const unsupported = new Agent({
      name: "unsafe",
      model: provider,
      maxTokens: 20,
      toolResolver: async () => [],
      instructions: () => "dynamic",
      hooks: { beforeRun: async () => {} },
      register: false,
    });
    const descriptor = unsupported.getRecoveryDescriptor();
    expect(descriptor.unsupported).toEqual(expect.arrayContaining(["toolResolver", "instructions_callback", "hooks"]));
    expect(Object.keys(descriptor).sort()).toEqual(["toolNames", "unsupported"]);
  });
  it("cannot replace the host root with a separately configured controller", () => {
    const host = new RootExecutionController({ maxWorkAttempts: 0 });
    const replacement = new RootExecutionController({ maxWorkAttempts: 10 });
    const services = executionFixture({ rootExecution: host });
    expect(
      () =>
        new RunContext({
          sessionId: "child",
          eventBus: new EventBus(),
          executionServices: services,
          rootExecution: replacement,
        }),
    ).toThrow(/root.*controller/i);
  });
});

describe("leased ownership and cumulative dispatch boundaries", () => {
  it("cannot execute concurrent work twice through one acquired stream permit", async () => {
    const root = new RootExecutionController({ maxConcurrentWork: 1 });
    const lease = await root.acquire("model", "stream");
    const gate = deferred();
    let extra = 0;
    const running = lease.run(async () => {
      await gate.promise;
    });
    try {
      await expect(
        lease.run(async () => {
          extra++;
        }),
      ).rejects.toMatchObject({ code: "root_state_invalid" });
      expect(extra).toBe(0);
    } finally {
      gate.resolve();
      await running;
      await lease.release();
    }
  });
  it("cannot release a permit early while its leaf callback is still running", async () => {
    const root = new RootExecutionController({ maxConcurrentWork: 1 });
    const lease = await root.acquire("tool", "owned");
    const gate = deferred();
    const running = lease.run(async () => {
      await gate.promise;
    });
    try {
      await expect(lease.release()).rejects.toMatchObject({ code: "root_state_invalid" });
      expect(root.snapshot().active).toBe(1);
    } finally {
      gate.resolve();
      await running;
      await lease.release();
    }
    await lease.release();
    expect(root.snapshot().active).toBe(0);
  });
  it("reexecuted persistence callbacks do not double-charge discarded CAS attempts", async () => {
    let stored: RootExecutionCounts | undefined;
    const root = new RootExecutionController(
      { maxWorkAttempts: 2 },
      {
        persistence: {
          update: async (mutate) => {
            mutate(stored);
            stored = mutate(stored);
            return structuredClone(stored);
          },
        },
      },
    );
    await root.run("tool", "one", async () => {});
    await root.run("model", "two", async () => {});
    expect(root.snapshot().workAttempts).toBe(2);
    expect(stored?.workAttempts).toBe(2);
  });
  it("observer exceptions cannot leak an admitted permit", async () => {
    const root = new RootExecutionController(
      { maxConcurrentWork: 1 },
      {
        onEvent: () => {
          throw new Error("observer failed");
        },
      },
    );
    await expect(root.run("tool", "one", async () => 1)).resolves.toBe(1);
    await expect(root.run("tool", "two", async () => 2)).resolves.toBe(2);
    expect(root.snapshot()).toMatchObject({ active: 0, queued: 0, workAttempts: 2 });
  });
  it("zero lifetime allowances reject new work while empty recovery lookup remains valid", async () => {
    const root = new RootExecutionController({ maxExpandedNodes: 0, maxPlanRevisions: 0, maxWorkAttempts: 0 });
    await root.expand([]);
    await expect(root.expand(["a"])).rejects.toMatchObject({ code: "root_expansion_limit" });
    await expect(root.revision("r1")).rejects.toMatchObject({ code: "root_revision_limit" });
    await expect(root.run("tool", "a", async () => "unsafe")).rejects.toMatchObject({ code: "root_attempt_limit" });
    expect(root.snapshot()).toMatchObject({ expandedNodes: 0, planRevisions: 0, workAttempts: 0 });
    expect(() => new RootExecutionController({ maxConcurrentWork: 0 })).toThrow();
  });
  it("preserves legacy serial names and metadata when aggregate limits are omitted", async () => {
    const ctx = new RunContext({ sessionId: "legacy", eventBus: new EventBus(), metadata: { original: true } });
    let effects = 0;
    const result = await new StepRunner().executeSteps(
      [
        {
          name: "legacy\ud800",
          run: async () => {
            effects++;
            return {};
          },
        },
      ],
      {},
      ctx,
    );
    expect(effects).toBe(1);
    expect(result.results[0].status).toBe("done");
    expect(ctx.metadata).toEqual({ original: true });
  });
  it("retains distinct duplicate-name serial expansions across stepwise continuation", async () => {
    const root = new RootExecutionController({ maxExpandedNodes: 2 });
    const ctx = context(root);
    const runner = new StepRunner();
    const step = { name: "same", run: async () => ({}) };
    ctx.metadata.workflowStepOffset = 0;
    await runner.executeSteps([step], {}, ctx);
    ctx.metadata.workflowStepOffset = 1;
    await runner.executeSteps([step], {}, ctx);
    expect(root.snapshot().expandedNodes).toBe(2);
    ctx.metadata.workflowStepOffset = 0;
    await runner.executeSteps([step], {}, ctx);
    expect(root.snapshot().expandedNodes).toBe(2);
  });
});

describe("materialization and nested Agent boundaries", () => {
  it("captures local graph limits before a factory can mutate its declaration", async () => {
    const root = new RootExecutionController({ maxConcurrentWork: 3 });
    let active = 0;
    let highWater = 0;
    const step: import("../../workflow/types.js").GraphStep<Record<string, unknown>> = {
      name: "episode",
      maxConcurrency: 1,
      graph: () => {
        step.maxConcurrency = 3;
        return [0, 1, 2].map((id) => ({
          id: String(id),
          step: {
            name: `effect${id}`,
            run: async () => {
              highWater = Math.max(highWater, ++active);
              await tick();
              active--;
              return {};
            },
          },
        }));
      },
    };
    await new StepRunner().executeSteps([step], {}, context(root));
    expect(highWater).toBe(1);
  });
  it("finishes a repeated nested graph containing a real Agent and tools at aggregate capacity one", async () => {
    const root = new RootExecutionController({ maxConcurrentWork: 1, maxExpandedNodes: 7 });
    let active = 0;
    let highWater = 0;
    let effects = 0;
    const work = async () => {
      highWater = Math.max(highWater, ++active);
      await tick();
      active--;
    };
    const tool = defineTool({
      name: "read",
      description: "fixture",
      parameters: z.object({}),
      execute: async () => {
        effects++;
        await work();
        return "observed";
      },
    });
    const provider: ModelProvider = {
      providerId: "fixture",
      modelId: "fixture",
      generate: async (messages) => {
        await work();
        return messages.at(-1)?.role === "tool"
          ? answer
          : {
              ...answer,
              message: { role: "assistant", content: null, toolCalls: [{ id: "read", name: "read", arguments: {} }] },
              finishReason: "tool_calls",
            };
      },
      async *stream() {
        yield { type: "finish", finishReason: "stop", usage: answer.usage };
      },
    };
    const agent = new Agent({
      name: "bounded",
      model: provider,
      tools: [tool],
      maxTokens: 10,
      maxToolRoundtrips: 1,
      register: false,
    });
    const steps: StepDef<Record<string, unknown>>[] = [
      {
        name: "repeat",
        while: (_state, iteration) => iteration < 2,
        maxIterations: 2,
        repeat: [
          {
            name: "nested",
            graph: [
              { id: "agent", step: { name: "agent", agent } },
              {
                id: "function",
                step: {
                  name: "function",
                  run: async () => {
                    await work();
                    return { side: true };
                  },
                },
              },
            ],
          },
        ],
      },
    ];
    const result = await new StepRunner().executeSteps(steps, {}, context(root));
    expect(result.results.every((entry) => entry.status === "done")).toBe(true);
    expect(effects).toBe(2);
    expect(highWater).toBe(1);
    expect(root.snapshot()).toMatchObject({ active: 0, queued: 0, expandedNodes: 7, workAttempts: 8 });
  });
});
