import { RootExecutionError } from "../agent/root-execution.js";
import { RunContext } from "../agent/run-context.js";
import type { RunOpts } from "../agent/types.js";
import { AwaitingDurableApproval, DurableConflictError, DurableRecoveryRequiredError } from "../durable/types.js";
import { abortable } from "../models/request-controls.js";
import { WorkflowCancellationError, WorkflowDefinitionError, WorkflowMergeConflict } from "./errors.js";
import { executeWorkflowGraph, validateWorkflowSteps } from "./graph-runner.js";
import type {
  AgentStep,
  ConditionStep,
  FunctionStep,
  GraphStep,
  ParallelStep,
  RepeatStep,
  StepDef,
  StepResult,
} from "./types.js";

interface StepExecution<TState> {
  state: TState;
  patch: Partial<TState>;
  results: StepResult[];
}

function fatal(error: unknown): boolean {
  return (
    error instanceof RootExecutionError ||
    error instanceof DurableConflictError ||
    error instanceof DurableRecoveryRequiredError ||
    error instanceof AwaitingDurableApproval ||
    error instanceof WorkflowMergeConflict ||
    error instanceof WorkflowCancellationError ||
    error instanceof WorkflowDefinitionError
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Branch snapshots are shallow. Return owned patches and replace nested objects
 * rather than mutating shared input references. */
export class StepRunner<TState extends Record<string, unknown>> {
  constructor(
    private readonly retryPolicy?: { maxRetries: number; backoffMs: number },
    private readonly failurePolicy: "continue" | "stop" = "continue",
  ) {}

  async executeSteps(
    steps: StepDef<TState>[],
    state: TState,
    ctx: RunContext,
    opts?: RunOpts,
  ): Promise<{ state: TState; results: StepResult[] }> {
    const outcome = await this.executeStepsWithPatch(steps, state, ctx, opts);
    return { state: outcome.state, results: outcome.results };
  }

  private async executeStepsWithPatch(
    steps: StepDef<TState>[],
    state: TState,
    ctx: RunContext,
    opts?: RunOpts,
    scope?: string,
    depth = 0,
    expansionScope = `workflow:${typeof ctx.metadata.rootRunId === "string" ? ctx.metadata.rootRunId : ctx.runId}`,
  ): Promise<StepExecution<TState>> {
    if (ctx.rootExecution) validateWorkflowSteps(steps);
    const offset =
      depth === 0 &&
      Number.isSafeInteger(ctx.metadata.workflowStepOffset) &&
      typeof ctx.metadata.workflowStepOffset === "number" &&
      ctx.metadata.workflowStepOffset >= 0
        ? ctx.metadata.workflowStepOffset
        : 0;
    const expansionIds = steps.map(
      (step, index) =>
        `${expansionScope}/steps/${index + offset}/${ctx.rootExecution ? encodeURIComponent(step.name) : step.name}`,
    );
    await ctx.rootExecution?.expand(expansionIds);
    let currentState = { ...state };
    const patch: Partial<TState> = {};
    const results: StepResult[] = [];
    let stopped = false;
    for (const [index, step] of steps.entries()) {
      ctx.signal?.throwIfAborted();
      if (stopped) {
        results.push({ stepName: step.name, status: "skipped", durationMs: 0 });
        continue;
      }
      const outcome = await this.executeStepWithPatch(step, currentState, ctx, opts, scope, depth, expansionIds[index]);
      currentState = outcome.state;
      Object.assign(patch, outcome.patch);
      results.push(...outcome.results);
      stopped = this.failurePolicy === "stop" && outcome.results.some((result) => result.status === "error");
    }
    ctx.signal?.throwIfAborted();
    return { state: currentState, patch, results };
  }

  private emit(ctx: RunContext, stepName: string, status: "start" | "done" | "error", executionPath?: string): void {
    ctx.eventBus.emit("workflow.step", {
      runId: ctx.runId,
      stepName,
      status,
      ...(executionPath ? { executionPath } : {}),
    });
  }

  private async executeStepWithPatch(
    step: StepDef<TState>,
    state: TState,
    ctx: RunContext,
    opts?: RunOpts,
    scope?: string,
    depth = 0,
    expansionId?: string,
  ): Promise<StepExecution<TState>> {
    ctx.signal?.throwIfAborted();
    if ("graph" in step || "repeat" in step) validateWorkflowSteps([step]);
    const path =
      scope !== undefined
        ? `${scope}/${encodeURIComponent(step.name)}`
        : "graph" in step || "repeat" in step
          ? encodeURIComponent(step.name)
          : undefined;
    if (path !== undefined && depth >= 64)
      throw new WorkflowDefinitionError("Workflow graph/repeat composition exceeds depth 64");
    const identity = expansionId ?? `workflow:${ctx.runId}/${path ?? step.name}`;
    await ctx.rootExecution?.expand([identity]);
    const start = Date.now();
    this.emit(ctx, step.name, "start", path);
    try {
      let outcome: StepExecution<TState>;
      if ("graph" in step)
        outcome = await this.executeGraphStep(step, state, ctx, opts, path ?? step.name, depth, identity);
      else if ("repeat" in step)
        outcome = await this.executeRepeatStep(step, state, ctx, opts, path ?? step.name, depth, identity);
      else if ("condition" in step)
        outcome = await this.executeConditionStep(step, state, ctx, opts, path, depth, identity);
      else if ("parallel" in step)
        outcome = await this.executeParallelStep(step, state, ctx, opts, path, depth, identity);
      else if ("agent" in step)
        outcome = await this.withRetry(() => this.executeAgentStep(step, state, ctx, opts, path), ctx);
      else outcome = await this.withRetry(() => this.executeFunctionStep(step, state, ctx, path), ctx);
      ctx.signal?.throwIfAborted();
      outcome.results[0].durationMs = Date.now() - start;
      if (path !== undefined) outcome.results[0].executionPath = path;
      this.emit(ctx, step.name, outcome.results[0].status === "error" ? "error" : "done", path);
      return outcome;
    } catch (error) {
      ctx.signal?.throwIfAborted();
      if (fatal(error)) throw error;
      this.emit(ctx, step.name, "error", path);
      return {
        state,
        patch: {},
        results: [
          {
            stepName: step.name,
            status: "error",
            error: errorMessage(error),
            durationMs: Date.now() - start,
            ...(path ? { executionPath: path } : {}),
          },
        ],
      };
    }
  }

  private ownedPatch(value: unknown): Partial<TState> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Workflow function patch must be a non-null, non-array object");
    }
    const patch: Partial<TState> = {};
    for (const key of Object.keys(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      Object.assign(patch, { [key]: Reflect.get(value, key) });
    }
    return patch;
  }

  private async executeAgentStep(
    step: AgentStep<TState>,
    state: TState,
    ctx: RunContext,
    opts?: RunOpts,
    executionPath?: string,
  ): Promise<StepExecution<TState>> {
    const input = step.inputFrom ? step.inputFrom(state) : JSON.stringify(state);
    const output = await step.agent.run(input, {
      sessionId: `${ctx.sessionId}:${executionPath ?? step.name}`,
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      signal: ctx.signal,
      runMode: ctx.runMode,
      executionServices: ctx.executionServices,
      rootExecution: ctx.rootExecution,
      executionPolicy: opts?.executionPolicy,
      apiKey: opts?.apiKey,
      dependencies: opts?.dependencies,
      questions: opts?.questions,
      metadata: {
        ...ctx.metadata,
        parentRunId: ctx.runId,
        ...(executionPath ? { workflowExecutionPath: executionPath } : {}),
      },
    });
    ctx.signal?.throwIfAborted();
    if (output.status === "cancelled") throw new WorkflowCancellationError(step.name, output.reason?.message);
    if (output.status === "error" || output.status === "stopped") {
      return {
        state,
        patch: {},
        results: [
          {
            stepName: step.name,
            status: "error",
            error: output.reason?.message ?? `Child Agent ${output.status}`,
            output: { text: output.text, status: output.status, reason: output.reason },
            durationMs: 0,
          },
        ],
      };
    }
    const patch = this.ownedPatch(Object.assign({}, { [`${step.name}_output`]: output.text }));
    return { state: { ...state, ...patch }, patch, results: [{ stepName: step.name, status: "done", durationMs: 0 }] };
  }

  private async executeFunctionStep(
    step: FunctionStep<TState>,
    state: TState,
    ctx: RunContext,
    executionPath?: string,
  ): Promise<StepExecution<TState>> {
    const scopedContext = executionPath
      ? new RunContext({ ...ctx, metadata: { ...ctx.metadata, workflowExecutionPath: executionPath } })
      : ctx;
    const value = ctx.executionServices
      ? await ctx.executionServices.dispatchEffect(`workflow:${executionPath ?? step.name}`, { state }, async (args) =>
          step.run(args.state as TState, scopedContext),
        )
      : ctx.rootExecution
        ? await ctx.rootExecution.run(
            "function",
            `workflow:${executionPath ?? step.name}`,
            () => step.run(state, scopedContext),
            ctx.signal,
          )
        : await step.run(state, scopedContext);
    ctx.signal?.throwIfAborted();
    const patch = this.ownedPatch(value);
    return { state: { ...state, ...patch }, patch, results: [{ stepName: step.name, status: "done", durationMs: 0 }] };
  }

  private async executeConditionStep(
    step: ConditionStep<TState>,
    state: TState,
    ctx: RunContext,
    opts?: RunOpts,
    scope?: string,
    depth = 0,
    expansionScope?: string,
  ): Promise<StepExecution<TState>> {
    if (!step.condition(state))
      return { state, patch: {}, results: [{ stepName: step.name, status: "skipped", durationMs: 0 }] };
    const outcome = await this.executeStepsWithPatch(step.steps, state, ctx, opts, scope, depth + 1, expansionScope);
    const failed = outcome.results.some((result) => result.status === "error");
    return {
      ...outcome,
      results: [{ stepName: step.name, status: failed ? "error" : "done", durationMs: 0 }, ...outcome.results],
    };
  }

  private async executeParallelStep(
    step: ParallelStep<TState>,
    state: TState,
    ctx: RunContext,
    opts?: RunOpts,
    scope?: string,
    depth = 0,
    expansionScope?: string,
  ): Promise<StepExecution<TState>> {
    const expansionIds = step.parallel.map(
      (branch, index) =>
        `${expansionScope}/parallel/${index}/${ctx.rootExecution ? encodeURIComponent(branch.name) : branch.name}`,
    );
    await ctx.rootExecution?.expand(expansionIds);
    const settled = await Promise.allSettled(
      step.parallel.map((branch, index) =>
        this.executeStepWithPatch(branch, { ...state }, ctx, opts, scope, depth + 1, expansionIds[index]),
      ),
    );
    ctx.signal?.throwIfAborted();
    for (const outcome of settled) {
      if (outcome.status === "rejected" && fatal(outcome.reason)) throw outcome.reason;
    }
    const patch: Partial<TState> = {};
    const results: StepResult[] = [];
    const written = new Set<string>();
    const conflicts = new Set<string>();
    for (const [index, outcome] of settled.entries()) {
      if (outcome.status === "rejected") {
        results.push({
          stepName: step.parallel[index].name,
          status: "error",
          error: errorMessage(outcome.reason),
          durationMs: 0,
        });
        continue;
      }
      for (const key of Object.keys(outcome.value.patch)) {
        if (written.has(key)) conflicts.add(key);
        written.add(key);
      }
      Object.assign(patch, outcome.value.patch);
      results.push(...outcome.value.results);
    }
    if (step.merge === "error" && conflicts.size > 0) throw new WorkflowMergeConflict(step.name, [...conflicts]);
    const failed = results.some((result) => result.status === "error");
    return {
      state: { ...state, ...patch },
      patch,
      results: [{ stepName: step.name, status: failed ? "error" : "done", durationMs: 0 }, ...results],
    };
  }

  private async executeGraphStep(
    step: GraphStep<TState>,
    state: TState,
    ctx: RunContext,
    opts: RunOpts | undefined,
    scope: string,
    depth: number,
    expansionScope: string,
  ): Promise<StepExecution<TState>> {
    let materializedStep = step;
    if (ctx.rootExecution) {
      const declaration = { ...step };
      let factoryInput: TState;
      try {
        factoryInput = structuredClone(state);
      } catch (cause) {
        throw new WorkflowDefinitionError("Workflow graph entry state must be structured-cloneable", { cause });
      }
      const nodes = typeof declaration.graph === "function" ? declaration.graph(factoryInput) : declaration.graph;
      materializedStep = { ...declaration, graph: nodes };
      validateWorkflowSteps([materializedStep]);
      await ctx.rootExecution.expand(
        nodes.map(
          (node) => `${expansionScope}/node/${encodeURIComponent(node.id)}/${encodeURIComponent(node.step.name)}`,
        ),
      );
    }
    const outcome = await executeWorkflowGraph(
      materializedStep,
      state,
      ctx.signal,
      (node, input) =>
        this.executeStepWithPatch(
          node.step,
          input,
          ctx,
          opts,
          `${scope}/${encodeURIComponent(node.id)}`,
          depth + 1,
          `${expansionScope}/node/${encodeURIComponent(node.id)}/${encodeURIComponent(node.step.name)}`,
        ),
      scope,
    );
    const failed = outcome.results.some(
      (result) => result.status === "error" || result.reason?.code === "workflow_dependency_blocked",
    );
    return {
      state: { ...state, ...outcome.patch },
      patch: outcome.patch,
      results: [{ stepName: step.name, status: failed ? "error" : "done", durationMs: 0 }, ...outcome.results],
    };
  }

  private async executeRepeatStep(
    step: RepeatStep<TState>,
    state: TState,
    ctx: RunContext,
    opts: RunOpts | undefined,
    scope: string,
    depth: number,
    expansionScope: string,
  ): Promise<StepExecution<TState>> {
    if (
      !Number.isSafeInteger(step.maxIterations) ||
      step.maxIterations <= 0 ||
      typeof step.while !== "function" ||
      !Array.isArray(step.repeat)
    )
      throw new WorkflowDefinitionError("Repeat requires a positive safe maxIterations, predicate and step array");
    const maxIterations = step.maxIterations;
    const predicate = step.while;
    const body = [...step.repeat];
    let current = { ...state };
    const patch: Partial<TState> = {};
    const results: StepResult[] = [];
    let iteration = 0;
    while (true) {
      ctx.signal?.throwIfAborted();
      let again: boolean;
      try {
        again = predicate(current, iteration);
      } catch (error) {
        ctx.signal?.throwIfAborted();
        if (fatal(error)) throw error;
        return {
          state: current,
          patch,
          results: [{ stepName: step.name, status: "error", error: errorMessage(error), durationMs: 0 }, ...results],
        };
      }
      ctx.signal?.throwIfAborted();
      if (typeof again !== "boolean") throw new WorkflowDefinitionError("Repeat predicate must return a boolean");
      if (!again) break;
      if (iteration >= maxIterations) {
        const reason = {
          code: "workflow_iteration_limit",
          message: `Workflow repeat ${step.name} exhausted ${maxIterations} iterations`,
        };
        return {
          state: current,
          patch,
          results: [{ stepName: step.name, status: "error", error: reason.message, reason, durationMs: 0 }, ...results],
        };
      }
      const outcome = await this.executeStepsWithPatch(
        body,
        current,
        ctx,
        opts,
        `${scope}/${iteration}`,
        depth + 1,
        `${expansionScope}/iteration/${iteration}`,
      );
      current = outcome.state;
      Object.assign(patch, outcome.patch);
      results.push(...outcome.results);
      if (outcome.results.some((result) => result.status === "error"))
        return {
          state: current,
          patch,
          results: [{ stepName: step.name, status: "error", durationMs: 0 }, ...results],
        };
      iteration++;
    }
    return { state: current, patch, results: [{ stepName: step.name, status: "done", durationMs: 0 }, ...results] };
  }

  private async withRetry(fn: () => Promise<StepExecution<TState>>, ctx: RunContext): Promise<StepExecution<TState>> {
    const maxRetries = this.retryPolicy?.maxRetries ?? 0;
    const backoffMs = this.retryPolicy?.backoffMs ?? 1000;
    for (let attempt = 0; ; attempt++) {
      ctx.signal?.throwIfAborted();
      try {
        return await fn();
      } catch (error) {
        ctx.signal?.throwIfAborted();
        if (fatal(error) || ctx.executionServices || attempt >= maxRetries) throw error;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const waiting = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, backoffMs * 2 ** attempt);
        });
        try {
          await (ctx.signal ? abortable(waiting, ctx.signal) : waiting);
        } finally {
          clearTimeout(timer);
        }
      }
    }
  }
}
