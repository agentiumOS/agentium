import { describe, expect, it, vi } from "vitest";
import type { Agent } from "../../agent/agent.js";
import type { ExecutionServices } from "../../agent/execution-services.js";
import { RunContext } from "../../agent/run-context.js";
import type { RunOutput } from "../../agent/types.js";
import { EventBus } from "../../events/event-bus.js";
import { Workflow } from "../workflow.js";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function child(status: RunOutput["status"], text = "partial"): Agent {
  return {
    run: vi.fn().mockResolvedValue({ text, status, reason: { code: "provider_length", message: "limit" } }),
  } as unknown as Agent;
}

describe("Workflow execution integrity", () => {
  it.each([false, true])(
    "joins owned patches with initialized keys in either settlement order (%s)",
    async (reverse) => {
      const gate = deferred();
      const workflow = new Workflow({
        name: "patches",
        register: false,
        initialState: { a: 0, b: 0 },
        steps: [
          {
            name: "join",
            parallel: [
              {
                name: "a",
                run: async () => {
                  if (reverse) await gate.promise;
                  else gate.resolve();
                  return { a: 1 };
                },
              },
              {
                name: "condition",
                condition: () => true,
                steps: [
                  {
                    name: "b",
                    run: async () => {
                      if (!reverse) await gate.promise;
                      else gate.resolve();
                      return { b: 2 };
                    },
                  },
                ],
              },
            ],
          },
        ],
      });
      expect((await workflow.run()).state).toEqual({ a: 1, b: 2 });
    },
  );

  it("preserves same-value owned writes and declaration order", async () => {
    const workflow = new Workflow({
      name: "order",
      register: false,
      initialState: { n: 0 },
      steps: [
        {
          name: "join",
          parallel: [
            { name: "first", run: async () => ({ n: 7 }) },
            { name: "last", run: async () => ({ n: 0 }) },
          ],
        },
      ],
    });
    expect((await workflow.run()).state.n).toBe(0);
  });

  it("propagates a nested strict join only after its started siblings settle", async () => {
    const gate = deferred();
    const entered = deferred();
    const next = vi.fn().mockResolvedValue({});
    const workflow = new Workflow({
      name: "strict",
      register: false,
      initialState: { n: 0 },
      retryPolicy: { maxRetries: 3, backoffMs: 1 },
      steps: [
        {
          name: "outer",
          parallel: [
            {
              name: "condition",
              condition: () => true,
              steps: [
                {
                  name: "inner",
                  merge: "error",
                  parallel: [
                    { name: "a", run: async () => ({ n: 0 }) },
                    { name: "b", run: async () => ({ n: 2 }) },
                  ],
                },
              ],
            },
            {
              name: "sibling",
              run: async () => {
                entered.resolve();
                await gate.promise;
                return { n: 3 };
              },
            },
          ],
        },
        { name: "next", run: next },
      ],
    });
    let settled = false;
    const result = workflow.run();
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await entered.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve();
    await expect(result).rejects.toMatchObject({
      code: "workflow_merge_conflict",
      stepName: "inner",
      conflictingKeys: ["n"],
    });
    expect(next).not.toHaveBeenCalled();
  });

  it.each(["continue", "stop"] as const)("records failed child output and applies %s policy", async (failurePolicy) => {
    const next = vi.fn().mockResolvedValue({ later: true });
    const workflow = new Workflow({
      name: "partial",
      register: false,
      failurePolicy,
      initialState: { agent_output: "old" },
      steps: [
        { name: "agent", agent: child("stopped") },
        { name: "next", run: next },
      ],
    });
    const result = await workflow.run();
    expect(result.status).toBe("failed");
    expect(result.reason?.code).toBe("workflow_step_failed");
    expect(result.state.agent_output).toBe("old");
    expect(result.stepResults[0]).toMatchObject({
      status: "error",
      output: { text: "partial", status: "stopped", reason: { code: "provider_length" } },
    });
    expect(result.stepResults[1].status).toBe(failurePolicy === "stop" ? "skipped" : "done");
    expect(next).toHaveBeenCalledTimes(failurePolicy === "stop" ? 0 : 1);
  });

  it("joins successful sibling patches while stopping subsequent serial work", async () => {
    const next = vi.fn().mockResolvedValue({});
    const workflow = new Workflow({
      name: "partial-join",
      register: false,
      failurePolicy: "stop",
      initialState: { n: 0 },
      steps: [
        {
          name: "join",
          parallel: [
            { name: "failed", agent: child("error") },
            { name: "ok", run: async () => ({ n: 2 }) },
          ],
        },
        { name: "next", run: next },
      ],
    });
    const result = await workflow.run();
    expect(result.state.n).toBe(2);
    expect(result.status).toBe("failed");
    expect(next).not.toHaveBeenCalled();
  });

  it("treats a cancelled child as structural cancellation", async () => {
    const next = vi.fn().mockResolvedValue({});
    const workflow = new Workflow({
      name: "cancelled-child",
      register: false,
      initialState: {},
      steps: [
        { name: "child", agent: child("cancelled") },
        { name: "next", run: next },
      ],
    });
    await expect(workflow.run()).rejects.toMatchObject({ code: "workflow_cancelled" });
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a late function patch after abort and never completes", async () => {
    const controller = new AbortController();
    const bus = new EventBus();
    const complete = vi.fn();
    bus.on("run.complete", complete);
    const workflow = new Workflow({
      name: "late",
      register: false,
      eventBus: bus,
      initialState: { n: 0 },
      steps: [
        {
          name: "abort",
          run: async () => {
            controller.abort(new Error("cancelled"));
            return { n: 1 };
          },
        },
      ],
    });
    await expect(workflow.run({ signal: controller.signal })).rejects.toThrow("cancelled");
    expect(complete).not.toHaveBeenCalled();
  });

  it("aborts retry backoff before a second attempt", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const run = vi.fn().mockRejectedValue(new Error("retry me"));
      const workflow = new Workflow({
        name: "retry-abort",
        register: false,
        initialState: {},
        retryPolicy: { maxRetries: 2, backoffMs: 10_000 },
        steps: [{ name: "retry", run }],
      });
      const result = workflow.run({ signal: controller.signal });
      const rejection = expect(result).rejects.toThrow("backoff aborted");
      await vi.advanceTimersByTimeAsync(1);
      controller.abort(new Error("backoff aborted"));
      await rejection;
      expect(run).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a controlled effect with an uncertain applied outcome", async () => {
    const ctx = new RunContext({ sessionId: "owned", eventBus: new EventBus() });
    const dispatchEffect = vi.fn().mockRejectedValue(new Error("acknowledgement lost"));
    const executionServices = { ctx, dispatchEffect } as unknown as ExecutionServices;
    const workflow = new Workflow({
      name: "controlled",
      register: false,
      initialState: {},
      retryPolicy: { maxRetries: 3, backoffMs: 1 },
      steps: [{ name: "effect", run: async () => ({}) }],
    });
    const result = await workflow.run({ executionServices });
    expect(result.status).toBe("failed");
    expect(dispatchEffect).toHaveBeenCalledOnce();
  });

  it.each([null, [], "bad"])("records invalid function patch %j as an error", async (patch) => {
    const workflow = new Workflow({
      name: "invalid",
      register: false,
      initialState: {},
      steps: [{ name: "bad", run: vi.fn().mockResolvedValue(patch) }],
    });
    const result = await workflow.run();
    expect(result.status).toBe("failed");
    expect(result.stepResults[0].error).toMatch(/patch.*object/i);
  });

  it("documents that direct nested mutation remains shared across shallow branch snapshots", async () => {
    const nested = { count: 0 };
    const workflow = new Workflow({
      name: "shallow-boundary",
      register: false,
      initialState: { nested },
      steps: [
        {
          name: "join",
          parallel: [
            {
              name: "mutation",
              run: async (state) => {
                state.nested.count = 1;
                return {};
              },
            },
          ],
        },
      ],
    });
    await workflow.run();
    expect(nested.count).toBe(1);
  });
  it("joins an Agent-owned output patch with an independent function patch", async () => {
    const workflow = new Workflow({
      name: "agent-patch",
      register: false,
      initialState: { a: 0, child_output: "old" },
      steps: [
        {
          name: "join",
          parallel: [
            { name: "child", agent: child(undefined, "done") },
            { name: "a", run: async () => ({ a: 2 }) },
          ],
        },
      ],
    });
    const result = await workflow.run();
    expect(result.state).toEqual({ a: 2, child_output: "done" });
    expect(result.status).toBe("completed");
  });

  it("keeps earlier checkpoint evidence and writes no checkpoint for a strict failed join", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const next = vi.fn().mockResolvedValue({});
    const workflow = new Workflow({
      name: "strict-checkpoint",
      register: false,
      initialState: { a: 0, b: 0 },
      checkpointStore: {
        save,
        load: async () => null,
        listForRun: async () => [],
        delete: async () => {},
      },
      steps: [
        { name: "before", run: async () => ({ a: 1 }) },
        {
          name: "join",
          merge: "error",
          parallel: [
            { name: "one", run: async () => ({ b: 1 }) },
            { name: "two", run: async () => ({ b: 2 }) },
          ],
        },
        { name: "next", run: next },
      ],
    });
    await expect(workflow.runWithCheckpoints()).rejects.toMatchObject({ code: "workflow_merge_conflict" });
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ stepIndex: 0, state: { a: 1, b: 0 } }));
    expect(next).not.toHaveBeenCalled();
  });

  it("prevents late Agent output from completing or overwriting checkpoint state", async () => {
    const controller = new AbortController();
    const agent = child("completed", "late");
    vi.mocked(agent.run).mockImplementation(async () => {
      controller.abort(new Error("late child aborted"));
      return {
        text: "late",
        status: "completed",
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    });
    const workflow = new Workflow({
      name: "agent-abort",
      register: false,
      initialState: { child_output: "old" },
      steps: [{ name: "child", agent }],
    });
    await expect(workflow.run({ signal: controller.signal })).rejects.toThrow("late child aborted");
  });

  it("inherits stop policy inside conditions and skips later groups", async () => {
    const next = vi.fn().mockResolvedValue({});
    const workflow = new Workflow({
      name: "condition-stop",
      register: false,
      failurePolicy: "stop",
      initialState: {},
      steps: [
        {
          name: "condition",
          condition: () => true,
          steps: [
            { name: "fail", agent: child("error") },
            { name: "inner-next", run: next },
          ],
        },
        { name: "unstarted-group", parallel: [{ name: "outer-next", run: next }] },
      ],
    });
    const result = await workflow.run();
    expect(result.status).toBe("failed");
    expect(result.stepResults.map((entry) => [entry.stepName, entry.status])).toEqual([
      ["condition", "error"],
      ["fail", "error"],
      ["inner-next", "skipped"],
      ["unstarted-group", "skipped"],
    ]);
    expect(next).not.toHaveBeenCalled();
  });
});
