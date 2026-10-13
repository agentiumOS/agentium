import { describe, expect, it, vi } from "vitest";
import type { Agent } from "../../agent/agent.js";
import type { RunOpts } from "../../agent/types.js";
import { EventBus } from "../../events/event-bus.js";
import { InMemoryStorage } from "../../storage/in-memory.js";
import { StorageBackedCheckpointStore } from "../checkpoints.js";
import type { GraphStep, RepeatStep, StepDef } from "../types.js";
import { Workflow } from "../workflow.js";

type State = Record<string, unknown> & { count: number; checked: boolean; output?: string };
const initialState: State = { count: 0, checked: false };
const workflow = (steps: StepDef<State>[]) =>
  new Workflow({ name: "execution-graphs", register: false, initialState, steps });

describe("execution graph Workflow integration", () => {
  it("exits a repeat without effects when its first guard is false", async () => {
    const effect = vi.fn(async () => ({ count: 1 }));
    const result = await workflow([
      {
        name: "already-verified",
        repeat: [{ name: "effect", run: effect }],
        while: () => false,
        maxIterations: 1,
      },
    ]).run();
    expect(result.status).toBe("completed");
    expect(result.state).toEqual(initialState);
    expect(effect).not.toHaveBeenCalled();
  });

  it("rejects recursively generated graph composition before any leaf effect", async () => {
    const recursive: GraphStep<State> = {
      name: "recursive",
      graph: () => [{ id: "again", step: recursive }],
    };
    await expect(workflow([recursive]).run()).rejects.toMatchObject({ code: "workflow_definition_invalid" });
  });

  it("joins dependency data before downstream work and preserves ordered overwrites", async () => {
    const observed: State[] = [];
    const graph: GraphStep<State> = {
      name: "pipeline",
      graph: [
        { id: "build", step: { name: "build", run: async () => ({ count: 1 }) } },
        { id: "unrelated", step: { name: "noise", run: async () => ({ output: "unrelated" }) } },
        {
          id: "check",
          inputsFrom: ["build"],
          step: {
            name: "check",
            run: async (state) => {
              observed.push(state);
              return { count: state.count + 1, checked: true };
            },
          },
        },
      ],
    };
    const result = await workflow([graph]).run();
    expect(result.status).toBe("completed");
    expect(result.state).toEqual({ count: 2, checked: true, output: "unrelated" });
    expect(observed).toEqual([{ count: 1, checked: false }]);
    expect(result.stepResults.map((row) => row.stepName)).toEqual(["pipeline", "build", "noise", "check"]);
    expect(result.stepResults.find((row) => row.stepName === "check")?.executionPath).toBe("pipeline/check/check");
  });

  it("replans at each bounded episode and succeeds when the predicate becomes false at the cap", async () => {
    const plans: number[] = [];
    const guards: number[] = [];
    const repeat: RepeatStep<State> = {
      name: "repair",
      maxIterations: 2,
      while: (state, iteration) => {
        guards.push(iteration);
        return !state.checked;
      },
      repeat: [
        {
          name: "episode",
          graph: (state) => {
            plans.push(state.count);
            return [
              {
                id: state.count === 0 ? "try" : "repair",
                step: {
                  name: "update",
                  run: async (input) => ({ count: input.count + 1, checked: input.count === 1 }),
                },
              },
            ];
          },
        },
      ],
    };
    const result = await workflow([repeat]).run();
    expect(result.status).toBe("completed");
    expect(result.state).toEqual({ count: 2, checked: true });
    expect(plans).toEqual([0, 1]);
    expect(guards).toEqual([0, 1, 2]);
    expect(result.stepResults.filter((row) => row.stepName === "update").map((row) => row.executionPath)).toEqual([
      "repair/0/episode/try/update",
      "repair/1/episode/repair/update",
    ]);
  });

  it("reports repeat exhaustion through the Workflow reason and stops later work with stop policy", async () => {
    let effects = 0;
    const later = vi.fn(async () => ({}));
    const wf = new Workflow({
      name: "limited",
      register: false,
      initialState,
      failurePolicy: "stop",
      steps: [
        {
          name: "repair",
          repeat: [
            {
              name: "attempt",
              run: async () => {
                effects++;
                return { count: effects };
              },
            },
          ],
          while: () => true,
          maxIterations: 2,
        },
        { name: "later", run: later },
      ],
    });
    const result = await wf.run();
    expect(effects).toBe(2);
    expect(result).toMatchObject({
      status: "failed",
      reason: { code: "workflow_iteration_limit" },
      state: { count: 2 },
    });
    expect(result.stepResults[0]).toMatchObject({ status: "error", reason: { code: "workflow_iteration_limit" } });
    expect(later).not.toHaveBeenCalled();
    expect(result.stepResults.at(-1)?.status).toBe("skipped");
  });

  it("stops a repair body failure without resetting it into another attempt", async () => {
    const effect = vi.fn(async () => {
      throw new Error("unknown remote acknowledgement");
    });
    const result = await workflow([
      {
        name: "repair",
        repeat: [{ name: "effect", run: effect }],
        while: () => true,
        maxIterations: 5,
      },
    ]).run();
    expect(result.status).toBe("failed");
    expect(effect).toHaveBeenCalledTimes(1);
    expect(result.stepResults.find((row) => row.stepName === "effect")?.error).toContain("unknown remote");
  });

  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid repeat bound %s before effects",
    async (maxIterations) => {
      const effect = vi.fn(async () => ({}));
      await expect(
        workflow([
          {
            name: "repair",
            repeat: [{ name: "effect", run: effect }],
            while: () => true,
            maxIterations,
          },
        ]).run(),
      ).rejects.toMatchObject({ code: "workflow_definition_invalid" });
      expect(effect).not.toHaveBeenCalled();
    },
  );

  it.each(["factory", "predicate"])("honors cancellation during a synchronous %s before new effects", async (where) => {
    const controller = new AbortController();
    const effect = vi.fn(async () => ({}));
    const step: StepDef<State> =
      where === "factory"
        ? {
            name: "graph",
            graph: () => {
              controller.abort(new Error("cancel planning"));
              return [{ id: "a", step: { name: "a", run: effect } }];
            },
          }
        : {
            name: "repeat",
            maxIterations: 2,
            while: () => {
              controller.abort(new Error("cancel planning"));
              return true;
            },
            repeat: [{ name: "a", run: effect }],
          };
    await expect(workflow([step]).run({ signal: controller.signal })).rejects.toThrow("cancel planning");
    expect(effect).not.toHaveBeenCalled();
  });

  it("isolates duplicate Agent names by graph node and repeat iteration without changing output keys", async () => {
    const contexts: RunOpts[] = [];
    const agent = {
      run: async (_input: string, opts: RunOpts) => {
        contexts.push(opts);
        return {
          text: "checked",
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          status: "completed",
        };
      },
    } as unknown as Agent;
    const eventBus = new EventBus();
    const paths: Array<string | undefined> = [];
    eventBus.on("workflow.step", (event) => paths.push(event.executionPath));
    const wf = new Workflow({
      name: "identity",
      register: false,
      initialState,
      eventBus,
      steps: [
        {
          name: "episodes",
          repeat: [
            {
              name: "plan",
              merge: "declaration_order",
              graph: [
                { id: "a/b", step: { name: "same", agent } },
                { id: "b", step: { name: "same", agent } },
              ],
            },
          ],
          while: (_state, iteration) => iteration < 2,
          maxIterations: 2,
        },
      ],
    });
    const result = await wf.run({ sessionId: "root", tenantId: "tenant", userId: "user" });
    expect(result.state.same_output).toBe("checked");
    expect(new Set(contexts.map((opts) => opts.sessionId)).size).toBe(4);
    expect(contexts.map((opts) => opts.sessionId)).toEqual([
      "root:episodes/0/plan/a%2Fb/same",
      "root:episodes/0/plan/b/same",
      "root:episodes/1/plan/a%2Fb/same",
      "root:episodes/1/plan/b/same",
    ]);
    expect(contexts.every((opts) => opts.tenantId === "tenant" && opts.userId === "user")).toBe(true);
    expect(paths).toContain("episodes/0/plan/a%2Fb/same");
  });

  it("continues a saved complete graph boundary without executing its node effects again", async () => {
    const store = new StorageBackedCheckpointStore<State>(new InMemoryStorage());
    let writes = 0;
    let later = 0;
    const wf = new Workflow<State>({
      name: "checkpoint-graph",
      register: false,
      initialState,
      checkpointStore: store,
      definitionVersion: "graph-v1",
      validateCheckpointState: (value) => {
        if (
          !value ||
          typeof value !== "object" ||
          typeof Reflect.get(value, "count") !== "number" ||
          typeof Reflect.get(value, "checked") !== "boolean"
        )
          throw new Error("Invalid state");
        return value as State;
      },
      steps: [
        {
          name: "graph",
          graph: [
            {
              id: "a",
              step: {
                name: "effect",
                run: async () => {
                  writes++;
                  return { count: 1 };
                },
              },
            },
          ],
        },
        {
          name: "later",
          run: async () => {
            later++;
            return { checked: true };
          },
        },
      ],
    });
    const first = await wf.runWithCheckpoints();
    const cp = (await store.listForRun(first.runId)).find((row) => row.stepIndex === 0);
    if (!cp) throw new Error("Missing graph checkpoint");
    const restored = await wf.continueFromCheckpoint(cp.id);
    expect(restored.state).toEqual({ count: 1, checked: true });
    expect(writes).toBe(1);
    expect(later).toBe(2);
    expect(restored.stepResults.find((row) => row.stepName === "effect")?.executionPath).toBe("graph/a/effect");
  });

  it("rejects an incomparable strict join before saving or running downstream effects", async () => {
    const store = new StorageBackedCheckpointStore<State>(new InMemoryStorage());
    const after = vi.fn(async () => ({}));
    const wf = new Workflow({
      name: "conflict",
      register: false,
      initialState,
      checkpointStore: store,
      steps: [
        {
          name: "graph",
          graph: [
            { id: "one", step: { name: "one", run: async () => ({ count: 9 }) } },
            { id: "same", step: { name: "same", run: async () => ({ count: 0 }) } },
          ],
        },
        { name: "after", run: after },
      ],
    });
    await expect(wf.runWithCheckpoints({ runId: "conflicting" })).rejects.toMatchObject({
      code: "workflow_merge_conflict",
    });
    expect(await store.listForRun("conflicting")).toEqual([]);
    expect(after).not.toHaveBeenCalled();
  });
});
