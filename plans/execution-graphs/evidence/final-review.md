# Independent execution graph review

Reviewed on 2026-10-13 in `/Users/xerycks/.codex/worktrees/core-harness-dependability/agentium`.

Base/merge-base: `f5e4434723c33f2610416bee789c78bb32787315`.
Implementation head: `00665ee0898d252d76a952ebecd2bbec05fd304b`.
The implementation checkout was clean at the beginning and at the last inspection before writing this report. This report is the reviewer's only written file. No implementation, index, branch, build, install, commit, paid call, external effect, or subagent work was performed.

Inputs: the original user attachment, `plans/execution-graphs/design.md`, `plan.md`, research and contributor reports, the progress ledger, complete branch diff, changed implementation/tests, and neighboring Workflow, RunContext, ToolExecutor, harness driver and checkpoint contracts. Applied the original checkout's code-review and TypeScript skills and requesting-code-review reviewer instructions. No applicable AGENTS.md was found in the checked checkout/ancestor paths.

## Strengths

- The change extends Workflow/StepRunner and reuses Agent, ToolExecutor, ExecutionServices, workflowDriver and the existing evaluation target. There is no competing runtime or new dependency.
- Scheduler control ancestry and data ancestry are separate. Input snapshots, owned patches and final results use a stable topological order, while the documentation correctly limits deterministic claims around shared-budget admissions and effects.
- Complete static episode validation, graph clone isolation, strict incomparable-write conflicts, transitive blocking and cancellation draining are coherent and receive focused coverage.
- The root dispatch/dispatchEffect policy identity fix is justified: ToolExecutor intentionally composes distinct context/local policies, and both original root identities delegated to the same budget-owning policy. Reusing `ctx.executionPolicy` removes duplicate admission without removing host policy/grant enforcement or distinct local-policy composition.
- Checkpoint schema changes retain the additive path/reason fields. The docs keep completed-boundary continuation distinct from recorded replay, mid-graph recovery and remote-effect safety. The adapter remains `durable: false`.
- The paired offline comparison retains independently specified expected outputs and reports exact outcomes, calls, tokens, reservations and zero offline charges without claiming production speedup or real-model quality.

## Standards and correctness findings

### F1 — P2: Snapshot the validated repeat limit before callbacks execute

Location: `packages/core/src/workflow/step-runner.ts:332` and `:336` (validation at `:319`).

`maxIterations` is validated once, but the loop reads the mutable `step.maxIterations` again after every predicate invocation. A predicate, body callback, or concurrent reuse of the host-owned definition can increase the limit after validation. This defeats the advertised bound and can even turn it into Infinity. Graph execution already captures its validated limits before invoking callbacks.

Confirmed trigger: start with `maxIterations: 1`; the predicate sets the same definition's limit to 3 and returns `iteration < 3`; the body increments a counter. The actual result was three body applications and `status: completed`, with no iteration-limit reason. The initial validated bound was one.

Impact: the SDK's structural safety limit can silently permit additional effects and work. Host-owned executable callbacks are trusted, but that does not make rereading mutable configuration a reliable execution bound.

Correction: capture the validated limit in a local before calling the predicate or body; use that same value for admission and exhaustion reporting. Add a regression that mutates the definition during execution and verifies the entry limit remains effective.

Confidence: high; reproduced directly against source at the reviewed head.

### F2 — P2: Prefix only results synthesized by the current graph invocation

Location: `packages/core/src/workflow/step-runner.ts:296`–`:298`.

The scheduler returns flattened child results. The wrapper prefixes every result with a dependency-blocked/node-failed reason, including results that were already fully scoped by a nested GraphStep. Each ancestor graph consequently prepends its own scope a second time.

Confirmed trigger: an `outer` graph has node `node`, whose `inner` graph contains a skipped condition `skip` and a data-dependent `blocked/consume` node. Other nested paths were correct, but the blocked result was:

```text
actual:   outer/outer/node/inner/blocked/consume
expected: outer/node/inner/blocked/consume
```

Impact: valid nested graph failures report nonexistent execution locations, lose reliable correlation with the corresponding node/event identity, and persist the corrupted path in checkpoints. Additional nesting compounds the error. This matters especially when step names repeat and executionPath is the distinguishing diagnostic key.

Correction: assign full paths when synthesizing current-scheduler results, or otherwise distinguish those rows from already scoped callback results. Do not identify path ownership solely by reason code. Cover nested blocked descendants and a checkpoint round trip.

Confidence: high; reproduced directly against source at the reviewed head.

### F3 — P2: Preserve accumulated repeat evidence when a later predicate throws

Location: `packages/core/src/workflow/step-runner.ts:332`; generic catch at `:124`–`:139`.

An ordinary exception from a repeat predicate escapes the repeat method and reaches the generic whole-step catch. That catch returns the repeat's entry state, an empty patch, and just one error result. It discards all completed iteration results and state already accumulated by the repeat. Body failure and iteration exhaustion correctly retain that accumulated information, so a predicate failure has materially different and surprising semantics.

Confirmed trigger: iteration zero runs an effect, returns `{n: 1}`, and completes; `while(state, 1)` then throws `Error("predicate failure")`. The actual result was:

```json
{
  "completedEffects": 1,
  "state": {"n": 0},
  "stepResults": [{"stepName": "repair", "status": "error", "error": "predicate failure"}]
}
```

Impact: direct Workflow callers lose the successful child's result/path and receive stale state even though its effect already executed. With the default continue policy, later serial steps consume that stale state; checkpoint execution can save the failed boundary without the completed iteration evidence. A nested graph can still atomically discard a failed node's patch, but it should retain the child's completed diagnostics.

Correction: handle ordinary predicate exceptions inside repeat execution, returning the current accumulated state/patch/results together with the repeat error, as the existing body-error branch does. Preserve the current escape/drain behavior for cancellation and fatal definition/merge errors. Add a regression after at least one completed iteration, including downstream state/evidence assertions.

Confidence: high; reproduced directly against source at the reviewed head.

## Specification verdict

The chosen explicit Workflow DAG with bounded Agent nodes and repeat episodes is a justified implementation of the user objective. The change covers the requested architecture comparison and engineering decisions; distinguishes control edges from data dependencies; reuses the existing runtime, controlled effects and shared budgets; supplies branching, joins, finite episodes and observation-driven replanning; preserves old entry points; and documents the durability/effect limits and host responsibilities.

No separate missing architecture feature was identified. A second model-generated tool-plan scheduler, streamed topology replacement and per-node durable resume were considered during design and reasonably deferred, rather than silently omitted requirements. The user explicitly allowed the best justified design and verification “where supported by the chosen design.” The existing ToolExecutor already handles concurrent model tool batches, and the new incremental DAG demonstrates a capability beyond serial/parallel grouping.

The implementation is not yet fully conformant with the selected contract: F1 contradicts the advertised validated repeat bound, F2 contradicts scoped nested node identity, and F3 weakens the lifecycle/partial-failure evidence contract. These are implementation corrections, not reasons to replace the architecture.

## Verification and evidence scope

Independent execution was limited to three focused read-only probes using source imports:

```text
TSX_DISABLE_CACHE=1 node --import tsx --input-type=module
```

The stdin program imported `packages/core/src/workflow/workflow.ts`, instantiated unregistered Workflows, and ran only local counter/no-op callbacks. It reproduced F1, F2 and F3 with the outputs recorded above. No fixture files or caches were written by the probes.

Reviewed test coverage includes the scheduler's invalid IDs/edges/references/cycles/limits/step shapes/static recursion, stable-order joins and same-value writes, transitive data-only visibility, nested error patch rejection, cancellation/late settlement, dynamic factory isolation, encoded Agent session identity, core checkpoint continuation, harness shared budgets/host authority/cancellation/retry behavior, and packed ESM/CJS/.ts/.cts consumer additions.

The coordinator reported 123 core workflow tests plus core types, ten harness graph tests and four exact-budget regressions passing before this review. Those are supplied verification evidence, not tests independently rerun by this reviewer. Full builds, monorepo tests/types, packed consumers and the final comparison rerun remain coordinator-owned and were not duplicated. This report does not claim those broader checks passed.

## Declined to judge as defects

- Live-model task quality, production latency and billed cost: the user permits a feasible comparison and the implementation labels its fixture evidence honestly; no paid experiment was authorized or needed for this review.
- Mid-graph resume, recorded playback, remote exactly-once effects and crash reconciliation: the selected boundary-continuation design explicitly excludes them and explains the loss window. No contradictory durable capability claim was found.
- A second Agent tool-plan scheduler or streamed/in-flight graph replacement: the architecture comparison gives a repository-specific reason to defer them, while complete bounded episodes supply the selected replanning capability.
- Aggregate root-tool concurrency, deterministic winners for the final shared-budget admission, and a global total expansion budget across nested graph/repeat steps: the implementation explicitly defines node concurrency, timing-dependent admissions, and multiplied local bounds. This review checked those definitions for contradictions rather than imposing a different scheduler design.
- Isolation of captured host resources, mutable RunContext session state, or callbacks relying on in-place state mutation instead of owned patches: executable callbacks are trusted, and the existing API requires owned patches and host resource coordination. Graph data isolation is not presented as a sandbox. This does not excuse F1's failure to retain an already validated execution limit.
- Bounded shutdown for uncooperative host callbacks: the stated cooperative cancellation contract drains owned started work; it makes no preemption promise.
- Independent revalidation of all paper claims and all pre-existing durable/Agent/ToolExecutor internals: the review read the cited research interpretation and traced changed integration behavior, but did not repeat the dedicated research investigation or audit unrelated baseline subsystems.

## Assessment

Corrections are required for F1–F3 before claiming the selected graph contract complete. The architecture and primary scheduler semantics are otherwise coherent; the remaining verification work should target these defects and the coordinator's final integrated revision. No publication or integration action is recommended or performed by this review.
