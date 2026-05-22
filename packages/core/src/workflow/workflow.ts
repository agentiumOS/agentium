import { v4 as uuidv4 } from "uuid";
import { RunContext } from "../agent/run-context.js";
import { EventBus } from "../events/event-bus.js";
import { registry } from "../serve.js";
import { StepRunner } from "./step-runner.js";
import type { WorkflowConfig, WorkflowResult } from "./types.js";

export class Workflow<TState extends Record<string, unknown> = Record<string, unknown>> {
  readonly kind = "workflow" as const;
  readonly name: string;
  readonly eventBus: EventBus;

  private config: WorkflowConfig<TState>;
  private stepRunner: StepRunner<TState>;

  constructor(config: WorkflowConfig<TState>) {
    this.config = config;
    this.name = config.name;
    this.eventBus = config.eventBus ?? new EventBus();
    this.stepRunner = new StepRunner<TState>(config.retryPolicy);

    if (config.register !== false) {
      registry.add(this);
    }
  }

  async run(opts?: { sessionId?: string; userId?: string }): Promise<WorkflowResult<TState>> {
    const ctx = new RunContext({
      sessionId: opts?.sessionId ?? uuidv4(),
      userId: opts?.userId,
      eventBus: this.eventBus,
      sessionState: {},
    });

    this.eventBus.emit("run.start", {
      runId: ctx.runId,
      agentName: `workflow:${this.name}`,
      input: JSON.stringify(this.config.initialState),
    });

    try {
      const { state, results } = await this.stepRunner.executeSteps(
        this.config.steps,
        { ...this.config.initialState },
        ctx,
      );

      const workflowResult: WorkflowResult<TState> = {
        state,
        stepResults: results,
      };

      this.eventBus.emit("run.complete", {
        runId: ctx.runId,
        output: {
          text: JSON.stringify(state),
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        },
      });

      return workflowResult;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.eventBus.emit("run.error", { runId: ctx.runId, error: err });
      throw err;
    }
  }
}
