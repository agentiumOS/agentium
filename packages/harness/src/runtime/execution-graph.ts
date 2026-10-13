import {
  DurableConflictError,
  type DurableExecutionContext,
  type DurableGraphDefinition,
  DurableGraphJournal,
  type DurableGraphState,
  type DurableIdentity,
  type DurableJSON,
  DurableRecoveryRequiredError,
  type DurableTaskKey,
  type DurableTaskRecord,
  type DurableTaskStore,
  DurableTaskSupervisor,
  durableCanonical,
  durableDigest,
  InMemoryDurableTaskStore,
  RootExecutionController,
  type RootExecutionEvent,
  type RootExecutionLimits,
  validateRootExecutionCounts,
  Workflow,
  type WorkflowGraphNode,
} from "@agentium/core";
import { parseHarnessBudgetState } from "./budget.js";
import {
  type ExecutionDriver,
  type HarnessExecutionServices,
  HarnessRuntime,
  type HarnessRuntimeConfig,
} from "./driver.js";
import { generateExecutionPlan, streamExecutionPlans } from "./execution-planner.js";
import {
  ExecutionPlanValidationError,
  graphCatalogDigest,
  resolvePlanArguments,
  validateExecutionPlan,
} from "./execution-proposal.js";
import type {
  ExecutionGraphLimits,
  ExecutionGraphProgram,
  GraphBinding,
  PlanValidationLimits,
} from "./graph-contracts.js";
import {
  createGraphRecoveryPorts,
  graphToolOutput,
  resolveGraphEffectBinding,
  scopeGraphServices,
} from "./graph-recovery.js";
import { commitExecutionPlan, type MaterializedExecutionPlan, readExecutionPlan } from "./plan-commit.js";

export interface ExecutionGraphRuntimeOptions {
  program: ExecutionGraphProgram;
  catalog: readonly GraphBinding[];
  harness: Omit<HarnessRuntimeConfig, "driver" | "tools">;
  limits?: ExecutionGraphLimits;
  store?: DurableTaskStore;
  requireDurable?: boolean;
  leaseMs?: number;
  pollMs?: number;
  onAdmission?: (event: RootExecutionEvent) => void;
}
export interface ExecutionGraphTaskOptions {
  id: string;
  identity: DurableIdentity;
  input: DurableJSON;
  deadline?: number;
  policyRevision?: number;
  grantRefs?: string[];
  maxAttempts?: number;
}
export interface ExecutionGraphResult {
  task: DurableTaskRecord;
  graph: DurableGraphState;
  output?: DurableJSON;
}
function json(value: unknown): DurableJSON {
  return JSON.parse(durableCanonical(value));
}
function snapshotProgram(program: ExecutionGraphProgram): ExecutionGraphProgram {
  return {
    ...program,
    ...(program.plan ? { plan: structuredClone(program.plan) } : {}),
    ...(program.planner ? { planner: { ...program.planner, stream: structuredClone(program.planner.stream) } } : {}),
  };
}
/** Own all plain configuration. Schemas, Agent/provider instances and callbacks
 * remain host bindings whose implementation is attested by the catalog version. */
function snapshotOptions(options: ExecutionGraphRuntimeOptions): ExecutionGraphRuntimeOptions {
  return {
    ...options,
    program: snapshotProgram(options.program),
    limits: options.limits && structuredClone(options.limits),
    harness: {
      ...options.harness,
      budgets: options.harness.budgets && structuredClone(options.harness.budgets),
      grants: structuredClone(options.harness.grants),
      requirements: options.harness.requirements && [...options.harness.requirements],
      models: Object.fromEntries(
        Object.entries(options.harness.models ?? {}).map(([role, binding]) => [
          role,
          {
            ...binding,
            options: binding.options && [...binding.options],
          },
        ]),
      ),
    },
    catalog: options.catalog.map((binding) => {
      const base = {
        ...binding,
        referenceInputs: binding.referenceInputs && [...binding.referenceInputs],
        referenceOutputs: binding.referenceOutputs && [...binding.referenceOutputs],
      };
      if (binding.kind === "tool") {
        const recovery = binding.recovery;
        return {
          ...base,
          kind: binding.kind,
          tool: {
            ...binding.tool,
            ...(binding.tool.sandbox !== undefined ? { sandbox: structuredClone(binding.tool.sandbox) } : {}),
            ...(binding.tool.rawJsonSchema ? { rawJsonSchema: structuredClone(binding.tool.rawJsonSchema) } : {}),
            ...(binding.tool.inputExamples ? { inputExamples: structuredClone(binding.tool.inputExamples) } : {}),
          },
          recovery:
            !recovery || recovery === "pure"
              ? recovery
              : {
                  ...recovery,
                  connector: {
                    version: recovery.connector.version,
                    dispatch: recovery.connector.dispatch.bind(recovery.connector),
                    ...(recovery.connector.reconcile
                      ? { reconcile: recovery.connector.reconcile.bind(recovery.connector) }
                      : {}),
                  },
                },
        };
      }
      if (binding.kind === "agent")
        return { ...base, kind: binding.kind, agent: binding.agent, tools: [...binding.tools] };
      if (binding.kind === "repeat")
        return {
          ...base,
          kind: binding.kind,
          program: snapshotProgram(binding.program),
          maxIterations: binding.maxIterations,
          while: binding.while,
        };
      return { ...base, kind: binding.kind, program: snapshotProgram(binding.program) };
    }),
  };
}
function programDescriptor(program: ExecutionGraphProgram): DurableJSON {
  if (!program.id || !program.version || Boolean(program.plan) === Boolean(program.planner))
    throw new TypeError("Execution program requires an id, version and exactly one plan or planner");
  return json({
    id: program.id,
    version: program.version,
    ...(program.plan
      ? { plan: program.plan }
      : {
          planner: {
            ...program.planner,
            provider: { providerId: program.planner!.provider.providerId, modelId: program.planner!.provider.modelId },
          },
        }),
  });
}
/** Recovery protocol over the existing local harness and Workflow scheduler.
 * Host binding versions attest schemas, callbacks, providers and effect policy. */
export class ExecutionGraphRuntime {
  readonly capabilities: {
    durable: boolean;
    recovery: "recorded-agent-decisions";
    globalAdmission: true;
    streamedPlans: true;
  };
  readonly store: DurableTaskStore;
  private readonly supervisor: DurableTaskSupervisor;
  private readonly validation: PlanValidationLimits;
  private readonly rootLimits: RootExecutionLimits;
  private readonly bindings: ReadonlyMap<string, GraphBinding>;
  private readonly catalogDigest: string;
  private readonly manifestHash: string;
  private readonly options: ExecutionGraphRuntimeOptions;
  constructor(options: ExecutionGraphRuntimeOptions) {
    options = snapshotOptions(options);
    this.options = options;
    this.store = options.store ?? new InMemoryDurableTaskStore();
    if (options.requireDurable && !this.store.capabilities.durable)
      throw new TypeError("A verified persistent durable task adapter is required");
    this.supervisor = new DurableTaskSupervisor(this.store, { leaseMs: options.leaseMs, pollMs: options.pollMs });
    this.validation = {
      maxBytes: 128_000,
      maxNodes: 100,
      maxDepth: 32,
      maxConcurrency: 5,
      ...options.limits?.plan,
      durable: true,
    };
    this.rootLimits = Object.fromEntries(Object.entries(options.limits ?? {}).filter(([key]) => key !== "plan"));
    new RootExecutionController(this.rootLimits);
    this.catalogDigest = graphCatalogDigest(options.catalog, this.validation);
    this.bindings = new Map(options.catalog.map((binding) => [binding.id, binding]));
    if (options.program.plan) validateExecutionPlan(options.program.plan, options.catalog, this.validation);
    const unsupported = [
      "definition",
      "controller",
      "contextPolicy",
      "completionPolicy",
      "recall",
      "taskSummary",
      "residentHistory",
      "sessionStore",
      "resources",
    ] as const;
    if (unsupported.some((key) => options.harness[key] !== undefined))
      throw new TypeError("Graph recovery requires stateless harness configuration and versioned catalog bindings");
    this.manifestHash = this.currentManifestHash();
    this.capabilities = Object.freeze({
      durable: this.store.capabilities.durable,
      recovery: "recorded-agent-decisions",
      globalAdmission: true,
      streamedPlans: true,
    });
  }
  private currentManifestHash(): string {
    return durableDigest({
      program: programDescriptor(this.options.program),
      catalogDigest: graphCatalogDigest(this.options.catalog, this.validation),
      rootLimits: this.rootLimits,
      validation: this.validation,
      budgets: this.options.harness.budgets ?? {},
      grants: this.options.harness.grants,
      models: Object.fromEntries(
        Object.entries(this.options.harness.models ?? {}).map(([role, value]) => [
          role,
          { providerId: value.provider.providerId, modelId: value.provider.modelId, options: value.options ?? [] },
        ]),
      ),
    });
  }
  private assertConfiguration(): void {
    if (this.currentManifestHash() !== this.manifestHash)
      throw new DurableConflictError("Execution graph configuration changed after admission");
  }
  async create(input: ExecutionGraphTaskOptions): Promise<DurableTaskRecord> {
    this.assertConfiguration();
    const value = json(input.input);
    if (input.deadline !== undefined && (!Number.isSafeInteger(input.deadline) || input.deadline < 0))
      throw new TypeError("deadline must be an absolute nonnegative safe integer");
    return this.supervisor.create({
      id: input.id,
      identity: input.identity,
      input: value,
      inputRef: `graph-input:${durableDigest(value)}`,
      manifestHash: this.manifestHash,
      driver: { id: "agentium.execution-graph", version: 1 },
      policyRevision: input.policyRevision ?? 1,
      grantRefs: input.grantRefs ?? [],
      budget: { maxAttempts: input.maxAttempts ?? 20 },
      extensions: { "agentium.graph.deadline": input.deadline ?? null },
    });
  }
  private definition(task: DurableTaskRecord): DurableGraphDefinition {
    this.assertConfiguration();
    if (task.manifestHash !== this.manifestHash)
      throw new DurableConflictError("Execution graph manifest or catalog changed");
    const deadline = task.extensions["agentium.graph.deadline"];
    if (deadline !== null && (typeof deadline !== "number" || !Number.isSafeInteger(deadline) || deadline < 0))
      throw new DurableConflictError("Invalid retained graph deadline");
    return {
      id: this.options.program.id,
      version: this.options.program.version,
      catalogDigest: this.catalogDigest,
      input: task.input ?? null,
      limits: json({ root: this.rootLimits, validation: this.validation, budgets: this.options.harness.budgets ?? {} }),
      ...(typeof deadline === "number" ? { deadline } : {}),
    };
  }
  async inspect(key: DurableTaskKey): Promise<ExecutionGraphResult> {
    const task = await this.store.get(key);
    if (!task) throw new DurableConflictError("Graph task not found");
    const graph = await new DurableGraphJournal(
      this.store,
      key,
      { workerId: "inspection", fence: task.fence },
      this.definition(task),
    ).snapshot();
    if (graph.metadata.output !== undefined && graph.metadata.outputDigest !== durableDigest(graph.metadata.output))
      throw new DurableConflictError("Graph result digest changed");
    return { task, graph, ...(graph.metadata.output !== undefined ? { output: graph.metadata.output } : {}) };
  }
  async cancel(key: DurableTaskKey, reason?: string): Promise<DurableTaskRecord> {
    return this.supervisor.cancel(key, reason);
  }
  async run(key: DurableTaskKey, workerId: string): Promise<ExecutionGraphResult> {
    const existing = await this.store.get(key);
    if (!existing) throw new DurableConflictError("Graph task not found");
    this.definition(existing);
    await this.supervisor.run(key, workerId, async (context) => this.execute(context, key), {
      reconcile: async (context) => {
        const journal = new DurableGraphJournal(this.store, key, context.lease, this.definition(context.task));
        await journal.initialize();
        for (const action of Object.values(context.task.actions)) {
          if (!["executing", "unknown"].includes(action.state)) continue;
          const binding = await resolveGraphEffectBinding(journal, action, this.options.catalog);
          if (!binding.recovery || binding.recovery === "pure") throw new DurableRecoveryRequiredError();
          await context.actions.reconcile(action.id, binding.recovery.connector);
        }
      },
    });
    return this.inspect(key);
  }
  private async execute(context: DurableExecutionContext, key: DurableTaskKey): Promise<{ resultRef: string }> {
    const definition = this.definition(context.task);
    const journal = new DurableGraphJournal(this.store, key, context.lease, definition);
    const state = await journal.initialize();
    const root = new RootExecutionController(this.rootLimits, {
      signal: context.signal,
      deadline: definition.deadline,
      onEvent: this.options.onAdmission,
      persistence: {
        update: async (mutate) => {
          const saved = await journal.mutate((draft) => {
            draft.admission = json(
              mutate(draft.admission === null ? undefined : validateRootExecutionCounts(draft.admission)),
            );
          });
          return validateRootExecutionCounts(saved.admission);
        },
      },
    });
    const ports = createGraphRecoveryPorts(journal, root, this.options.catalog);
    let failure: unknown;
    const driver: ExecutionDriver = {
      id: "agentium.execution-graph.local",
      version: 1,
      capabilities: { controls: [], durable: false, controlledExecution: true, policyCoverage: "local" },
      start: async (_request, services) => {
        try {
          const output = await this.episode(
            this.options.program,
            "root",
            definition.input,
            services,
            journal,
            root,
            ports,
          );
          await journal.mutate((draft) => {
            draft.metadata.output = output;
            draft.metadata.outputDigest = durableDigest(output);
          });
          return { text: durableCanonical(output), structured: output };
        } catch (error) {
          failure = error;
          throw error;
        }
      },
    };
    const runtime = new HarnessRuntime({
      ...this.options.harness,
      driver,
      tools: this.options.catalog.flatMap((binding) => (binding.kind === "tool" ? [binding.tool] : [])),
    });
    const result = await runtime.run(durableCanonical(definition.input), {
      identity: { tenantId: context.task.identity.tenantId, userId: context.task.identity.actorId },
      sessionId: context.task.identity.sessionId,
      rootRunId: context.task.identity.rootRunId,
      signal: root.signal,
      deadline: definition.deadline,
      rootExecution: root,
      recovery: {
        ...(state.budget !== null ? { budgetState: parseHarnessBudgetState(state.budget) } : {}),
        persistBudget: async (budget) => {
          await journal.mutate((draft) => {
            draft.budget = json(budget);
          });
        },
        invokeTool: async (tool, call, args, ctx, execute) => {
          this.assertConfiguration();
          return ports.invokeTool(tool, call, args, ctx, execute);
        },
      },
    });
    if (failure) throw failure;
    if (result.status !== "completed") throw new Error(result.reason?.message ?? `Graph harness ${result.status}`);
    return { resultRef: `graph-result:${durableDigest([key, definition])}` };
  }
  private async episode(
    program: ExecutionGraphProgram,
    scope: string,
    input: DurableJSON,
    services: HarnessExecutionServices,
    journal: DurableGraphJournal,
    root: RootExecutionController,
    ports: ReturnType<typeof createGraphRecoveryPorts>,
    depth = 1,
  ): Promise<DurableJSON> {
    this.assertConfiguration();
    if (!Number.isSafeInteger(depth) || depth < 1 || depth > this.validation.maxDepth)
      throw new ExecutionPlanValidationError("Inherited execution depth exhausted");
    await journal.mutate((draft) => {
      const key = `episodeDepth:${scope}`;
      if (draft.metadata[key] !== undefined && draft.metadata[key] !== depth)
        throw new DurableConflictError("Retained graph episode depth changed");
      draft.metadata[key] = depth;
    });
    if (program.planner) {
      const planning = {
        program,
        scope,
        input,
        services,
        journal,
        root,
        catalog: this.options.catalog,
        limits: this.validation,
        depth,
      };
      if (program.planner.mode !== "stream") {
        const committed = await generateExecutionPlan(planning);
        return this.executeMaterialized(committed, scope, input, services, journal, root, ports, depth);
      }
      // Planning consumes its provider slot independently from the scheduler.
      // Revisions may replace only unclaimed nodes; old compiled callbacks are fenced by their durable incarnation.
      const abortPlanning = new AbortController();
      let done = false;
      let planningError: unknown;
      let generation = 0;
      let wake: (() => void) | undefined;
      const notify = () => {
        generation++;
        wake?.();
        wake = undefined;
      };
      const producer = streamExecutionPlans({ ...planning, signal: abortPlanning.signal }, notify).then(
        () => {
          done = true;
          notify();
        },
        (error: unknown) => {
          planningError = error;
          done = true;
          notify();
        },
      );
      let executed = 0;
      let output: DurableJSON | undefined;
      while (true) {
        const observed = generation;
        const committed = await readExecutionPlan(journal, scope);
        if (committed && committed.validated.plan.revision > executed) {
          try {
            output = await this.executeMaterialized(committed, scope, input, services, journal, root, ports, depth);
            executed = committed.validated.plan.revision;
          } catch (error) {
            const latest = await readExecutionPlan(journal, scope);
            if (latest && latest.validated.plan.revision !== committed.validated.plan.revision) continue;
            abortPlanning.abort(error);
            await producer;
            throw error;
          }
          continue;
        }
        if (done) {
          if (planningError) throw planningError;
          if (output === undefined) throw new Error("Planner sealed without an executable plan");
          return output;
        }
        await new Promise<void>((resolve) => {
          if (generation !== observed) resolve();
          else wake = resolve;
        });
      }
    }
    const validated = validateExecutionPlan(program.plan, this.options.catalog, this.validation, depth);
    const committed =
      (await readExecutionPlan(journal, scope)) ??
      (await commitExecutionPlan(journal, root, scope, { baseRevision: 0, validated }));
    return this.executeMaterialized(committed, scope, input, services, journal, root, ports, depth);
  }
  private async executeMaterialized(
    committed: MaterializedExecutionPlan,
    scope: string,
    _input: DurableJSON,
    services: HarnessExecutionServices,
    journal: DurableGraphJournal,
    root: RootExecutionController,
    ports: ReturnType<typeof createGraphRecoveryPorts>,
    depth: number,
  ): Promise<DurableJSON> {
    const revalidated = validateExecutionPlan(committed.validated.plan, this.options.catalog, this.validation, depth);
    if (durableCanonical(revalidated) !== durableCanonical(committed.validated))
      throw new DurableConflictError("Retained graph plan validation changed");
    const levels = new Map<string, number>();
    for (const id of revalidated.order) {
      const node = revalidated.plan.nodes.find((node) => node.id === id);
      if (!node) throw new DurableConflictError("Missing retained graph node");
      levels.set(
        id,
        1 +
          Math.max(
            0,
            ...[...(node.dependsOn ?? []), ...(node.inputsFrom ?? [])].map((parent) => levels.get(parent) ?? 0),
          ),
      );
    }
    const nodes: WorkflowGraphNode<Record<string, unknown>>[] = committed.validated.plan.nodes.map((node) => ({
      id: node.id,
      dependsOn: node.dependsOn ? [...node.dependsOn] : undefined,
      inputsFrom: node.inputsFrom ? [...node.inputsFrom] : undefined,
      step: {
        name: node.id,
        run: async (state) => {
          this.assertConfiguration();
          const outputs = new Map(Object.entries(state).map(([id, value]) => [id, json(value)]));
          const raw = resolvePlanArguments(node, outputs, this.validation.maxDepth);
          const binding = this.bindings.get(node.binding);
          if (!binding) throw new DurableConflictError("Missing retained graph binding");
          binding.input.parse(raw);
          const nodeId = committed.nodeKeys[node.id];
          const output = await journal.node(
            nodeId,
            { id: binding.id, version: binding.version, kind: binding.kind },
            json(raw),
            async () => {
              root.signal.throwIfAborted();
              const scoped = scopeGraphServices(
                services,
                nodeId,
                binding.kind === "agent" ? binding.tools : binding.kind === "tool" ? [binding.id] : [],
                ports,
                journal,
              );
              if (binding.kind === "tool") {
                const result = await scoped.dispatch({ id: "operation", name: binding.tool.name, arguments: raw });
                await services.observeToolSettlements([result], scoped.ctx);
                if (result.error || result.denial) throw new Error(result.error ?? `Tool denied: ${result.denial}`);
                return graphToolOutput(binding, result.result);
              }
              if (binding.kind === "agent") {
                const supplied = Object.create(scoped) as HarnessExecutionServices;
                Object.defineProperty(supplied, "tools", {
                  value: scoped.tools.filter((tool) => !binding.agent.tools.some((local) => local.name === tool.name)),
                });
                const result = await binding.agent.run(durableCanonical(binding.input.parse(raw)), {
                  executionServices: supplied,
                  rootExecution: root,
                  runId: nodeId,
                  sessionId: scoped.ctx.sessionId,
                  tenantId: journal.key.tenantId,
                  signal: root.signal,
                  metadata: { executionGraphNodeId: nodeId },
                });
                if (result.status !== "completed") throw new Error(result.reason?.message ?? `Agent ${result.status}`);
                return json(binding.output.parse({ text: result.text, usage: result.usage }));
              }
              if (binding.kind === "graph")
                return json(
                  binding.output.parse(
                    await this.episode(
                      binding.program,
                      `${nodeId}/child`,
                      json(binding.input.parse(raw)),
                      services,
                      journal,
                      root,
                      ports,
                      depth + (levels.get(node.id) ?? 1),
                    ),
                  ),
                );
              let current = json(binding.input.parse(raw));
              let iteration = 0;
              while (true) {
                const shouldRun = await journal.decision(`${nodeId}/repeat/${iteration}`, () =>
                  binding.while(structuredClone(current), iteration),
                );
                if (typeof shouldRun !== "boolean") throw new DurableConflictError("Invalid persisted repeat decision");
                if (!shouldRun) break;
                if (iteration >= binding.maxIterations) throw new Error("Repeat iteration limit reached");
                current = await this.episode(
                  binding.program,
                  `${nodeId}/iteration/${iteration}`,
                  current,
                  services,
                  journal,
                  root,
                  ports,
                  depth + (levels.get(node.id) ?? 1),
                );
                iteration++;
              }
              return json(binding.output.parse(current));
            },
          );
          return { [node.id]: output };
        },
      },
    }));
    // Compiler closures orchestrate; only actual provider/tool callbacks borrow slots.
    const workflow = new Workflow({
      name: `${this.options.program.id}:${scope}`,
      register: false,
      initialState: {},
      failurePolicy: "stop",
      steps: [
        {
          name: "episode",
          graph: nodes,
          maxConcurrency: committed.validated.plan.maxConcurrency ?? this.validation.maxConcurrency,
          maxNodes: this.validation.maxNodes,
          merge: committed.validated.plan.merge ?? "error",
        },
      ],
    });
    const result = await workflow.run({
      signal: root.signal,
      tenantId: journal.key.tenantId,
      runId: `episode:${durableDigest(scope)}`,
    });
    if (result.status !== "completed") throw new Error(result.reason?.message ?? "Graph episode failed");
    return json(result.state);
  }
}
