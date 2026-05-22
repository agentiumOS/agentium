import { v4 as uuidv4 } from "uuid";
import { RunContext } from "../agent/run-context.js";
import { EventBus } from "../events/event-bus.js";
import { registry } from "../serve.js";
import type { WorkflowCheckpoint } from "./checkpoints.js";
import { StepRunner } from "./step-runner.js";
import type { StepResult, WorkflowConfig, WorkflowResult } from "./types.js";

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

  // ── Time travel ────────────────────────────────────────────────────────

  /**
   * Same as `run()` but additionally saves a `WorkflowCheckpoint` after every
   * top-level step. Requires `checkpointStore` in the config.
   */
  async runWithCheckpoints(opts?: {
    sessionId?: string;
    userId?: string;
  }): Promise<WorkflowResult<TState> & { runId: string }> {
    if (!this.config.checkpointStore) {
      throw new Error("Workflow.runWithCheckpoints requires checkpointStore to be configured");
    }
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
      const result = await this.executeStepwise(this.config.steps, { ...this.config.initialState }, ctx);
      this.eventBus.emit("run.complete", {
        runId: ctx.runId,
        output: {
          text: JSON.stringify(result.state),
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        },
      });
      return { ...result, runId: ctx.runId };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.eventBus.emit("run.error", { runId: ctx.runId, error: err });
      throw err;
    }
  }

  private async executeStepwise(
    steps: WorkflowConfig<TState>["steps"],
    initial: TState,
    ctx: RunContext,
  ): Promise<WorkflowResult<TState>> {
    let state = initial;
    const allResults: StepResult[] = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const { state: newState, results } = await this.stepRunner.executeSteps([step], state, ctx);
      state = newState;
      allResults.push(...results);
      if (this.config.checkpointStore) {
        const cp: WorkflowCheckpoint<TState> = {
          id: `${ctx.runId}:${String(i).padStart(6, "0")}`,
          runId: ctx.runId,
          workflowName: this.name,
          stepIndex: i,
          stepName: (step as any).name ?? `step-${i}`,
          state: { ...state },
          stepResults: [...allResults],
          timestamp: Date.now(),
        };
        await this.config.checkpointStore.save(cp);
      }
    }
    return { state, stepResults: allResults };
  }

  /** List all checkpoints for a given runId. */
  async listCheckpoints(runId: string): Promise<WorkflowCheckpoint<TState>[]> {
    if (!this.config.checkpointStore) throw new Error("checkpointStore not configured");
    return this.config.checkpointStore.listForRun(runId);
  }

  /**
   * Replay the workflow from the state captured at `checkpointId`. Continues
   * with the remaining steps. Returns the final result + new run id.
   */
  async replay(checkpointId: string): Promise<WorkflowResult<TState> & { runId: string }> {
    if (!this.config.checkpointStore) throw new Error("checkpointStore not configured");
    const cp = await this.config.checkpointStore.load(checkpointId);
    if (!cp) throw new Error(`Checkpoint not found: ${checkpointId}`);
    return this.forkFromState(cp.state, cp.stepIndex + 1);
  }

  /**
   * Fork a workflow run from a checkpoint with optional state mutations. The
   * fork gets a fresh runId. Use this for branching ("what if step 3 said X?").
   */
  async fork(
    checkpointId: string,
    mutations?: (state: TState) => TState | Partial<TState>,
  ): Promise<WorkflowResult<TState> & { runId: string }> {
    if (!this.config.checkpointStore) throw new Error("checkpointStore not configured");
    const cp = await this.config.checkpointStore.load(checkpointId);
    if (!cp) throw new Error(`Checkpoint not found: ${checkpointId}`);
    let state = { ...cp.state };
    if (mutations) {
      const patch = mutations(state);
      state = { ...state, ...(patch as Partial<TState>) };
    }
    return this.forkFromState(state, cp.stepIndex + 1);
  }

  private async forkFromState(
    state: TState,
    fromStepIndex: number,
  ): Promise<WorkflowResult<TState> & { runId: string }> {
    const ctx = new RunContext({
      sessionId: uuidv4(),
      eventBus: this.eventBus,
      sessionState: {},
    });
    const remaining = this.config.steps.slice(fromStepIndex);
    const result = await this.executeStepwise(remaining, state, ctx);
    return { ...result, runId: ctx.runId };
  }
}
