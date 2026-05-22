import type { RunContext } from "../agent/run-context.js";
import type { AgentStep, ConditionStep, FunctionStep, ParallelStep, StepDef, StepResult } from "./types.js";

function isAgentStep<T>(step: StepDef<T>): step is AgentStep<T> {
  return "agent" in step;
}

function isFunctionStep<T>(step: StepDef<T>): step is FunctionStep<T> {
  return "run" in step;
}

function isConditionStep<T>(step: StepDef<T>): step is ConditionStep<T> {
  return "condition" in step;
}

function isParallelStep<T>(step: StepDef<T>): step is ParallelStep<T> {
  return "parallel" in step;
}

export class StepRunner<TState extends Record<string, unknown>> {
  private retryPolicy?: { maxRetries: number; backoffMs: number };

  constructor(retryPolicy?: { maxRetries: number; backoffMs: number }) {
    this.retryPolicy = retryPolicy;
  }

  async executeSteps(
    steps: StepDef<TState>[],
    state: TState,
    ctx: RunContext,
  ): Promise<{ state: TState; results: StepResult[] }> {
    let currentState = { ...state };
    const allResults: StepResult[] = [];

    for (const step of steps) {
      const { state: newState, results } = await this.executeStep(step, currentState, ctx);
      currentState = newState;
      allResults.push(...results);
    }

    return { state: currentState, results: allResults };
  }

  private async executeStep(
    step: StepDef<TState>,
    state: TState,
    ctx: RunContext,
  ): Promise<{ state: TState; results: StepResult[] }> {
    if (isConditionStep(step)) {
      return this.executeConditionStep(step, state, ctx);
    }

    if (isParallelStep(step)) {
      return this.executeParallelStep(step, state, ctx);
    }

    if (isAgentStep(step)) {
      return this.executeAgentStep(step, state, ctx);
    }

    if (isFunctionStep(step)) {
      return this.executeFunctionStep(step, state, ctx);
    }

    return { state, results: [] };
  }

  private async executeAgentStep(
    step: AgentStep<TState>,
    state: TState,
    ctx: RunContext,
  ): Promise<{ state: TState; results: StepResult[] }> {
    const startTime = Date.now();

    ctx.eventBus.emit("workflow.step", {
      runId: ctx.runId,
      stepName: step.name,
      status: "start",
    });

    const execute = async (): Promise<StepResult> => {
      const input = step.inputFrom ? step.inputFrom(state) : JSON.stringify(state);

      const output = await step.agent.run(input, {
        sessionId: ctx.sessionId,
      });

      const newState = {
        ...state,
        [`${step.name}_output`]: output.text,
      } as TState;

      for (const key of Object.keys(newState)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
        (state as any)[key] = (newState as any)[key];
      }

      return {
        stepName: step.name,
        status: "done",
        durationMs: Date.now() - startTime,
      };
    };

    const result = await this.withRetry(step.name, execute, ctx);
    return { state, results: [result] };
  }

  private async executeFunctionStep(
    step: FunctionStep<TState>,
    state: TState,
    ctx: RunContext,
  ): Promise<{ state: TState; results: StepResult[] }> {
    const startTime = Date.now();

    ctx.eventBus.emit("workflow.step", {
      runId: ctx.runId,
      stepName: step.name,
      status: "start",
    });

    const execute = async (): Promise<StepResult> => {
      const patch = await step.run(state, ctx);
      for (const key of Object.keys(patch as any)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
        (state as any)[key] = (patch as any)[key];
      }

      return {
        stepName: step.name,
        status: "done",
        durationMs: Date.now() - startTime,
      };
    };

    const result = await this.withRetry(step.name, execute, ctx);
    return { state, results: [result] };
  }

  private async executeConditionStep(
    step: ConditionStep<TState>,
    state: TState,
    ctx: RunContext,
  ): Promise<{ state: TState; results: StepResult[] }> {
    const startTime = Date.now();

    ctx.eventBus.emit("workflow.step", {
      runId: ctx.runId,
      stepName: step.name,
      status: "start",
    });

    if (step.condition(state)) {
      const { state: newState, results } = await this.executeSteps(step.steps, state, ctx);

      ctx.eventBus.emit("workflow.step", {
        runId: ctx.runId,
        stepName: step.name,
        status: "done",
      });

      return {
        state: newState,
        results: [
          {
            stepName: step.name,
            status: "done",
            durationMs: Date.now() - startTime,
          },
          ...results,
        ],
      };
    }

    ctx.eventBus.emit("workflow.step", {
      runId: ctx.runId,
      stepName: step.name,
      status: "done",
    });

    return {
      state,
      results: [
        {
          stepName: step.name,
          status: "skipped",
          durationMs: Date.now() - startTime,
        },
      ],
    };
  }

  private async executeParallelStep(
    step: ParallelStep<TState>,
    state: TState,
    ctx: RunContext,
  ): Promise<{ state: TState; results: StepResult[] }> {
    const startTime = Date.now();

    ctx.eventBus.emit("workflow.step", {
      runId: ctx.runId,
      stepName: step.name,
      status: "start",
    });

    const settled = await Promise.allSettled(step.parallel.map((s) => this.executeStep(s, { ...state }, ctx)));

    const allResults: StepResult[] = [];
    const mergedState = { ...state };

    for (const result of settled) {
      if (result.status === "fulfilled") {
        Object.assign(mergedState, result.value.state);
        allResults.push(...result.value.results);
      } else {
        allResults.push({
          stepName: step.name,
          status: "error",
          error: result.reason?.message ?? "Unknown error",
          durationMs: Date.now() - startTime,
        });
      }
    }

    ctx.eventBus.emit("workflow.step", {
      runId: ctx.runId,
      stepName: step.name,
      status: "done",
    });

    return {
      state: mergedState,
      results: [
        {
          stepName: step.name,
          status: "done",
          durationMs: Date.now() - startTime,
        },
        ...allResults,
      ],
    };
  }

  private async withRetry(stepName: string, fn: () => Promise<StepResult>, ctx: RunContext): Promise<StepResult> {
    const maxRetries = this.retryPolicy?.maxRetries ?? 0;
    const backoffMs = this.retryPolicy?.backoffMs ?? 1000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await fn();

        ctx.eventBus.emit("workflow.step", {
          runId: ctx.runId,
          stepName,
          status: "done",
        });

        return result;
      } catch (error) {
        if (attempt === maxRetries) {
          const err = error instanceof Error ? error : new Error(String(error));

          ctx.eventBus.emit("workflow.step", {
            runId: ctx.runId,
            stepName,
            status: "error",
          });

          return {
            stepName,
            status: "error",
            error: err.message,
            durationMs: 0,
          };
        }

        await new Promise((resolve) => setTimeout(resolve, backoffMs * 2 ** attempt));
      }
    }

    return { stepName, status: "error", error: "Exhausted retries", durationMs: 0 };
  }
}
