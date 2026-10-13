import { describe, expect, it, vi } from "vitest";
import { WorkflowCancellationError, WorkflowDefinitionError, WorkflowMergeConflict } from "../errors.js";
import { executeWorkflowGraph, validateWorkflowSteps } from "../graph-runner.js";
import type { GraphStep, StepDef, StepResult, WorkflowGraphNode } from "../types.js";

type State = Record<string, unknown>;

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function node<T extends State = State>(id: string, options: Partial<WorkflowGraphNode<T>> = {}): WorkflowGraphNode<T> {
  return { id, step: { name: id, run: async () => ({}) }, ...options };
}

function graph<T extends State = State>(
  nodes: WorkflowGraphNode<T>[],
  options: Partial<GraphStep<T>> = {},
): GraphStep<T> {
  return { name: "episode", graph: nodes, ...options };
}

function done<T extends State>(stepName: string, patch: Partial<T> = {}): { patch: Partial<T>; results: StepResult[] } {
  return { patch, results: [{ stepName, status: "done", durationMs: 0 }] };
}

async function turn() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("workflow dependency scheduler", () => {
  it.each([false, true])(
    "joins patches and flat results in stable topology despite inverted completion (%s)",
    async (reverse) => {
      const gate = deferred();
      const result = await executeWorkflowGraph(
        graph([node("last", { inputsFrom: ["first"] }), node("first"), node("sibling")], {
          merge: "declaration_order",
        }),
        { value: 0 },
        undefined,
        async (entry) => {
          if (entry.id === (reverse ? "first" : "sibling")) await gate.promise;
          if (entry.id === (reverse ? "sibling" : "first")) gate.resolve();
          return done(entry.step.name, { value: entry.id });
        },
      );
      expect(result.patch).toEqual({ value: "sibling" });
      expect(result.results.map((entry) => entry.stepName)).toEqual(["first", "last", "sibling"]);
    },
  );

  it("starts each ready node without waiting for an unrelated running branch", async () => {
    const a = deferred();
    const b = deferred();
    const c = deferred();
    const d = deferred();
    const gates: Record<string, ReturnType<typeof deferred>> = { A: a, B: b, C: c, D: d };
    const started: string[] = [];
    const pending = executeWorkflowGraph(
      graph([
        node("A"),
        node("B"),
        node("C", { dependsOn: ["A"] }),
        node("D", { dependsOn: ["A", "B"] }),
        node("E", { dependsOn: ["C", "D"] }),
      ]),
      {},
      undefined,
      async (entry) => {
        started.push(entry.id);
        const gate = gates[entry.id];
        await gate?.promise;
        return done(entry.step.name, { [entry.id]: true });
      },
    );
    await turn();
    expect(started).toEqual(["A", "B"]);
    a.resolve();
    await turn();
    expect(started).toEqual(["A", "B", "C"]);
    b.resolve();
    await turn();
    expect(started).toEqual(["A", "B", "C", "D"]);
    c.resolve();
    await turn();
    expect(started).not.toContain("E");
    d.resolve();
    expect((await pending).results.map((entry) => entry.stepName)).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("caps running admissions and starts the next ready declaration after a slot settles", async () => {
    const first = deferred();
    const second = deferred();
    const started: string[] = [];
    let running = 0;
    let peak = 0;
    const result = executeWorkflowGraph(
      graph([node("one"), node("two"), node("three"), node("four")], { maxConcurrency: 2 }),
      {},
      undefined,
      async (entry) => {
        started.push(entry.id);
        running++;
        peak = Math.max(peak, running);
        if (entry.id === "one") await first.promise;
        if (entry.id === "two") await second.promise;
        running--;
        return done(entry.step.name);
      },
    );
    await turn();
    expect(started).toEqual(["one", "two"]);
    second.resolve();
    await turn();
    expect(started).toEqual(["one", "two", "three", "four"]);
    first.resolve();
    await result;
    expect(peak).toBe(2);
  });

  it("uses only transitive data ancestry and isolates nested base, inputs and settled patches", async () => {
    type DeepState = { nested: { count: number }; a?: { items: number[] }; b?: number; c?: boolean };
    const original: DeepState = { nested: { count: 0 } };
    const retained = { items: [1] };
    const seen: Record<string, DeepState> = {};
    const result = await executeWorkflowGraph(
      graph<DeepState>(
        [
          node("A"),
          node("B"),
          node("C", { inputsFrom: ["A"], dependsOn: ["B"] }),
          node("D", { inputsFrom: ["C"] }),
          node("control", { dependsOn: ["A"] }),
        ],
        { maxConcurrency: 1 },
      ),
      original,
      undefined,
      async (entry, input) => {
        seen[entry.id] = structuredClone(input);
        input.nested.count = 99;
        if (entry.id === "A") return done(entry.step.name, { a: retained });
        if (entry.id === "B") {
          retained.items.push(2);
          return done(entry.step.name, { b: 7 });
        }
        if (entry.id === "C") {
          input.a?.items.push(3);
          return done(entry.step.name, { c: true });
        }
        return done(entry.step.name);
      },
    );
    expect(original).toEqual({ nested: { count: 0 } });
    expect(seen.B).toEqual({ nested: { count: 0 } });
    expect(seen.C).toEqual({ nested: { count: 0 }, a: { items: [1] } });
    expect(seen.D).toEqual({ nested: { count: 0 }, a: { items: [1] }, c: true });
    expect(seen.control).toEqual({ nested: { count: 0 } });
    expect(result.patch).toEqual({ a: { items: [1] }, b: 7, c: true });
  });

  it("copies and freezes dependency arrays so callback mutation cannot rewrite topology", async () => {
    const dependencies = ["A"];
    const nodes = [node("A"), node("B", { dependsOn: dependencies })];
    const seen: string[] = [];
    await executeWorkflowGraph(graph(nodes), {}, undefined, async (entry) => {
      seen.push(entry.id);
      if (entry.id === "A") dependencies.push("missing");
      else {
        expect(entry.dependsOn).toEqual(["A"]);
        expect(Object.isFrozen(entry.dependsOn)).toBe(true);
      }
      return done(entry.step.name);
    });
    expect(seen).toEqual(["A", "B"]);
  });

  it("releases skipped control gates and blocks skipped data gates without their patches", async () => {
    const started: string[] = [];
    const result = await executeWorkflowGraph(
      graph([
        node("optional"),
        node("control", { dependsOn: ["optional"] }),
        node("data", { inputsFrom: ["optional"] }),
      ]),
      {},
      undefined,
      async (entry) => {
        started.push(entry.id);
        if (entry.id === "optional") {
          return { patch: { ignored: true }, results: [{ stepName: "optional", status: "skipped", durationMs: 0 }] };
        }
        return done(entry.step.name, { control: true });
      },
    );
    expect(started).toEqual(["optional", "control"]);
    expect(result.patch).toEqual({ control: true });
    expect(result.results[2]).toMatchObject({
      stepName: "data",
      status: "skipped",
      durationMs: 0,
      reason: { code: "workflow_dependency_blocked" },
    });
  });

  it("blocks failed descendants transitively while joining successful independent work and never retrying", async () => {
    const calls: string[] = [];
    const result = await executeWorkflowGraph(
      graph([
        node("failed"),
        node("control", { dependsOn: ["failed"] }),
        node("later", { dependsOn: ["control"] }),
        node("data", { inputsFrom: ["failed"] }),
        node("independent"),
      ]),
      {},
      undefined,
      async (entry) => {
        calls.push(entry.id);
        if (entry.id === "failed") throw new Error("ordinary failure");
        return done(entry.step.name, { independent: true });
      },
    );
    expect(calls).toEqual(["failed", "independent"]);
    expect(result.patch).toEqual({ independent: true });
    expect(result.results.map((entry) => [entry.stepName, entry.status])).toEqual([
      ["failed", "error"],
      ["control", "skipped"],
      ["later", "skipped"],
      ["data", "skipped"],
      ["independent", "done"],
    ]);
    expect(result.results.slice(1, 4).every((entry) => entry.reason?.code === "workflow_dependency_blocked")).toBe(
      true,
    );
  });

  it("discards patches from nested child failures even when a callback returns a done parent", async () => {
    const result = await executeWorkflowGraph(
      graph([node("group"), node("consumer", { inputsFrom: ["group"] })]),
      {},
      undefined,
      async () => ({
        patch: { leaked: true },
        results: [
          { stepName: "group", status: "done", durationMs: 0 },
          { stepName: "child", status: "error", durationMs: 0 },
        ],
      }),
    );
    expect(result.patch).toEqual({});
    expect(result.results.map((entry) => [entry.stepName, entry.status])).toEqual([
      ["group", "done"],
      ["child", "error"],
      ["consumer", "skipped"],
    ]);
  });

  it("rejects same-value writes by incomparable nodes before admitting their join", async () => {
    const entered = deferred();
    const release = deferred();
    const calls: string[] = [];
    const pending = executeWorkflowGraph(
      graph([node("A"), node("B"), node("join", { dependsOn: ["A", "B"] })]),
      { value: 0 },
      undefined,
      async (entry) => {
        calls.push(entry.id);
        if (entry.id === "B") {
          entered.resolve();
          await release.promise;
        }
        return done(entry.step.name, { value: 0 });
      },
    );
    const rejection = expect(pending).rejects.toMatchObject({
      code: "workflow_merge_conflict",
      conflictingKeys: ["value"],
    });
    await entered.promise;
    release.resolve();
    await rejection;
    expect(calls).toEqual(["A", "B"]);
  });

  it("allows ordered rewrites through control ancestry without injecting the ancestor data", async () => {
    const values: Record<string, number> = { A: 1, B: 2, C: 0 };
    const result = await executeWorkflowGraph(
      graph([node("C", { dependsOn: ["B"] }), node("B", { dependsOn: ["A"] }), node("A")]),
      { value: 0 },
      undefined,
      async (entry, input) => {
        expect(input).toEqual({ value: 0 });
        return done(entry.step.name, { value: values[entry.id] });
      },
    );
    expect(result.patch).toEqual({ value: 0 });
    expect(result.results.map((entry) => entry.stepName)).toEqual(["A", "B", "C"]);
  });

  it.each([
    new WorkflowCancellationError("fatal"),
    new WorkflowDefinitionError("invalid nested factory"),
    new WorkflowMergeConflict("nested", ["value"]),
  ])("stops admissions on fatal $name and drains every started promise", async (error) => {
    const running = deferred();
    const release = deferred();
    const calls: string[] = [];
    let settled = false;
    const result = executeWorkflowGraph(
      graph([node("fatal"), node("running"), node("unstarted")], { maxConcurrency: 2 }),
      {},
      undefined,
      async (entry) => {
        calls.push(entry.id);
        if (entry.id === "fatal") {
          await running.promise;
          throw error;
        }
        running.resolve();
        await release.promise;
        return done(entry.step.name, { late: true });
      },
    );
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejection = expect(result).rejects.toBe(error);
    await turn();
    expect(settled).toBe(false);
    expect(calls).toEqual(["fatal", "running"]);
    release.resolve();
    await rejection;
  });

  it("drains an uncooperative callback on signal abort and discards late successful patches", async () => {
    const controller = new AbortController();
    const release = deferred();
    const started: string[] = [];
    let settled = false;
    const result = executeWorkflowGraph(
      graph([node("running"), node("unstarted")], { maxConcurrency: 1 }),
      {},
      controller.signal,
      async (entry) => {
        started.push(entry.id);
        await release.promise;
        return done(entry.step.name, { late: true });
      },
    );
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const reason = new Error("abort reason");
    const rejection = expect(result).rejects.toBe(reason);
    await turn();
    controller.abort(reason);
    await turn();
    expect(settled).toBe(false);
    expect(started).toEqual(["running"]);
    release.resolve();
    await rejection;
  });

  it("materializes factories once from an isolated entry snapshot and bounds generated episodes before effects", async () => {
    const original = { nested: { count: 0 } };
    const factory = vi.fn((state: typeof original) => {
      state.nested.count = 100;
      return [node<typeof original>("A"), node<typeof original>("B")];
    });
    const execute = vi.fn(async (entry: WorkflowGraphNode<typeof original>) => done(entry.step.name));
    await expect(
      executeWorkflowGraph({ name: "factory", graph: factory, maxNodes: 1 }, original, undefined, execute),
    ).rejects.toBeInstanceOf(WorkflowDefinitionError);
    expect(factory).toHaveBeenCalledOnce();
    expect(original).toEqual({ nested: { count: 0 } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps factory mutation out of node input and propagates factory failures", async () => {
    const cause = new Error("factory failed");
    const execute = vi.fn(async (entry: WorkflowGraphNode<{ n: number }>, input: { n: number }) => {
      expect(input.n).toBe(0);
      return done(entry.step.name);
    });
    await executeWorkflowGraph(
      {
        name: "factory",
        graph: (state) => {
          state.n = 8;
          return [node("A")];
        },
      },
      { n: 0 },
      undefined,
      execute,
    );
    await expect(
      executeWorkflowGraph(
        {
          name: "factory",
          graph: () => {
            throw cause;
          },
        },
        { n: 0 },
        undefined,
        execute,
      ),
    ).rejects.toBe(cause);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects unclonable graph entry state before any node effects", async () => {
    const execute = vi.fn(async (entry: WorkflowGraphNode<State>) => done(entry.step.name));
    await expect(
      executeWorkflowGraph(graph([node("A")]), { callback: () => {} }, undefined, execute),
    ).rejects.toBeInstanceOf(WorkflowDefinitionError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("treats unclonable successful patches as fatal and drains started siblings", async () => {
    const release = deferred();
    const calls: string[] = [];
    let settled = false;
    const result = executeWorkflowGraph(
      graph([node("bad"), node("running"), node("unstarted")], { maxConcurrency: 2 }),
      {},
      undefined,
      async (entry) => {
        calls.push(entry.id);
        if (entry.id === "bad") return done(entry.step.name, { callback: () => {} });
        await release.promise;
        return done(entry.step.name);
      },
    );
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejection = expect(result).rejects.toBeInstanceOf(WorkflowDefinitionError);
    await turn();
    expect(settled).toBe(false);
    expect(calls).toEqual(["bad", "running"]);
    release.resolve();
    await rejection;
  });

  it("accepts an empty episode and defers nested graph factories until their own entry", async () => {
    expect(await executeWorkflowGraph(graph([]), {}, undefined, async (entry) => done(entry.step.name))).toEqual({
      patch: {},
      results: [],
    });
    const nestedFactory = vi.fn(() => [node("nested")]);
    const result = await executeWorkflowGraph(
      graph([node("outer", { step: { name: "outer", graph: nestedFactory } })]),
      {},
      undefined,
      async (entry) => done(entry.step.name),
    );
    expect(result.results).toEqual([{ stepName: "outer", status: "done", durationMs: 0 }]);
    expect(nestedFactory).not.toHaveBeenCalled();
  });

  const invalidDefinitions: [string, unknown][] = [
    ["duplicate IDs", graph([node("same"), node("same")])],
    ["empty ID", graph([node(" ")])],
    ["missing reference", graph([node("A", { dependsOn: ["missing"] })])],
    ["self reference", graph([node("A", { inputsFrom: ["A"] })])],
    ["duplicate control edges", graph([node("A"), node("B", { dependsOn: ["A", "A"] })])],
    ["duplicate data edges", graph([node("A"), node("B", { inputsFrom: ["A", "A"] })])],
    ["union cycle", graph([node("A", { inputsFrom: ["B"] }), node("B", { dependsOn: ["A"] })])],
    ["invalid graph array", { name: "episode", graph: {} }],
    [
      "invalid dependencies",
      { name: "episode", graph: [{ id: "A", step: { name: "A", run: async () => ({}) }, dependsOn: "B" }] },
    ],
    ["invalid concurrency", graph([node("A")], { maxConcurrency: 0 })],
    ["unsafe concurrency", graph([node("A")], { maxConcurrency: Number.MAX_SAFE_INTEGER + 1 })],
    ["fractional node bound", graph([node("A")], { maxNodes: 1.5 })],
    ["invalid merge", { name: "episode", graph: [node("A")], merge: "timing" }],
    [
      "mixed step kinds",
      { name: "episode", graph: [{ id: "A", step: { name: "A", run: async () => ({}), parallel: [] } }] },
    ],
    ["missing callable", { name: "episode", graph: [{ id: "A", step: { name: "A", run: true } }] }],
    ["missing agent run", { name: "episode", graph: [{ id: "A", step: { name: "A", agent: {} } }] }],
    ["missing condition body", { name: "episode", graph: [{ id: "A", step: { name: "A", condition: () => true } }] }],
    [
      "invalid repeat bound",
      { name: "episode", graph: [{ id: "A", step: { name: "A", repeat: [], while: () => true, maxIterations: 0 } }] },
    ],
    ["invalid nested static graph", graph([node("A", { step: graph([node("inner", { dependsOn: ["missing"] })]) })])],
  ];

  it.each(invalidDefinitions)("rejects %s before any node effects", async (_name, definition) => {
    const execute = vi.fn(async (entry: WorkflowGraphNode<State>) => done(entry.step.name));
    await expect(executeWorkflowGraph(definition as GraphStep<State>, {}, undefined, execute)).rejects.toBeInstanceOf(
      WorkflowDefinitionError,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects malformed factory materialization before effects", async () => {
    const execute = vi.fn(async (entry: WorkflowGraphNode<State>) => done(entry.step.name));
    const definition = { name: "factory", graph: () => null } as unknown as GraphStep<State>;
    await expect(executeWorkflowGraph(definition, {}, undefined, execute)).rejects.toBeInstanceOf(
      WorkflowDefinitionError,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("allows one predecessor in both dependency lists", async () => {
    const result = await executeWorkflowGraph(
      graph([node("A"), node("B", { dependsOn: ["A"], inputsFrom: ["A"] })]),
      {},
      undefined,
      async (entry) => done(entry.step.name),
    );
    expect(result.results.map((entry) => entry.stepName)).toEqual(["A", "B"]);
  });

  it("uses the default concurrency bound and captures it before callbacks can mutate the step", async () => {
    const release = deferred();
    const started: string[] = [];
    const definition = graph([node("A"), node("B"), node("C"), node("D"), node("E"), node("F")]);
    const pending = executeWorkflowGraph(definition, {}, undefined, async (entry) => {
      started.push(entry.id);
      definition.maxConcurrency = 100;
      await release.promise;
      return done(entry.step.name);
    });
    await turn();
    expect(started).toEqual(["A", "B", "C", "D", "E"]);
    release.resolve();
    await pending;
    expect(started).toEqual(["A", "B", "C", "D", "E", "F"]);
  });

  it("rejects a pre-aborted episode before invoking its factory", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before entry");
    controller.abort(reason);
    const factory = vi.fn(() => [node("A")]);
    const execute = vi.fn(async (entry: WorkflowGraphNode<State>) => done(entry.step.name));
    await expect(
      executeWorkflowGraph({ name: "factory", graph: factory }, {}, controller.signal, execute),
    ).rejects.toBe(reason);
    expect(factory).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("validates the default maxNodes bound and keeps static depth64 usable", async () => {
    const oversized = Array.from({ length: 101 }, (_, index) => node(`node-${index}`));
    const execute = vi.fn(async (entry: WorkflowGraphNode<State>) => done(entry.step.name));
    await expect(executeWorkflowGraph(graph(oversized), {}, undefined, execute)).rejects.toBeInstanceOf(
      WorkflowDefinitionError,
    );
    expect(execute).not.toHaveBeenCalled();
    let atLimit: StepDef<State> = { name: "leaf", run: async () => ({}) };
    for (let depth = 0; depth < 63; depth++) atLimit = { name: `level-${depth}`, parallel: [atLimit] };
    expect(() => validateWorkflowSteps([atLimit])).not.toThrow();
  });

  it("validates recursive and excessive static nesting before any episode effects", async () => {
    const recursive: StepDef<State> = { name: "recursive", parallel: [] };
    recursive.parallel.push(recursive);
    let tooDeep: StepDef<State> = { name: "leaf", run: async () => ({}) };
    for (let depth = 0; depth < 65; depth++) tooDeep = { name: `level-${depth}`, parallel: [tooDeep] };
    const execute = vi.fn(async (entry: WorkflowGraphNode<State>) => done(entry.step.name));
    for (const step of [recursive, tooDeep]) {
      await expect(
        executeWorkflowGraph(graph([node("A"), node("B", { step })]), {}, undefined, execute),
      ).rejects.toBeInstanceOf(WorkflowDefinitionError);
    }
    expect(execute).not.toHaveBeenCalled();
    expect(() => validateWorkflowSteps([recursive])).toThrow(WorkflowDefinitionError);
  });
});
