import { randomUUID as uuidv4 } from "node:crypto";
import { z } from "zod";
import { RunContext } from "../agent/run-context.js";
import type { RunOpts } from "../agent/types.js";
import { getRunCostSnapshot } from "../cost/accounting.js";
import { getAccountingContext, withAccountingContext } from "../cost/context.js";
import { CostTracker } from "../cost/cost-tracker.js";
import { EventBus } from "../events/event-bus.js";
import { registry } from "../serve.js";
import type { WorkflowCheckpoint } from "./checkpoints.js";
import { WorkflowCheckpointError } from "./errors.js";
import { StepRunner } from "./step-runner.js";
import type { StepResult, WorkflowConfig, WorkflowContinuationOptions, WorkflowResult } from "./types.js";

const checkpointEnvelope = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  workflowName: z.string().min(1),
  stepIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  stepName: z.string(),
  state: z.record(z.string(), z.unknown()),
  stepResults: z.array(
    z.object({
      stepName: z.string(),
      status: z.enum(["done", "error", "skipped"]),
      error: z.string().optional(),
      durationMs: z.number().finite().nonnegative(),
      output: z
        .object({
          text: z.string(),
          status: z.enum(["completed", "error", "stopped", "cancelled"]).optional(),
          reason: z.object({ code: z.string(), message: z.string() }).optional(),
        })
        .transform((output) => ({ ...output, status: output.status }))
        .optional(),
    }),
  ),
  timestamp: z.number().finite().nonnegative(),
  formatVersion: z.literal(2).optional(),
  definitionVersion: z.string().min(1).optional(),
  stepNames: z.array(z.string()).optional(),
  parentCheckpointId: z.string().optional(),
  parentRunId: z.string().optional(),
});

/** Legacy wrappers preserve callable/client state compatibility. Clone ordinary
 * containers recursively while retaining noncloneable opaque dependencies. */
function cloneLegacyValue(value: unknown, seen: Map<object, object>): unknown {
  if (value === null || typeof value !== "object") return value;
  const previous = seen.get(value);
  if (previous) return previous;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
    try {
      return structuredClone(value);
    } catch {
      return value;
    }
  }
  const copy = Object.assign(Array.isArray(value) ? [] : {}, value);
  Object.setPrototypeOf(copy, prototype);
  seen.set(value, copy);
  for (const key of Object.keys(value)) Reflect.set(copy, key, cloneLegacyValue(Reflect.get(value, key), seen));
  return copy;
}

function legacyClone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  try {
    return structuredClone(value);
  } catch {
    /* Keep opaque legacy dependencies compatible. */
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) return value;
  const copy = Object.assign(Array.isArray(value) ? [] : {}, value);
  Object.setPrototypeOf(copy, prototype);
  const seen = new Map<object, object>([[value, copy]]);
  for (const key of Object.keys(value)) Reflect.set(copy, key, cloneLegacyValue(Reflect.get(value, key), seen));
  return copy;
}

export class Workflow<TState extends Record<string, unknown> = Record<string, unknown>> {
  readonly kind = "workflow" as const;
  readonly name: string;
  readonly eventBus: EventBus;

  private config: WorkflowConfig<TState>;
  private readonly ownsCostTracker: boolean;
  private stepRunner: StepRunner<TState>;

  constructor(config: WorkflowConfig<TState>) {
    if (config.cost !== undefined && config.costTracker) throw new TypeError("Choose cost or costTracker, not both");
    if ((config.definitionVersion !== undefined) !== (config.validateCheckpointState !== undefined)) {
      throw new TypeError("Workflow definitionVersion and validateCheckpointState must be supplied together");
    }
    if (config.definitionVersion !== undefined && config.definitionVersion.length === 0) {
      throw new TypeError("Workflow definitionVersion must be nonempty");
    }
    this.ownsCostTracker = !config.costTracker && Boolean(config.cost);
    this.config = {
      ...config,
      costTracker:
        config.costTracker ??
        (config.cost ? new CostTracker(config.cost === true ? undefined : config.cost) : undefined),
    };
    this.name = config.name;
    this.eventBus = config.eventBus ?? new EventBus();
    this.stepRunner = new StepRunner<TState>(config.retryPolicy, config.failurePolicy);

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

  private createContext(opts?: RunOpts): RunContext {
    return new RunContext({
      sessionId: opts?.sessionId ?? uuidv4(),
      userId: opts?.userId,
      tenantId: opts?.tenantId,
      signal: opts?.signal,
      runMode: opts?.runMode,
      executionPolicy: opts?.executionPolicy ?? opts?.executionServices?.executionPolicy,
      executionServices: opts?.executionServices,
      runId: opts?.runId,
      metadata: opts?.metadata,
      eventBus: this.eventBus,
      sessionState: {},
      questions: opts?.questions,
    });
  }

  private aggregate(state: TState, stepResults: StepResult[]): WorkflowResult<TState> {
    const failed = stepResults.some((result) => result.status === "error");
    return {
      state,
      stepResults,
      status: failed ? "failed" : "completed",
      ...(failed
        ? { reason: { code: "workflow_step_failed" as const, message: "One or more Workflow steps failed" } }
        : {}),
    };
  }

  private async lifecycle(
    ctx: RunContext,
    initial: TState,
    execute: () => Promise<WorkflowResult<TState>>,
  ): Promise<WorkflowResult<TState>> {
    this.eventBus.emit("run.start", {
      runId: ctx.runId,
      agentName: `workflow:${this.name}`,
      input: JSON.stringify(initial),
    });
    try {
      ctx.signal?.throwIfAborted();
      const result = await execute();
      ctx.signal?.throwIfAborted();
      const withCosts = await this.withCosts(result, ctx);
      ctx.signal?.throwIfAborted();
      this.eventBus.emit("run.complete", {
        runId: ctx.runId,
        output: {
          text: JSON.stringify(result.state),
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          costs: withCosts.costs,
          status: result.status === "failed" ? "error" : "completed",
          reason: result.reason,
        },
      });
      return withCosts;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.eventBus.emit("run.error", { runId: ctx.runId, error: err });
      throw err;
    }
  }

  async run(opts?: RunOpts & { initialState?: Partial<TState> }): Promise<WorkflowResult<TState>> {
    const ctx = this.createContext(opts);
    const initial = { ...this.config.initialState, ...opts?.initialState };
    return this.lifecycle(ctx, initial, async () => {
      const { state, results } = await this.runInAccountingScope(ctx, () =>
        this.stepRunner.executeSteps(this.config.steps, initial, ctx, opts),
      );
      return this.aggregate(state, results);
    });
  }

  /** Save state after each top-level step. All RunOpts apply to this fresh run. */
  async runWithCheckpoints(
    opts?: RunOpts & { initialState?: Partial<TState> },
  ): Promise<WorkflowResult<TState> & { runId: string }> {
    if (!this.config.checkpointStore)
      throw new Error("Workflow.runWithCheckpoints requires checkpointStore to be configured");
    const ctx = this.createContext(opts);
    const initial = { ...this.config.initialState, ...opts?.initialState };
    const result = await this.lifecycle(ctx, initial, () => this.executeStepwise(initial, ctx, 0, [], undefined, opts));
    return { ...result, runId: ctx.runId };
  }

  private clone<T>(value: T, strict = this.config.definitionVersion !== undefined): T {
    if (!strict) return legacyClone(value);
    try {
      return structuredClone(value);
    } catch (cause) {
      throw new WorkflowCheckpointError("Checkpoint state and results must be structured-cloneable", { cause });
    }
  }

  private async executeStepwise(
    initial: TState,
    ctx: RunContext,
    fromStepIndex: number,
    priorResults: StepResult[],
    parent?: WorkflowCheckpoint<TState>,
    opts?: RunOpts,
  ): Promise<WorkflowResult<TState>> {
    let state = initial;
    const allResults = this.clone(priorResults);
    let stopped = this.config.failurePolicy === "stop" && allResults.some((result) => result.status === "error");
    for (let i = fromStepIndex; i < this.config.steps.length; i++) {
      ctx.signal?.throwIfAborted();
      const step = this.config.steps[i];
      if (stopped) {
        allResults.push({ stepName: step.name, status: "skipped", durationMs: 0 });
        continue;
      }
      const outcome = await this.runInAccountingScope(ctx, () =>
        this.stepRunner.executeSteps([step], state, ctx, opts),
      );
      ctx.signal?.throwIfAborted();
      state = outcome.state;
      allResults.push(...outcome.results);
      if (this.config.checkpointStore) {
        const cp: WorkflowCheckpoint<TState> = {
          id: `${ctx.runId}:${String(i).padStart(6, "0")}`,
          runId: ctx.runId,
          workflowName: this.name,
          stepIndex: i,
          stepName: step.name,
          state: this.clone(state),
          stepResults: this.clone(allResults),
          timestamp: Date.now(),
          ...(this.config.definitionVersion !== undefined
            ? {
                formatVersion: 2,
                definitionVersion: this.config.definitionVersion,
                stepNames: this.config.steps.map((item) => item.name),
              }
            : {}),
          ...(parent ? { parentCheckpointId: parent.id, parentRunId: parent.runId } : {}),
        };
        ctx.signal?.throwIfAborted();
        await this.config.checkpointStore.save(cp);
        ctx.signal?.throwIfAborted();
      }
      stopped = this.config.failurePolicy === "stop" && outcome.results.some((result) => result.status === "error");
    }
    return this.aggregate(state, allResults);
  }

  /** Inspect checkpoints without executing any effects. */
  async listCheckpoints(runId: string): Promise<WorkflowCheckpoint<TState>[]> {
    if (!this.config.checkpointStore) throw new Error("checkpointStore not configured");
    return this.config.checkpointStore.listForRun(runId);
  }

  private async loadCheckpoint(checkpointId: string, strict: boolean): Promise<WorkflowCheckpoint<TState>> {
    if (!this.config.checkpointStore) throw new Error("checkpointStore not configured");
    const cp = await this.config.checkpointStore.load(checkpointId);
    if (!cp) throw new Error(`Checkpoint not found: ${checkpointId}`);
    try {
      const parsed = checkpointEnvelope.parse(cp);
      if (
        parsed.id !== checkpointId ||
        parsed.workflowName !== this.name ||
        parsed.stepIndex >= this.config.steps.length
      ) {
        throw new Error("Checkpoint workflow or cursor does not match this definition");
      }
      if (strict || parsed.formatVersion === 2) {
        const validate = this.config.validateCheckpointState;
        if (
          parsed.formatVersion !== 2 ||
          this.config.steps[parsed.stepIndex].name !== parsed.stepName ||
          !validate ||
          this.config.definitionVersion === undefined ||
          parsed.definitionVersion !== this.config.definitionVersion ||
          !parsed.stepNames ||
          parsed.stepNames.length !== this.config.steps.length ||
          parsed.stepNames.some((name, index) => name !== this.config.steps[index].name)
        ) {
          throw new Error(
            "Checkpoint version and ordered definition must match; legacy records require explicit host migration",
          );
        }
        return {
          ...parsed,
          state: this.clone(validate(parsed.state), true),
          stepResults: this.clone(parsed.stepResults, true),
        };
      }
      // Legacy stores already expose TState; envelope validation cannot establish
      // closure/code identity. This compatibility path remains through this major.
      return { ...parsed, state: this.clone(cp.state, false), stepResults: this.clone(parsed.stepResults, false) };
    } catch (cause) {
      if (cause instanceof WorkflowCheckpointError) throw cause;
      throw new WorkflowCheckpointError("Checkpoint is incompatible with this Workflow", { cause });
    }
  }

  /** Continue a validated v2 checkpoint. Remaining effects execute afresh. */
  async continueFromCheckpoint(
    checkpointId: string,
    opts?: WorkflowContinuationOptions,
  ): Promise<WorkflowResult<TState> & { runId: string }> {
    const cp = await this.loadCheckpoint(checkpointId, true);
    return this.continueRun(cp, cp.state, opts);
  }

  /** @deprecated This performs fresh continuation, not recorded playback. Use
   * continueFromCheckpoint with a v2 checkpoint. Legacy acceptance cannot verify
   * original code identity and remains available through the current major. */
  async replay(
    checkpointId: string,
    opts?: WorkflowContinuationOptions,
  ): Promise<WorkflowResult<TState> & { runId: string }> {
    const cp = await this.loadCheckpoint(checkpointId, false);
    return this.continueRun(cp, cp.state, opts);
  }

  /** @deprecated Prefer validated continuation. Fork executes later effects again;
   * migrate legacy records offline after verifying original index/version/state. */
  async fork(
    checkpointId: string,
    mutations?: (state: TState) => TState | Partial<TState>,
    opts?: WorkflowContinuationOptions,
  ): Promise<WorkflowResult<TState> & { runId: string }> {
    const cp = await this.loadCheckpoint(checkpointId, false);
    let state = cp.state;
    if (mutations) state = { ...state, ...mutations(state) };
    if (cp.formatVersion === 2 && this.config.validateCheckpointState)
      state = this.clone(this.config.validateCheckpointState(state), true);
    return this.continueRun(cp, state, opts);
  }

  private async continueRun(
    cp: WorkflowCheckpoint<TState>,
    initial: TState,
    opts?: RunOpts,
  ): Promise<WorkflowResult<TState> & { runId: string }> {
    const ctx = this.createContext(opts);
    const result = await this.lifecycle(ctx, initial, () =>
      this.executeStepwise(initial, ctx, cp.stepIndex + 1, cp.stepResults, cp, opts),
    );
    return { ...result, runId: ctx.runId };
  }
}
