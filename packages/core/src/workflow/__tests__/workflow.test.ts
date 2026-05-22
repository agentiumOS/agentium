import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../../agent/agent.js";
import type { RunOutput } from "../../agent/types.js";
import { EventBus } from "../../events/event-bus.js";
import type { AgentStep, ConditionStep, FunctionStep, ParallelStep, StepDef } from "../types.js";
import { Workflow } from "../workflow.js";

type TestState = Record<string, unknown> & {
  value?: string;
  count?: number;
};

function mockAgent(name: string, response: string): Agent {
  return {
    name,
    eventBus: new EventBus(),
    run: vi.fn().mockResolvedValue({
      text: response,
      toolCalls: [],
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
    } satisfies RunOutput),
    stream: vi.fn(),
  } as unknown as Agent;
}

describe("Workflow", () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
    vi.restoreAllMocks();
  });

  describe("creation", () => {
    it("sets name and creates eventBus", () => {
      const wf = new Workflow({
        name: "test-wf",
        initialState: {},
        steps: [],
        eventBus,
      });

      expect(wf.name).toBe("test-wf");
      expect(wf.eventBus).toBe(eventBus);
    });

    it("creates its own EventBus when none provided", () => {
      const wf = new Workflow({ name: "auto-bus", initialState: {}, steps: [] });
      expect(wf.eventBus).toBeInstanceOf(EventBus);
    });
  });

  describe("linear execution", () => {
    it("executes function steps in sequence", async () => {
      const order: string[] = [];

      const steps: StepDef<TestState>[] = [
        {
          name: "step1",
          run: async (_state) => {
            order.push("step1");
            return { value: "from-step1" };
          },
        } satisfies FunctionStep<TestState>,
        {
          name: "step2",
          run: async (_state) => {
            order.push("step2");
            return { count: 42 };
          },
        } satisfies FunctionStep<TestState>,
      ];

      const wf = new Workflow<TestState>({
        name: "linear-wf",
        initialState: { value: "init" },
        steps,
        eventBus,
      });

      const result = await wf.run();

      expect(order).toEqual(["step1", "step2"]);
      expect(result.state.value).toBe("from-step1");
      expect(result.state.count).toBe(42);
      expect(result.stepResults).toHaveLength(2);
      expect(result.stepResults[0].stepName).toBe("step1");
      expect(result.stepResults[0].status).toBe("done");
      expect(result.stepResults[1].stepName).toBe("step2");
    });

    it("passes state between steps", async () => {
      const capturedState: TestState[] = [];

      const steps: StepDef<TestState>[] = [
        {
          name: "set",
          run: async (state) => {
            capturedState.push({ ...state });
            return { value: "modified" };
          },
        } satisfies FunctionStep<TestState>,
        {
          name: "check",
          run: async (state) => {
            capturedState.push({ ...state });
            return {};
          },
        } satisfies FunctionStep<TestState>,
      ];

      const wf = new Workflow<TestState>({
        name: "state-pass",
        initialState: { value: "original" },
        steps,
        eventBus,
      });

      await wf.run();

      expect(capturedState[0].value).toBe("original");
      expect(capturedState[1].value).toBe("modified");
    });
  });

  describe("agent steps", () => {
    it("executes an agent step and stores output in state", async () => {
      const agent = mockAgent("summarizer", "summary text");

      const steps: StepDef<TestState>[] = [
        {
          name: "summarize",
          agent,
        } satisfies AgentStep<TestState>,
      ];

      const wf = new Workflow<TestState>({
        name: "agent-wf",
        initialState: { value: "data" },
        steps,
        eventBus,
      });

      const result = await wf.run();

      expect(agent.run).toHaveBeenCalled();
      expect(result.state.summarize_output).toBe("summary text");
      expect(result.stepResults[0].status).toBe("done");
    });

    it("uses inputFrom to derive agent input from state", async () => {
      const agent = mockAgent("processor", "processed");

      const steps: StepDef<TestState>[] = [
        {
          name: "process",
          agent,
          inputFrom: (state) => `process: ${state.value}`,
        } satisfies AgentStep<TestState>,
      ];

      const wf = new Workflow<TestState>({
        name: "inputfrom-wf",
        initialState: { value: "raw data" },
        steps,
        eventBus,
      });

      await wf.run();

      expect(agent.run).toHaveBeenCalledWith("process: raw data", expect.any(Object));
    });
  });

  describe("conditional steps", () => {
    it("executes inner steps when condition is true", async () => {
      const innerRun = vi.fn().mockResolvedValue({ value: "branched" });

      const steps: StepDef<TestState>[] = [
        {
          name: "if-check",
          condition: (state) => state.value === "go",
          steps: [{ name: "inner", run: innerRun } satisfies FunctionStep<TestState>],
        } satisfies ConditionStep<TestState>,
      ];

      const wf = new Workflow<TestState>({
        name: "cond-true",
        initialState: { value: "go" },
        steps,
        eventBus,
      });

      const result = await wf.run();

      expect(innerRun).toHaveBeenCalled();
      expect(result.stepResults.find((r) => r.stepName === "if-check")?.status).toBe("done");
      expect(result.stepResults.find((r) => r.stepName === "inner")?.status).toBe("done");
    });

    it("skips inner steps when condition is false", async () => {
      const innerRun = vi.fn().mockResolvedValue({});

      const steps: StepDef<TestState>[] = [
        {
          name: "if-check",
          condition: (state) => state.value === "go",
          steps: [{ name: "inner", run: innerRun } satisfies FunctionStep<TestState>],
        } satisfies ConditionStep<TestState>,
      ];

      const wf = new Workflow<TestState>({
        name: "cond-false",
        initialState: { value: "stop" },
        steps,
        eventBus,
      });

      const result = await wf.run();

      expect(innerRun).not.toHaveBeenCalled();
      expect(result.stepResults[0].stepName).toBe("if-check");
      expect(result.stepResults[0].status).toBe("skipped");
    });
  });

  describe("parallel steps", () => {
    it("executes parallel sub-steps concurrently and merges state", async () => {
      const steps: StepDef<TestState>[] = [
        {
          name: "parallel-group",
          parallel: [
            {
              name: "fast",
              run: async () => ({ value: "fast-done" }),
            } satisfies FunctionStep<TestState>,
            {
              name: "slow",
              run: async () => ({ count: 99 }),
            } satisfies FunctionStep<TestState>,
          ],
        } satisfies ParallelStep<TestState>,
      ];

      const wf = new Workflow<TestState>({
        name: "parallel-wf",
        initialState: {},
        steps,
        eventBus,
      });

      const result = await wf.run();

      expect(result.stepResults.find((r) => r.stepName === "parallel-group")?.status).toBe("done");
      expect(result.stepResults.find((r) => r.stepName === "fast")?.status).toBe("done");
      expect(result.stepResults.find((r) => r.stepName === "slow")?.status).toBe("done");
    });

    it("handles error in one parallel sub-step without blocking others", async () => {
      const steps: StepDef<TestState>[] = [
        {
          name: "mixed-parallel",
          parallel: [
            {
              name: "success-step",
              run: async () => ({ value: "ok" }),
            } satisfies FunctionStep<TestState>,
            {
              name: "fail-step",
              run: async () => {
                throw new Error("parallel failure");
              },
            } satisfies FunctionStep<TestState>,
          ],
        } satisfies ParallelStep<TestState>,
      ];

      const wf = new Workflow<TestState>({
        name: "parallel-error-wf",
        initialState: {},
        steps,
        eventBus,
      });

      const result = await wf.run();

      const groupResult = result.stepResults.find((r) => r.stepName === "mixed-parallel");
      expect(groupResult?.status).toBe("done");
    });
  });

  describe("error handling", () => {
    it("returns error status when a function step throws (with no retry)", async () => {
      const steps: StepDef<TestState>[] = [
        {
          name: "failing-step",
          run: async () => {
            throw new Error("step failed");
          },
        } satisfies FunctionStep<TestState>,
      ];

      const wf = new Workflow<TestState>({
        name: "error-wf",
        initialState: {},
        steps,
        eventBus,
      });

      const result = await wf.run();

      expect(result.stepResults[0].status).toBe("error");
      expect(result.stepResults[0].error).toBe("step failed");
    });

    it("retries a failing step according to retryPolicy", async () => {
      let attempts = 0;

      const steps: StepDef<TestState>[] = [
        {
          name: "flaky-step",
          run: async () => {
            attempts++;
            if (attempts < 3) throw new Error("flaky");
            return { value: "recovered" };
          },
        } satisfies FunctionStep<TestState>,
      ];

      const wf = new Workflow<TestState>({
        name: "retry-wf",
        initialState: {},
        steps,
        retryPolicy: { maxRetries: 3, backoffMs: 1 },
        eventBus,
      });

      const result = await wf.run();

      expect(attempts).toBe(3);
      expect(result.stepResults[0].status).toBe("done");
    });
  });

  describe("events", () => {
    it("emits run.start and run.complete", async () => {
      const startHandler = vi.fn();
      const completeHandler = vi.fn();

      eventBus.on("run.start", startHandler);
      eventBus.on("run.complete", completeHandler);

      const wf = new Workflow({
        name: "events-wf",
        initialState: { x: 1 },
        steps: [],
        eventBus,
      });

      await wf.run();

      expect(startHandler).toHaveBeenCalledWith(expect.objectContaining({ agentName: "workflow:events-wf" }));
      expect(completeHandler).toHaveBeenCalledTimes(1);
    });

    it("emits run.error when workflow throws", async () => {
      const errorHandler = vi.fn();
      eventBus.on("run.error", errorHandler);

      const steps: StepDef<TestState>[] = [
        {
          name: "throw-step",
          run: async () => {
            throw new Error("workflow boom");
          },
        } satisfies FunctionStep<TestState>,
      ];

      const wf = new Workflow<TestState>({
        name: "error-events-wf",
        initialState: {},
        steps,
        eventBus,
      });

      const result = await wf.run();
      expect(result.stepResults[0].status).toBe("error");
    });

    it("emits workflow.step events for each step", async () => {
      const stepHandler = vi.fn();
      eventBus.on("workflow.step" as any, stepHandler);

      const steps: StepDef<TestState>[] = [
        {
          name: "tracked-step",
          run: async () => ({ value: "done" }),
        } satisfies FunctionStep<TestState>,
      ];

      const wf = new Workflow<TestState>({
        name: "step-events",
        initialState: {},
        steps,
        eventBus,
      });

      await wf.run();

      expect(stepHandler).toHaveBeenCalledWith(expect.objectContaining({ stepName: "tracked-step", status: "start" }));
      expect(stepHandler).toHaveBeenCalledWith(expect.objectContaining({ stepName: "tracked-step", status: "done" }));
    });
  });

  describe("workflow result structure", () => {
    it("returns state and stepResults", async () => {
      const wf = new Workflow<TestState>({
        name: "result-wf",
        initialState: { value: "start" },
        steps: [
          {
            name: "only-step",
            run: async () => ({ count: 1 }),
          } satisfies FunctionStep<TestState>,
        ],
        eventBus,
      });

      const result = await wf.run();

      expect(result).toHaveProperty("state");
      expect(result).toHaveProperty("stepResults");
      expect(result.state.value).toBe("start");
      expect(result.state.count).toBe(1);
      expect(result.stepResults).toHaveLength(1);
      expect(result.stepResults[0]).toHaveProperty("durationMs");
      expect(result.stepResults[0].durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("empty workflow", () => {
    it("runs with zero steps and returns initial state", async () => {
      const wf = new Workflow<TestState>({
        name: "empty-wf",
        initialState: { value: "unchanged" },
        steps: [],
        eventBus,
      });

      const result = await wf.run();

      expect(result.state.value).toBe("unchanged");
      expect(result.stepResults).toHaveLength(0);
    });
  });
});
