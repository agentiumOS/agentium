import { RootExecutionError } from "../agent/root-execution.js";
import { AwaitingDurableApproval, DurableConflictError, DurableRecoveryRequiredError } from "../durable/types.js";
import { WorkflowCancellationError, WorkflowDefinitionError, WorkflowMergeConflict } from "./errors.js";
import type { GraphStep, StepDef, StepResult, WorkflowGraphNode } from "./types.js";

const MAX_STATIC_DEPTH = 64;
const STEP_KINDS = ["run", "agent", "condition", "parallel", "graph", "repeat"];

type DependencyNode = { id: string; dependencies: string[] };
type NodePhase = "pending" | "running" | "done" | "error" | "skipped" | "blocked";
type NodeExecution<T> = {
  node: WorkflowGraphNode<T>;
  dependencies: string[];
  ancestors: Set<string>;
  dataAncestors: Set<string>;
  phase: NodePhase;
  patch: Partial<T>;
  results: StepResult[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function requireName(value: unknown, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WorkflowDefinitionError(`${label} must be a nonempty string`);
  }
  try {
    encodeURIComponent(value);
  } catch (cause) {
    throw new WorkflowDefinitionError(`${label} must contain valid Unicode`, { cause });
  }
}

function requireLimit(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new WorkflowDefinitionError(`${label} must be a positive safe integer`);
  }
}

function requireMerge(value: unknown): void {
  if (value !== undefined && value !== "error" && value !== "declaration_order") {
    throw new WorkflowDefinitionError("Workflow merge must be error or declaration_order");
  }
}

function readDependencies(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!isArray(value)) throw new WorkflowDefinitionError(`${label} must be an array`);
  const dependencies: string[] = [];
  const seen = new Set<string>();
  for (const dependency of value) {
    if (typeof dependency !== "string" || dependency.trim().length === 0) {
      throw new WorkflowDefinitionError(`${label} must contain nonempty node IDs`);
    }
    if (seen.has(dependency)) throw new WorkflowDefinitionError(`${label} contains duplicate node ID ${dependency}`);
    seen.add(dependency);
    dependencies.push(dependency);
  }
  return dependencies;
}

/** Kahn order uses the original declaration index to break every readiness tie. */
function topologicalOrder(nodes: DependencyNode[]): string[] {
  const declarations = new Map(nodes.map((node, index) => [node.id, index]));
  const remaining = new Map(nodes.map((node) => [node.id, node.dependencies.length]));
  const dependants = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dependency of node.dependencies) {
      if (!declarations.has(dependency)) {
        throw new WorkflowDefinitionError(`Graph node ${node.id} references missing node ${dependency}`);
      }
      if (dependency === node.id) throw new WorkflowDefinitionError(`Graph node ${node.id} depends on itself`);
      const children = dependants.get(dependency) ?? [];
      children.push(node.id);
      dependants.set(dependency, children);
    }
  }
  const ready = nodes.filter((node) => node.dependencies.length === 0).map((node) => node.id);
  const ordered: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) break;
    ordered.push(id);
    for (const child of dependants.get(id) ?? []) {
      const count = (remaining.get(child) ?? 0) - 1;
      remaining.set(child, count);
      if (count === 0) ready.push(child);
    }
    ready.sort((a, b) => (declarations.get(a) ?? 0) - (declarations.get(b) ?? 0));
  }
  if (ordered.length !== nodes.length) throw new WorkflowDefinitionError("Workflow graph contains a dependency cycle");
  return ordered;
}

function validateEpisode(value: unknown, maxNodes: number, depth: number, active: Set<object>): string[] {
  if (!isArray(value)) throw new WorkflowDefinitionError("Workflow graph must materialize a node array");
  if (value.length > maxNodes) throw new WorkflowDefinitionError(`Workflow graph exceeds maxNodes ${maxNodes}`);
  const ids = new Set<string>();
  const nodes: DependencyNode[] = [];
  for (const node of value) {
    if (!isRecord(node)) throw new WorkflowDefinitionError("Workflow graph node must be an object");
    const id = node.id;
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new WorkflowDefinitionError("Workflow graph node ID must be a nonempty string");
    }
    requireName(id, "Workflow graph node ID");
    if (ids.has(id)) throw new WorkflowDefinitionError(`Workflow graph contains duplicate node ID ${id}`);
    ids.add(id);
    const control = readDependencies(node.dependsOn, `Graph node ${id} dependsOn`);
    const data = readDependencies(node.inputsFrom, `Graph node ${id} inputsFrom`);
    nodes.push({ id, dependencies: [...new Set([...control, ...data])] });
    validateStep(node.step, depth, active);
  }
  return topologicalOrder(nodes);
}

function validateStepList(value: unknown, depth: number, active: Set<object>): void {
  if (!isArray(value)) throw new WorkflowDefinitionError("Workflow steps must be an array");
  for (const step of value) validateStep(step, depth, active);
}

function validateStep(value: unknown, depth: number, active: Set<object>): void {
  if (!isRecord(value)) throw new WorkflowDefinitionError("Workflow step must be an object");
  if (depth > MAX_STATIC_DEPTH)
    throw new WorkflowDefinitionError(`Workflow static nesting exceeds ${MAX_STATIC_DEPTH}`);
  if (active.has(value)) throw new WorkflowDefinitionError("Workflow definition contains recursive step objects");
  requireName(value.name, "Workflow step name");
  const kinds = STEP_KINDS.filter((kind) => kind in value);
  if (kinds.length !== 1) throw new WorkflowDefinitionError("Workflow step must define exactly one execution kind");
  active.add(value);
  try {
    switch (kinds[0]) {
      case "run":
        if (typeof value.run !== "function") throw new WorkflowDefinitionError("Workflow run must be callable");
        break;
      case "agent":
        if (!isRecord(value.agent) || typeof value.agent.run !== "function") {
          throw new WorkflowDefinitionError("Workflow agent must expose a callable run");
        }
        if (value.inputFrom !== undefined && typeof value.inputFrom !== "function") {
          throw new WorkflowDefinitionError("Workflow inputFrom must be callable");
        }
        break;
      case "condition":
        if (typeof value.condition !== "function")
          throw new WorkflowDefinitionError("Workflow condition must be callable");
        validateStepList(value.steps, depth + 1, active);
        break;
      case "parallel":
        requireMerge(value.merge);
        validateStepList(value.parallel, depth + 1, active);
        break;
      case "repeat":
        requireLimit(value.maxIterations, "Workflow maxIterations");
        if (typeof value.while !== "function") throw new WorkflowDefinitionError("Workflow while must be callable");
        validateStepList(value.repeat, depth + 1, active);
        break;
      case "graph": {
        if (value.maxConcurrency !== undefined) requireLimit(value.maxConcurrency, "Workflow maxConcurrency");
        if (value.maxNodes !== undefined) requireLimit(value.maxNodes, "Workflow maxNodes");
        requireMerge(value.merge);
        if (typeof value.graph !== "function") {
          const maxNodes = typeof value.maxNodes === "number" ? value.maxNodes : 100;
          validateEpisode(value.graph, maxNodes, depth + 1, active);
        }
        break;
      }
    }
  } finally {
    active.delete(value);
  }
}

/** Validate static definitions without calling predicates, factories, Agents or functions. */
export function validateWorkflowSteps<T>(steps: StepDef<T>[]): void {
  validateStepList(steps, 1, new Set());
}

function clone<T>(value: T, label: string): T {
  try {
    return structuredClone(value);
  } catch (cause) {
    throw new WorkflowDefinitionError(`${label} must be structured-cloneable`, { cause });
  }
}

/** Define owned keys directly, so an own __proto__ key never invokes a setter. */
function applyPatch<T>(target: T | Partial<T>, patch: Partial<T>): void {
  for (const key of Object.keys(patch)) {
    Object.defineProperty(target, key, {
      value: Reflect.get(patch, key),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
}

function fatal(error: unknown): boolean {
  return (
    error instanceof WorkflowCancellationError ||
    error instanceof RootExecutionError ||
    error instanceof DurableConflictError ||
    error instanceof DurableRecoveryRequiredError ||
    error instanceof AwaitingDurableApproval ||
    error instanceof WorkflowDefinitionError ||
    error instanceof WorkflowMergeConflict
  );
}

function relativePath<T>(node: WorkflowGraphNode<T>): string {
  return `${encodeURIComponent(node.id)}/${encodeURIComponent(node.step.name)}`;
}

/** Execute one validated dependency episode; the caller owns its root StepResult. */
export async function executeWorkflowGraph<T extends Record<string, unknown>>(
  step: GraphStep<T>,
  state: T,
  signal: AbortSignal | undefined,
  executeNode: (node: WorkflowGraphNode<T>, input: T) => Promise<{ patch: Partial<T>; results: StepResult[] }>,
  executionScope?: string,
): Promise<{ patch: Partial<T>; results: StepResult[] }> {
  signal?.throwIfAborted();
  validateStep(step, 1, new Set());
  const maxConcurrency = step.maxConcurrency ?? 5;
  const maxNodes = step.maxNodes ?? 100;
  const strictMerge = step.merge !== "declaration_order";
  const base = clone(state, `Workflow graph ${step.name} entry state`);
  const materialized =
    typeof step.graph === "function" ? step.graph(clone(base, "Workflow graph factory input")) : step.graph;
  signal?.throwIfAborted();
  const order = validateEpisode(materialized, maxNodes, 2, new Set([step]));
  const declared = new Map<string, WorkflowGraphNode<T>>();
  for (const node of materialized) {
    const copy = { ...node, dependsOn: [...(node.dependsOn ?? [])], inputsFrom: [...(node.inputsFrom ?? [])] };
    Object.freeze(copy.dependsOn);
    Object.freeze(copy.inputsFrom);
    declared.set(copy.id, Object.freeze(copy));
  }
  const nodes: NodeExecution<T>[] = [];
  const byId = new Map<string, NodeExecution<T>>();
  for (const id of order) {
    const node = declared.get(id);
    if (!node) throw new WorkflowDefinitionError(`Missing validated graph node ${id}`);
    const dependencies = [...new Set([...(node.dependsOn ?? []), ...(node.inputsFrom ?? [])])];
    const ancestors = new Set(dependencies);
    for (const dependency of dependencies) {
      for (const ancestor of byId.get(dependency)?.ancestors ?? []) ancestors.add(ancestor);
    }
    const dataAncestors = new Set(node.inputsFrom ?? []);
    for (const dependency of node.inputsFrom ?? []) {
      for (const ancestor of byId.get(dependency)?.dataAncestors ?? []) dataAncestors.add(ancestor);
    }
    const execution: NodeExecution<T> = {
      node,
      dependencies,
      ancestors,
      dataAncestors,
      phase: "pending",
      patch: {},
      results: [],
    };
    nodes.push(execution);
    byId.set(id, execution);
  }

  const running = new Set<Promise<void>>();
  const nodePath = (node: WorkflowGraphNode<T>) =>
    executionScope === undefined ? relativePath(node) : `${executionScope}/${relativePath(node)}`;
  const writers = new Map<string, NodeExecution<T>[]>();
  let stopped = false;
  let stoppedError: unknown;
  const stop = (error: unknown) => {
    if (!stopped) {
      stopped = true;
      stoppedError = error;
    }
  };
  const abort = () => stop(signal?.reason ?? new WorkflowCancellationError(step.name));
  signal?.addEventListener("abort", abort, { once: true });

  const settleNode = async (execution: NodeExecution<T>, input: T): Promise<void> => {
    try {
      const outcome = await executeNode(execution.node, input);
      if (stopped) return;
      execution.results = outcome.results;
      if (outcome.results.some((result) => result.status === "error")) {
        execution.phase = "error";
        return;
      }
      if (outcome.results[0]?.status === "skipped") {
        execution.phase = "skipped";
        return;
      }
      if (!isRecord(outcome.patch)) throw new WorkflowDefinitionError("Workflow graph node patch must be an object");
      const patch = clone(outcome.patch, `Workflow graph node ${execution.node.id} patch`);
      const conflicts: string[] = [];
      for (const key of Object.keys(patch)) {
        const previous = writers.get(key) ?? [];
        if (
          strictMerge &&
          previous.some(
            (writer) => !execution.ancestors.has(writer.node.id) && !writer.ancestors.has(execution.node.id),
          )
        )
          conflicts.push(key);
      }
      if (conflicts.length > 0) throw new WorkflowMergeConflict(step.name, conflicts.sort());
      for (const key of Object.keys(patch)) {
        const previous = writers.get(key) ?? [];
        previous.push(execution);
        writers.set(key, previous);
      }
      execution.patch = patch;
      execution.phase = "done";
    } catch (error) {
      if (stopped) return;
      if (fatal(error)) {
        stop(error);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      execution.phase = "error";
      execution.results = [
        {
          stepName: execution.node.step.name,
          status: "error",
          error: message,
          durationMs: 0,
          executionPath: nodePath(execution.node),
          reason: { code: "workflow_node_failed", message },
        },
      ];
    }
  };

  try {
    while (true) {
      if (signal?.aborted) abort();
      if (stopped) {
        await Promise.all(running);
        throw stoppedError;
      }
      for (const execution of nodes) {
        if (stopped || execution.phase !== "pending") continue;
        const predecessors = execution.dependencies.map((id) => byId.get(id));
        if (predecessors.some((parent) => parent?.phase === "pending" || parent?.phase === "running")) continue;
        const blocked =
          predecessors.some((parent) => parent?.phase === "error" || parent?.phase === "blocked") ||
          (execution.node.inputsFrom ?? []).some((id) => byId.get(id)?.phase !== "done");
        if (blocked) {
          execution.phase = "blocked";
          execution.results = [
            {
              stepName: execution.node.step.name,
              status: "skipped",
              durationMs: 0,
              executionPath: nodePath(execution.node),
              reason: {
                code: "workflow_dependency_blocked",
                message: `Graph node ${execution.node.id} has an unsatisfied dependency`,
              },
            },
          ];
          continue;
        }
        if (running.size >= maxConcurrency) continue;
        try {
          const input = clone(base, `Workflow graph node ${execution.node.id} base input`);
          for (const ancestor of nodes) {
            if (execution.dataAncestors.has(ancestor.node.id) && ancestor.phase === "done")
              applyPatch(input, ancestor.patch);
          }
          const isolated = clone(input, `Workflow graph node ${execution.node.id} input`);
          execution.phase = "running";
          const pending = settleNode(execution, isolated).finally(() => running.delete(pending));
          running.add(pending);
        } catch (error) {
          stop(error);
        }
      }
      if (stopped) continue;
      if (running.size === 0) break;
      await Promise.race(running);
    }
    const patch: Partial<T> = {};
    const results: StepResult[] = [];
    for (const execution of nodes) {
      if (execution.phase === "done") applyPatch(patch, execution.patch);
      results.push(...execution.results);
    }
    return { patch, results };
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
