# Execution graphs in the harness SDK

Source requirement: attachment `1136c323-de14-41bd-a975-fcc948c610f7`, 2026-10-13. Implementation baseline: `f5e4434723c33f2610416bee789c78bb32787315`; branch `agent/execution-graphs` in the attached dependability worktree. Preserve the original checkout's ongoing durable-continuation work.

## Evidence and choice

ReAct §2 supports adaptation after observations. OpenHands §§2.1–2.4 separates decisions, event history and runtime effects. LLMCompiler §§3.1–3.4 schedules dependency DAGs, permits tools that are agents, and replans after results. These support composition, not durability or exactly-once claims. See [research](research.md) for pinned primary sources.

Agentium already supplies serial, condition and parallel `Workflow` steps, owned patches, Agent loops, ToolExecutor, controlled ExecutionServices, shared harness budgets, boundary checkpoints and evaluation adapters. `core/src/graph` is a knowledge graph, not an execution scheduler. Choose an explicit workflow DAG containing existing bounded Agent/function/structural steps, with a bounded repeat step for adaptive episodes. A second Agent tool-plan scheduler is deferred: existing ToolExecutor already parallelizes a model's complete tool batch, and a second planner/retry/budget owner is not needed here.

## Additive contract

- `GraphStep<T>`: `name`, `graph: WorkflowGraphNode<T>[] | ((state: T) => WorkflowGraphNode<T>[])`, `maxConcurrency?: number` (default 5), `maxNodes?: number` (default 100), `merge?: 'error' | 'declaration_order'` (default error).
- `WorkflowGraphNode<T>`: unique nonempty `id`, existing `step: StepDef<T>`, optional `dependsOn: string[]` and `inputsFrom: string[]`.
- `dependsOn` is a control edge: a predecessor must finish done or skipped. `inputsFrom` is a data edge and also a scheduling edge: its producer must finish done. Failed/blocked predecessors block consumers. A skipped condition can release a control join but cannot satisfy a data input.
- Node input is a structured clone of graph entry state plus patches from transitive data ancestors only, in stable topological order. Other completed siblings never leak into that input. Returned patches are cloned at settlement. Graph state and patches must be cloneable; trusted callbacks still retain any references they capture outside the SDK.
- Scheduling uses the union of control and data edges. Validate the complete episode before effects: IDs, references, duplicate edges, cycles, positive safe integer limits and node count. Stable topological order breaks ties by declaration order. Ready nodes start incrementally within maxConcurrency. Lifecycle: pending → running → done/error/skipped; blocked nodes are skipped with a reason. Inputs, results and joins are deterministic for fixed patches; timing, admissions against a shared budget and external effects are not.
- Final join uses stable topological order. Strict merge rejects keys written by incomparable nodes in the dependency union; ordered rewrites are allowed. Declaration-order mode means stable topological order with declaration ties. Conflicts abort the boundary, do not checkpoint it, and do not undo effects. Failed nodes contribute no patch; successful independent nodes can contribute even when another node fails.
- `RepeatStep<T>`: `name`, `repeat: StepDef<T>[]`, `while: (state: T, iteration: number) => boolean`, required positive safe integer `maxIterations`. Pre-test predicate uses zero-based count of completed iterations. At most that many bodies run. If still true at the bound, return an error with `workflow_iteration_limit`; stop on body error. A graph factory inside repeat reads previous observations and selects the next fully validated episode. No in-flight graph replacement or streamed partial plans.
- Add optional `executionPath` and `reason` to StepResult, and optional `executionPath` to workflow.step events. Graph IDs/iteration paths distinguish repeated step names, effect names and Agent child sessions. This is local causality, not an idempotency key or a durable per-attempt receipt.

## Ownership and reliability

The host supplies executable nodes and any mapping from a validated model proposal to an allowed step catalog. Raw model-produced IDs/functions are never executed. Node/tool/retrieved outputs remain data and Agent inputs; they do not become host instructions. The graph scheduler owns readiness and state joins; StepRunner owns execution; Agent owns its local reasoning/tool loop; ExecutionServices/host owns policy, shared budgets, approvals and controlled effect retry. Standalone existing retryPolicy remains available; controlled effects are never retried by Workflow. Intentional repeat is new work and can repeat external effects.

Signal cancellation stops admission, propagates through existing node execution, drains started work, then discards late patches. Cancellation is cooperative; an uncooperative callback can delay settlement. maxNodes/concurrency/repeat limits bound structural work, existing Agent limits bound local work, and harness budgets bound shared model/tool expenditure. Parallel nodes must be safe for the host's resources: absent dependencies do not prove external-effect independence.

Existing versioned checkpoints cover completed top-level graph/repeat boundaries. Successful saved boundaries are skipped on continuation. No mid-graph/iteration resume, remote atomicity, exactly-once effects or recorded playback is promised. A crash/save failure can repeat a whole unsaved boundary. Existing DurableTaskSupervisor/ActionLedger/RunRecords are candidates for a later host adapter; harness durable capability stays false. Hosts must bump definitionVersion for changed factories, dependencies or callable code.

SDK owns contracts, validation, scheduling, patches, bounds and tests. Hosts own storage, resource locks, policy, credentials, retention, model choice, idempotency and reconciliation. No graph database/library dependency is needed.

## Integration finding

Real harness fixtures exposed a pre-existing policy identity bug: root `dispatch`/`dispatchEffect` passed both the context's lazy policy wrapper and its underlying policy to ToolExecutor, so one operation could consume two tool admissions. The integration reuses the same context policy identity for these root executors. Separate local/host policy composition in ToolExecutor is preserved. Four direct regressions cover exact-one-admission execution and host denial; graph function effects can now use an exact requested tool budget. `workflow_iteration_limit` also propagates as an additive aggregate reason through the existing driver/evaluation adapter.
