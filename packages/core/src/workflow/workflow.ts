import { randomUUID as uuidv4 } from "node:crypto";
import { RunContext } from "../agent/run-context.js";
import type { RunOpts } from "../agent/types.js";
import { getRunCostSnapshot } from "../cost/accounting.js";
import { getAccountingContext, withAccountingContext } from "../cost/context.js";
import { CostTracker } from "../cost/cost-tracker.js";
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
  private readonly ownsCostTracker: boolean;
  private stepRunner: StepRunner<TState>;

  constructor(config: WorkflowConfig<TState>) {
    if (config.cost !== undefined && config.costTracker) throw new TypeError("Choose cost or costTracker, not both");
    this.ownsCostTracker = !config.costTracker && Boolean(config.cost);
    this.config = {
      ...config,
      costTracker:
        config.costTracker ??
        (config.cost ? new CostTracker(config.cost === true ? undefined : config.cost) : undefined),
    };
    this.name = config.name;
    this.eventBus = config.eventBus ?? new EventBus();
    this.stepRunner = new StepRunner<TState>(config.retryPolicy);

    if (config.register !== false) {
      registry.add(this);
    }
  }

  private async runInAccountingScope<T>(ctx: RunContext, operation: () => Promise<T>): Promise<T> {
    const parent = getAccountingContext();
    const tracker = parent?.tracker ?? this.config.costTracker;
    if (!tracker) return operation();
    const pendingId = `workflow-run:${ctx.runId}:${uuidv4()}`;
    tracker.beginPendingAttempt(pendingId);
    try {
      return await withAccountingContext(
        {
          ...parent,
          tracker,
          runId: ctx.runId,
          rootRunId: parent?.rootRunId ?? parent?.runId ?? ctx.runId,
          parentRunId: parent?.runId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          sessionId: ctx.sessionId,
          agentName: `workflow:${this.name}`,
          eventBus: this.eventBus,
          purpose: "workflow-step",
        },
        operation,
      );
    } finally {
      tracker.endPendingAttempt(pendingId);
    }
  }

  private async withCosts(result: WorkflowResult<TState>, ctx: RunContext): Promise<WorkflowResult<TState>> {
    const parent = getAccountingContext();
    const tracker = parent?.tracker ?? this.config.costTracker;
    if (!tracker) return result;
    return {
      ...result,
      costs: await getRunCostSnapshot({
        ...parent,
        tracker,
        runId: ctx.runId,
        tenantId: ctx.tenantId ?? parent?.tenantId,
        eventBus: this.eventBus,
      }),
    };
  }
  async close(): Promise<void> {
    if (this.ownsCostTracker) await this.config.costTracker?.close();
  }

  async run(opts?: RunOpts & { initialState?: Partial<TState> }): Promise<WorkflowResult<TState>> {
    const ctx = new RunContext({
      sessionId: opts?.sessionId ?? uuidv4(),
      userId: opts?.userId,
      tenantId: opts?.tenantId,
      signal: opts?.signal,
      runMode: opts?.runMode,
      executionPolicy: opts?.executionServices?.executionPolicy,
      executionServices: opts?.executionServices,
      runId: opts?.runId,
      metadata: opts?.metadata,
      eventBus: this.eventBus,
      sessionState: {},
    });

    this.eventBus.emit("run.start", {
      runId: ctx.runId,
      agentName: `workflow:${this.name}`,
      input: JSON.stringify(this.config.initialState),
    });

    try {
      const { state, results } = await this.runInAccountingScope(ctx, () =>
        this.stepRunner.executeSteps(this.config.steps, { ...this.config.initialState, ...opts?.initialState }, ctx),
      );

      const workflowResult = await this.withCosts({ state, stepResults: results }, ctx);

      this.eventBus.emit("run.complete", {
        runId: ctx.runId,
        output: {
          text: JSON.stringify(state),
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          costs: workflowResult.costs,
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
          costs: result.costs,
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
      const { state: newState, results } = await this.runInAccountingScope(ctx, () =>
        this.stepRunner.executeSteps([step], state, ctx),
      );
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
    return this.withCosts({ state, stepResults: allResults }, ctx);
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
