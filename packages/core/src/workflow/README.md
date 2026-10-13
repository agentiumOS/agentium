# Workflow execution and checkpoints

Function steps return owned, non-null object patches. Agent steps produce `${step.name}_output` only when the child completes (an omitted status on a legacy structural child counts as completed). Failed or stopped child output stays in `StepResult.output`, with its text, status and reason. It does not overwrite a successful named output field.

Conditions accumulate the selected serial branch's patches. Parallel branches start from shallow snapshots, settle all started work, then join only their produced patches in declaration order. The default `merge: "declaration_order"` lets the last declared writer win a collision, including intentional writes of the original value. `merge: "error"` throws `WorkflowMergeConflict` with code `workflow_merge_conflict`, the group name and at most 100 conflicting keys. A strict failed join applies none of that join's patches to its parent, writes no checkpoint and starts no downstream steps. Nested structural failures propagate after started siblings settle; completed external effects remain applied.

Nested objects are still shared across shallow branch snapshots. Replace nested values in returned patches and keep branch-owned objects separate. Direct mutation of a shared nested reference can affect siblings and the caller's input. This is not a deep isolation mode.

`failurePolicy: "continue"` collects ordinary errors and runs later serial steps. `failurePolicy: "stop"` records later serial steps as skipped. Already-started parallel siblings settle and successful patches may join. Any error result makes the aggregate `WorkflowResult.status` `failed`, with reason `workflow_step_failed`; skipped conditions alone leave it `completed`. A cancelled child throws `WorkflowCancellationError` with code `workflow_cancelled`. Parent signal cancellation preserves its abort reason. Cancellation escapes collection and retries, prevents late patches/checkpoints/completion, and does not undo remote effects. Standalone configured retries use abortable backoff; controlled effects are never automatically retried by Workflow after a rejected acknowledgement.

`runWithCheckpoints()` accepts the same caller identity, signal, execution services, mode, metadata and child-supported key/dependency options as `run()`, plus `initialState`. Checkpoints occur after complete top-level steps; conditions and parallel groups each form one boundary. A failed checkpoint save rejects before the next step, even though the completed effect may have applied.

For validated continuation, configure `definitionVersion` and `validateCheckpointState` together. The validator receives unknown external state and returns the expected state type. These workflows emit format version 2 checkpoints with the workflow name, definition version, ordered top-level step names and absolute cursor. `continueFromCheckpoint(id, opts)` validates all of those before effects, validates restored state, then clones it. Incompatibility or noncloneable state rejects with code `checkpoint_incompatible`. Hosts must bump the version when callable code or captured dependencies change; step names cannot detect those changes.

Continuation gets a fresh run context by default. Explicit caller options are authoritative; signals, services, credentials and dependencies are never serialized in checkpoint state. New checkpoints retain cumulative results, absolute step indices, `parentCheckpointId` and `parentRunId`. Continuing a continuation skips every previously completed top-level step. State and results are cloned on save, so subsequent ordinary mutation cannot rewrite earlier snapshots. Hosts using JSON stores must validate JSON-compatible state. Keep clients, callable dependencies and secrets in caller options rather than checkpoint state.

`replay()` and `fork()` are deprecated terminology/compatibility APIs: they execute remaining steps afresh and can repeat later effects. They retain legacy envelope acceptance through the current major, while validating the workflow name and repairing newly written absolute cursors. Version 2 records always receive strict validation, including through the wrappers. Legacy records cannot establish original code identity; callable or opaque legacy state remains accepted where the host store supports it. Ordinary containers are copied, while noncloneable opaque dependencies retain their existing reference compatibility. Do not treat old restarted indices as proof of the original cursor.

Migrate legacy records offline only after verifying the original workflow, absolute step index, definition version and state. Write the corrected absolute cursor, validated state, format version 2, definition version and ordered step names. The strict continuation API never guesses identity or offers a blanket legacy bypass. The test suite includes an explicit host migration fixture.

Checkpoints are state boundaries, not recorded model/tool playback, mid-step recovery, approval restoration, inherited active reservations, exactly-once effects or active harness recovery. Safe effect recovery needs an operation intent/receipt ledger, reconciliation, compatible code/backends and adapter atomicity. The Workflow harness adapter remains non-durable.

## Dependency graphs and bounded replanning

`GraphStep` adds a dependency episode to the existing Workflow. Each node has an `id` and an ordinary Agent, function, condition, parallel, graph or repeat step. `dependsOn` declares control order; `inputsFrom` declares both readiness and data flow. Control predecessors may be done or skipped. Data producers must be done. A failed or blocked predecessor blocks its consumers; a skipped condition releases a control join but cannot supply data. Blocked nodes appear as skipped with reason `workflow_dependency_blocked`, and make the graph fail.

```ts
import { Workflow, type GraphStep } from "@agentium/core";

type BuildState = { left: number; right: number; total: number };
const graph: GraphStep<BuildState> = {
  name: "calculate",
  maxConcurrency: 2,
  graph: [
    { id: "left", step: { name: "readLeft", run: async () => ({ left: 2 }) } },
    { id: "right", step: { name: "readRight", run: async () => ({ right: 3 }) } },
    {
      id: "sum",
      inputsFrom: ["left", "right"],
      step: { name: "sum", run: async (state) => ({ total: state.left + state.right }) },
    },
  ],
};
const calculation = new Workflow({
  name: "calculation", register: false,
  initialState: { left: 0, right: 0, total: 0 }, steps: [graph],
});
const result = await calculation.run(); // total = 5
```

Ready nodes start incrementally, up to `maxConcurrency` (positive safe integer, default 5). This is a node limit, not an aggregate tool/provider concurrency ceiling: an Agent or nested parallel step can start its own work. Hosts must encode resource ordering or supply locks where effects share a file, browser, database object or account. Missing data dependencies do not establish safe external-effect concurrency.

Every complete graph is checked before that episode's effects: unique IDs, valid step shapes, references, duplicate edges, cycles in the union of both edge types, limits and `maxNodes` (default 100). Static nested definitions are checked too. Dynamic factories are checked at entry; scoped graph/repeat composition has depth limit 64. Per-episode and repeat bounds multiply under nesting; there is no separate total expansion budget. Harness budgets still control aggregate expenditure.

Graph nodes receive separate structured clones of entry state plus patches from their transitive data ancestors. Control-only predecessors and unrelated completed siblings do not contribute data. State and returned patches must be structured-cloneable. This isolates ordinary nested data between nodes; it cannot isolate resources captured by trusted callbacks. Replace state with owned patches as for other Workflow steps.

Inputs, result order and final joins use stable topological order, breaking ties by declaration order. Completion timing does not choose patch winners. The new graph defaults to `merge: "error"`, which rejects overlapping owned keys from incomparable nodes in the dependency union, including same-value writes. A descendant can intentionally overwrite its predecessor. `merge: "declaration_order"` opts into later writers in that stable topological order. Existing ParallelStep keeps its original declaration-order default. Successful independent nodes can contribute patches when another node fails; failed or skipped nodes contribute none. A conflict/cancellation rejects the boundary, prevents downstream Workflow steps and its checkpoint, and does not undo effects already issued.

A `graph` factory can select a new complete episode from current state. Combine it with `RepeatStep` to repair after observations:

```ts
import { Workflow } from "@agentium/core";

const repair = new Workflow({
  name: "bounded-repair", register: false,
  initialState: { attempts: 0, verified: false },
  steps: [{
    name: "repair", maxIterations: 2,
    while: (state) => !state.verified,
    repeat: [{
      name: "episode",
      graph: (state) => [{
        id: state.attempts === 0 ? "first-try" : "repair-try",
        step: {
          name: "check",
          run: async (input) => ({ attempts: input.attempts + 1, verified: input.attempts === 1 }),
        },
      }],
    }],
  }],
});
```

The repeat predicate is pre-tested with the zero-based number of completed iterations. It is checked after the last allowed body too: false succeeds, still true returns `workflow_iteration_limit` through Workflow/harness/eval. Body errors stop repetition. Each graph factory runs once at episode entry, after previous work has settled. Replanning does not modify running nodes, reuse stale outputs automatically or stream unvalidated plans. Hosts may map validated model proposals into an approved executable catalog; node-produced text is data and never automatically gains host-instruction authority.

Scoped graph node IDs and repeat iteration paths appear in `StepResult.executionPath`, workflow events, Agent child session IDs and `metadata.workflowExecutionPath`. Segments use `encodeURIComponent`. Function effect names become `workflow:<executionPath>`, such as `workflow:calculate/left/readLeft`; grant those explicitly under harness control. Legacy function names outside these scopes stay `workflow:<step.name>`. Agent output keys stay `${step.name}_output`, so distinct nodes writing the same key require ordering or an explicit merge choice. Paths are diagnostic identity, not remote idempotency keys or durable attempt receipts.

Existing Agent bounds, signals and ExecutionServices are reused. Graph/repeat does not reset shared harness model/tool/token budgets or add a retry owner. Agent limits apply to each new Agent invocation; the shared harness budget caps the complete run. Ready work is chosen incrementally, so timing can change which node wins the remaining shared budget. Cancellation stops admissions, propagates to node execution, waits for started work to settle and discards late patches. Uncooperative host callbacks can delay cancellation. Deliberate repeat can issue effects again; controlled Workflow never automatically retries a rejected effect acknowledgement.

Graph and repeat are complete top-level checkpoint boundaries. A saved completed boundary is skipped on validated continuation; internal nodes or iterations are not separately checkpointed. A crash, cancellation or failed save can cause an unsaved boundary's effects to run again from an earlier checkpoint. Definition versions must cover factory/callback/environment changes. Recorded replay, mid-graph resume and external-effect reconciliation require a separate host adapter. The existing durable ledger/supervisor are not automatically connected, and the harness driver keeps `durable: false`.
