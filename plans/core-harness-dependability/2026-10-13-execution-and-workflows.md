# Execution integrity and Workflow continuation implementation plan

> **Status: PROPOSED; analysis only.** Implement only after user approval. Use the [master plan](2026-10-13-core-harness-dependability.md) and [design](2026-10-13-core-harness-dependability-design.md).

**Goal:** Await persistence, enforce honest execution boundaries, compose Workflow writes, and distinguish safe continuation from playback.

**Architecture:** Reuse the core loop, ExecutionServices, existing Workflow runner and held harness lease. No second loop or transaction framework.

**Tech stack:** Existing TypeScript, Zod, Vitest and package consumers; no new dependency.

**Global constraints / review focus:** Preserve current work; observe late usage; do not retry an unknown commit or applied effect; do not release ownership before settlement. Review cap-zero, cancelled final output, nested strict joins, and continuation of a continuation.

Source inspected on 2026-10-13; no source edits, tests, builds, or live effects executed. Older SDK-audit probes are prior evidence, not new results. Paths are repository-relative under `/Users/xerycks/Xhip/agentium`; line numbers describe the inspected worktree.

## Retain and revise

Retain the core model/tool loop, neutral `ExecutionServices` port, harness-owned policy/budget/completion, host-owned persistence and deployment isolation, and adapters over Agent/Workflow/Team. No general graph engine is justified by the identified local defects. Retain implemented request controls, abortable generic retry, capability/endpoint checks, budget reservations and finishing allowances, resident archival, and public input validation; do not plan them again.

Retain harness cooperative shutdown: cancellation owns its session/resources until tracked work quiesces (`execution-drivers.test.ts:74`, `control-model.test.ts:123`). Releasing after an arbitrary timeout while old work can mutate state permits overlapping writers. A noncooperative custom driver can leave `result()` pending indefinitely; document the boundary and observable cancelling state. Do not claim cancellation undoes remote effects or invent safe forced release.

## Prioritized confirmed gaps

| ID / priority | Current evidence | Impact | Ownership / compatibility |
| --- | --- | --- | --- |
| E1 / P1 | Harness lease commit/release return void (`runtime/session-bindings.ts:16`); driver does not await commit at 1219/1246 or release at 1265; standalone retrieveHistory at 312 also ignores release completion. Prior F06 premature acknowledgement probe still matches source. | A Promise-returning remote adapter can be acknowledged/released before persistence; rejection escapes diagnostics. | Harness; additive void-or-Promise types and stronger terminal timing. |
| E2 / P1 | IncrementalSessionManager recovers sequence from meta/snapshot only (82–90), but loose record writes precede metadata (155–164). Prior F03 probe unchanged. | A manager recreated after failed metadata write can overwrite readable loose history. | Core local repair; does not solve independent-manager concurrency. |
| E3 / P1 | claimControlledToolRoundtrip returns outside controlled mode (llm-loop.ts:268–274); both modes call it but inclusive loops remain. | Standalone cap zero can execute a batch; effects have entry-path-dependent limits. | Core correctness change; preserve final answer request and shared controlled counters across revisions. |
| E4 / P1 | Nonstream final response returns without a post-response abort guard (llm-loop.ts:437–477); Agent sets completed at 949/emits complete at 995. Stream has checks at 1359/1394. | Structural provider or host hook can turn known cancellation into completion. | Core correction; preserve late usage/accounting. Generic retry cancellation is already fixed. |
| E5 / P1 | Parallel merge assigns full copied branch states (step-runner.ts:218–225). | Initialized a/b state loses an independent branch update. Prior F04 reproduction still follows current code. | Core; patch merge correction, collision ordering preserved initially. |
| E6 / P1 | Replay slices steps (workflow.ts:252), persists restarted indices (183/195), does not validate workflow name (219); checkpoint run options only session/user (139). | Replay of replay repeats completed steps; context/policy lost; wrong definitions accepted. | Core; cursor repair, additive validated continuation API, explicit rejection/migration of ambiguous legacy records. |
| E7 / P2 | StepRunner retry sleeps plain setTimeout (291); successful function/Agent awaits lack post-abort checks; parallel converts child rejections into group done. | Slow cancellation, late patches, final step can complete despite cancellation. | Core; cancellation parity while preserving collect-errors default. |
| E8 / P2 | Core length/filter response treated as normal final answer (437); no-finish stream allowed when no tool fragment (764). Harness streams already reject missing finish (938). | Incomplete/truncated output appears completed. | Core + harness Agent adapter; additive reasons, corrective status. |
| E9 / P2 | Team catches thrown HandoffSignal (team.ts:322); ToolExecutor settles it as control (365); Agent consumes it requiring Agent targets (907); Team test mocks obsolete throw (417). | Native Team handoff journey is broken; configured Agent targets transfer ownership away from Team. | Deprecation/guidance/real fixture; no unsafe thrown-transfer restoration. |

SessionManager and IncrementalSessionManager locks are instance-local; two managers sharing KV remain unsafe. Root storage work owns tuple encoding and any optional atomic session capability.

## E1 — Acknowledged harness persistence

Files: `packages/harness/src/runtime/session-bindings.ts`, `runtime/driver.ts`, `runtime/__tests__/execution-drivers.test.ts`, `runtime/__tests__/resident-history.test.ts` as needed, harness README. Current root/runtime exports already expose the changed interfaces.

Proposed public contract:

```ts
export interface HarnessSessionLease {
  read(): HarnessSessionSnapshot;
  commit(snapshot: Omit<HarnessSessionSnapshot, "revision">): void | Promise<void>;
  release(): void | Promise<void>;
}
```

InMemoryHarnessSessionStore remains synchronous. Update every runtime commit/release, including standalone retrieveHistory. Preserve cleanup ordering and primary errors:

```ts
commitAttempted = true; // set before invoking the extension
await lease.commit({ history: canonical, conversations, archivedHistory, state, replayable });
committed = true; // acknowledgement precedes this flag
// finally: settle owned calls/streams before writing partial evidence
if (lease && !commitAttempted) {
  commitAttempted = true;
  try {
    await lease.commit({ history: canonical, conversations, archivedHistory, state, replayable: false });
  } catch {
    cleanupDiagnostics.push("partial_history_commit_failed");
  }
}
// never retry an attempted write whose acknowledgement was lost
try {
  await lease?.release();
} catch {
  cleanupDiagnostics.push("session_release_failed");
}
```

Contract: snapshot replacement is serialized inside one held lease. Each successful commit acknowledges its revision. Hosts supply transactional/CAS behavior. Opaque acknowledgement loss is not proof that a write did not occur. Track `commitAttempted` separately from `committed`; a rejected main commit produces `session_commit_failed` and `session_commit_outcome_unknown`, with no cleanup re-commit. A run failing before any commit may make one awaited partial-evidence commit. Hosts reconcile unknown acknowledgement from their revision/write receipts; the SDK cannot infer whether the write applied. Cancellation during commit waits for its outcome, then follows current cancelled terminal precedence. No new driver/model work starts. Failed partial persistence is diagnostic and does not replace the execution error. If a completed driver candidate exists when its commit acknowledgement fails, preserve its text/structured/usage as partial evidence in the failed HarnessResult; do not replace it with empty text or claim completion. Set partial true with session_commit_failed and the unknown-outcome cleanup diagnostic.

Tests: deferred successful commit holds result and prevents release; delayed release holds result; failed main commit yields failed result, one commit attempt and an unknown-outcome diagnostic; rejected partial commit and release preserve primary error plus diagnostics; cancellation during commit yields one terminal, no second driver invocation; standalone retrieveHistory awaits release. Existing sync leases unchanged. Representative proposed test in the existing fixture module (its runtime/start/deferred helpers already exist):

```ts
it("awaits commit acknowledgement before releasing the writer", async () => {
  const entered = deferred();
  const ack = deferred();
  const release = vi.fn();
  const rt = runtime(async () => ({ text: "ok" }), {
    sessionStore: {
      guarantees: { durable: true, compareAndSwap: true, singleWriter: "distributed" },
      acquire: async () => ({
        read: () => ({ history: [], state: {}, revision: 0, replayable: true }),
        commit: async () => { entered.resolve(); await ack.promise; },
        release,
      }),
    },
  });
  const handle = rt.start("hello", start);
  let finished = false;
  void handle.result().then(() => { finished = true; });
  await entered.promise;
  expect(finished).toBe(false);
  expect(release).not.toHaveBeenCalled();
  ack.resolve();
  expect((await handle.result()).status).toBe("completed");
  expect(release).toHaveBeenCalledOnce();
});
```

Completion: every Promise-returning extension path is awaited. This does not provide live-driver recovery.

## E2 — Incremental log high-water recovery

Files: `packages/core/src/session/incremental-session-manager.ts`, `session/__tests__/incremental-session.test.ts`, core README session guarantees.

Before append/forced snapshot, derive next sequence from metadata, snapshot watermark and highest valid loose key. Use existing readLoose exact numeric-suffix filtering and watermarked snapshot semantics. Representative private implementation:

```ts
private async readNextSequence(sessionId: string, metaNextSeq: number): Promise<number> {
  const snapshot = await this.readSnapshot(sessionId);
  const loose = await this.readLoose(sessionId);
  let nextSeq = Math.max(metaNextSeq, snapshot.nextSeq);
  for (const entry of loose) {
    const seq = Number(entry.key.slice(sessionId.length + 1));
    if (!Number.isSafeInteger(seq) || seq < 0 || seq === Number.MAX_SAFE_INTEGER) {
      throw new Error("Invalid incremental session sequence");
    }
    nextSeq = Math.max(nextSeq, seq + 1);
  }
  return nextSeq;
}
```

Validate metadata/snapshot watermark as safe nonnegative integers before arithmetic. getOrInitMeta uses recovery for both existing and missing metadata; orphan log records do not restart sequence at zero. Recompute appendsSinceSnapshot from uncollapsed loose records, excluding already-covered cleanup leftovers. Preserve Date hydration and legacy array snapshot reads. Scan cost is bounded by current loose entries under normal snapshot operation, not a distributed-log scalability guarantee.

Fault test: JSON-cloning fake store writes A to loose log, fails following meta write, then new manager appends B. Both A/B must survive. Cover each write of multi-message batch, missing meta, metadata behind snapshot, post-snapshot leftovers, unsafe integer/invalid watermark and colon-prefixed sibling isolation. Existing cleanup-failure snapshot test stays.

Independent-manager atomic append is explicitly deferred from this repair. Generic StorageDriver has no CAS/append capability. Document externally enforced one-writer ownership. A later optional session mutation port requires expected revision, stable caller message/operation IDs, duplicate payload checking, atomic append/state update and typed conflicts with a concrete tested adapter. Do not add generic transactions or claim log scanning solves F03 concurrency. Adapter choice/guarantees are a separate prerequisite rather than an implementation-ready hidden assumption.

## E3 — Loop admission and cancellation parity

Files: core `agent/llm-loop.ts`, `agent/agent.ts`, cap docs in `agent/types.ts`, existing controlled-loop tests and new `agent/__tests__/loop-boundary-parity.test.ts`.

maxToolRoundtrips counts complete admitted tool-request batches. Zero allows initial model answer but no effects; N permits N batches and existing final-answer opportunity. Controlled counter continues across revisions; standalone count resets on each invocation.

Proposed internal replacement:

```ts
private claimToolRoundtrip(local: { used: number }): void {
  const used = this.controlledExecution ? this.controlledToolRoundtrips : local.used;
  if (used >= this.maxToolRoundtrips) {
    throw new Error("Tool roundtrip budget exhausted; no further tools executed");
  }
  if (this.controlledExecution) this.controlledToolRoundtrips++;
  else local.used++;
}
```

run/stream each create a local counter and call shared claim after fully validating an assistant batch, before append/dispatch. Constructor validates safe nonnegative integer cap. No truthiness treatment of zero. Keep current inclusive model iteration; commentary-only responses retain existing iteration behavior, documented separately from effect count.

Check signal after awaited model accounting and before accepting/publication/dispatch, after each host hook, and before final Agent completion. Nonstream matches streaming checks around output guards/afterRun. Preserve `withRetry(..., options.signal)`, repaired backoff and controlled default retry zero. Late reported usage remains in accounting; no next request/effect after known abort. Existing persisted evidence is not rolled back.

Streaming checks signal before publishing the next accepted chunk/event, plus final post-stream guard; close iterators cooperatively. Noncooperative structural providers can still require host isolation to bound waiting. Preserve harness lease ownership.

Team coordinator parity is a minimal dependency: ordinary Team.generate currently omits the signal (team.ts:387), while controlled services already enforce it. Pass `{ signal: ctx.signal }` to existing meteredGenerateFor and check signal before Team run.complete. Do not redesign Team routing. A cancellation during delayed coordinator synthesis must not report complete or delegate another member; known usage remains recorded.

Tests: ordinary/controlled × run/stream × cap 0/1; zero no tool, one one batch plus final answer; invalid caps reject before requests. Provider aborts before late successful final response -> cancelled, never completed. Hook aborts after model and afterRun -> no new effect/call/completed event. Account late usage. Reuse current request-control/budget tests as regressions; do not rewrite providers.

## E4 — Terminal truth and partial output

Files: core `agent/types.ts`, `agent/llm-loop.ts`, `agent/agent.ts`; harness `drivers.ts`, result/event optional fields only if needed by final API. Keep status union: length/filter are stopped; incomplete protocol is error/failed.

Proposed additive metadata:

```ts
export interface RunOutput {
  // existing fields preserved
  providerFinishReason?: string;
  partial?: boolean;
  reason?: { code: string; message: string };
}
```

Final-answer construction retains text/usage, providerFinishReason, and stopped + stable provider_length/provider_content_filter reason where relevant. Only stop is ordinary model completion. Stream outcome carries same metadata and Agent aggregates it. Any no-finish stream, including text-only/empty, fails; unfinished tools never dispatch. Preserve already-published text as partial/error evidence. A proposed ModelProtocolError code incomplete_stream is useful only if exported consumers need it; root diagnostics plan should select a common result shape.

agentDriver output forwards status/reason/partial text. Add optional partial and providerFinishReason to the existing HarnessDriverOutput and HarnessResult interfaces; reuse the existing HarnessReason for reason. Forward them through drivers.ts output() and terminalResult in runtime/driver.ts. The Agent adapter forwards the new core reason as well. This is the selected shared metadata shape, with no parallel status taxonomy. No automatic extra model call after length: host-directed continuation must explicitly use remaining budget.

Tests: run/stream length/filter produce stopped with text/usage; missing finish fails text-only/empty; partial tool stream never dispatches; harness Agent adapter preserves stopped and reason. Compatibility: callers relying on truncated output as completed must check status; document correctness change.

## E5 — Workflow owned updates and cooperative stopping

Files: core `workflow/step-runner.ts`, `workflow/types.ts`, `workflow/__tests__/workflow.test.ts`, README; minimal harness integration fixture if adapter behavior changes.

Carry produced patch separately from working state. Function patch is returned Partial<TState>; Agent patch is named output; condition/serial accumulates patches in declaration order; parallel applies fulfilled branch PATCH rather than copied base. Do not derive writes by diffing final states (same-value intentional writes disappear under diff).

Proposed private outcome:

```ts
interface StepExecution<TState> {
  state: TState;
  patch: Partial<TState>;
  results: StepResult[];
}
```

Validate function patch as non-null non-array object, filter existing prototype-sensitive keys, apply to working state and accumulate owned writes. Existing public executeSteps return can remain state/results; internal helper handles patches.

Proposed additive configuration:

```ts
export interface ParallelStep<TState> {
  name: string;
  parallel: StepDef<TState>[];
  merge?: "declaration_order" | "error";
}
```

Default declaration_order preserves intentional last-declared same-key collision behavior while fixing untouched field overwrite. Strict error detects keys produced by different branches and throws a proposed `WorkflowMergeConflict` (stable code `workflow_merge_conflict`) from the join before mutating parent state, so executeSteps cannot dispatch downstream steps; namespaced branch outputs followed by serial merge suffice instead of a reducer API until demand proves need.

Strict merge conflicts use an exported `WorkflowMergeConflict extends Error`, code `workflow_merge_conflict`, with `stepName` and bounded `conflictingKeys: readonly string[]`. They are structural fatal errors, not ordinary retriable step failures. At every serial/condition/parallel parent, detect and rethrow this class after already-started siblings settle. Never downgrade it through `allSettled` or `withRetry`. A strict failed join applies none of that join's sibling patches to its parent; earlier serial state/checkpoints remain evidence, and sibling external effects remain applied. Do not save a success checkpoint or dispatch downstream work. Include a nested-strict-group regression, not only a top-level join test.

Branches currently receive shallow copies. Document returned patches and branch-owned objects; do not promise deep immutability or unconditionally structuredClone arbitrary unknown state (clients/functions may exist). Nested direct mutation remains a compatibility limitation; isolated serializable-state mode is deferred. Do not claim patch merge solves shared nested references. Add a negative fixture documenting that boundary.

### Explicit failure policy and child output mapping

Proposed additive public fields, preserving the existing StepResult status union:

```ts
// Add to existing WorkflowConfig<TState>.
failurePolicy?: "continue" | "stop"; // default continue

// Add optional fields to existing StepResult.
output?: { text: string; status: RunOutput["status"]; reason?: RunOutput["reason"] };

// Add optional fields to existing WorkflowResult<TState> during additive rollout.
status?: "completed" | "failed";
reason?: { code: "workflow_step_failed"; message: string };
```

These are interface additions, not standalone statements. Import RunOutput with `import type` in workflow/types.ts. The implementation always sets aggregate status on new outputs; optional declaration fields preserve structural third-party producers. No error step can produce aggregate completed, even when continue runs later steps. Skipped condition branches alone do not fail a run.

`executeAgentStep` checks cancellation after `agent.run`. A missing status on a legacy structural output remains completed for compatibility; native Agent always sets it. Completed output produces the existing named output patch and done result. Error/stopped output produces no state patch and an error StepResult containing partial text/status/reason. Do not retry a resolved stopped output as a provider exception. Under continue, subsequent steps see the unchanged field; partial text is evidence in stepResults, never masquerades as `${step.name}_output`. Under stop, skip remaining serial steps with `status: "skipped"` and do not start later groups. Already-started parallel siblings settle; successful branch patches may join under declaration_order, while the aggregate remains failed. A condition inherits this policy for its selected branch. Child cancelled output throws exported `WorkflowCancellationError` (code `workflow_cancelled`); it escapes ordinary retry/continue. Parent signal cancellation throws its existing abort reason. Workflow catches only to emit run.error, then rethrows. No late patch/checkpoint/run.complete follows cancellation.

Update harness `workflowDriver` to use aggregate status, with the existing error-step fallback for older Workflow-like outputs. Map WorkflowCancellationError to cancelled; ordinary errors/strict merge conflicts map to failed. The adapter preserves failed partial state/step-results as evidence when a result exists. Cancellation does not undo successful siblings' effects.

Representative aggregation control flow (new helpers are explicitly private StepRunner methods):

```ts
const outcomes = await Promise.allSettled(
  step.parallel.map((branch) => this.executeStepWithPatch(branch, { ...state }, ctx)),
);
ctx.signal?.throwIfAborted();
for (const outcome of outcomes) {
  if (outcome.status === "rejected" &&
      (outcome.reason instanceof WorkflowMergeConflict ||
       outcome.reason instanceof WorkflowCancellationError)) throw outcome.reason;
}
// Collect ordinary errors first. Strict conflict detection runs before any
// parent mutation; declaration-order joins apply only fulfilled owned patches.
const joined = this.joinBranchPatches(step, state, outcomes);
// Serial callers inspect error results and skip remaining work under stop.
return joined;
```

`executeStepWithPatch` replaces the existing private step dispatcher, retaining Agent/function/condition/parallel variants. `joinBranchPatches` iterates fulfilled patches in declaration order, rejects duplicate own keys for strict mode, then applies the accepted patch once. Results flatten in declaration order, regardless of settlement timing. All parents propagate structural fatal outcomes; ordinary child errors stay recorded.

Keep ordinary collect-errors behavior; existing tests intentionally continue. Cancellation must escape it: check after function/Agent await before applying patch, after allSettled before merge and before final workflow run.complete. Replace StepRunner plain timeout backoff using existing abortable helper with timer cleared in finally. Do not use generic withRetry defaults or retry controlled dispatchEffect errors (currently first failure is collected without retry deliberately).

Tests: initialized disjoint a/b patches survive both completion orders; nested serial/condition patches survive; collision default follows declaration order and strict rejects with no downstream call; failed sibling follows documented partial merge. Cancel during function prevents late patch, during backoff prevents attempt two, after final step prevents complete. Controlled effect invoked once. Representative proposed test using the real existing Workflow class:

```ts
it("keeps independent writes when the input already contains both keys", async () => {
  const workflow = new Workflow({
    name: "disjoint", register: false,
    initialState: { a: 0, b: 0 },
    steps: [{ name: "join", parallel: [
      { name: "a", run: async () => ({ a: 1 }) },
      { name: "b", run: async () => ({ b: 2 }) },
    ] }],
  });
  expect((await workflow.run()).state).toEqual({ a: 1, b: 2 });
});
```

## E6 — Definition-bound checkpoint continuation

Files: core `workflow/workflow.ts`, `workflow/checkpoints.ts`, `workflow/types.ts`, checkpoint tests, exports as needed, README. Harness driver remains durable:false.

Inspection has no effects. Continuation runs remaining steps afresh and may repeat every later effect; fork also changes starting state. Exact playback consumes recorded model/tool outcomes without calls; current replay is continuation, not playback.

First repair cursor: executeStepwise receives absolute fromStepIndex and iterates original config.steps; never slice then persist zero-based indices. New IDs combine new runId + absolute padded step index. Start cumulative stepResults from checkpoint results; keep parent checkpoint/run lineage separate from new run identity.

Proposed fields:

```ts
export interface WorkflowConfig<TState extends Record<string, unknown>> {
  // existing fields
  definitionVersion?: string;
  validateCheckpointState?: (value: unknown) => TState;
}
export interface WorkflowCheckpoint<TState> {
  // existing fields
  formatVersion?: 2;
  definitionVersion?: string;
  stepNames?: string[];
  parentCheckpointId?: string;
  parentRunId?: string;
}
export type WorkflowContinuationOptions = RunOpts;
```

Zod validates external checkpoint envelope; validateCheckpointState recovers state without asserting unknown as TState. Construction requires definitionVersion and validateCheckpointState together when either is supplied. With both configured, runWithCheckpoints emits v2; without both it preserves legacy envelopes for inspection/legacy wrappers. New validated method requires version + validator; match workflowName/version/ordered top-level names/index before effects. Callable code changes require host version bump; names cannot detect closure changes.

Proposed method:

```ts
async continueFromCheckpoint(
  checkpointId: string,
  opts?: WorkflowContinuationOptions,
): Promise<WorkflowResult<TState> & { runId: string }>;
```

Widen runWithCheckpoints opts to RunOpts & initialState, preserving old session/user calls and common RunContext/accounting construction. Forward tenant/signal/runMode/executionServices/metadata and only child-supported key/dependency fields after inspecting actual forwarding. New caller identity/policy authoritative; never serialize credentials/signals/services. Checkpoint write failure stops next step and rejects; completed effect remains applied.

Deprecate replay terminology; keep compatibility wrapper, validating new checkpoints strictly and documenting the legacy path. New strict continuation rejects unversioned records before effects with `checkpoint_incompatible`. Existing `replay` and `fork` receive absolute-cursor correction, workflow-name validation and deprecation, but retain their legacy acceptance through the current major. Document that legacy validation cannot establish original definition identity. An eventual major may route them exclusively through strict continuation and reject legacy records; do not ship that breaking rejection silently in a patch. Offer offline host migration with explicit original index/version/state validation. Strict continuation never infers identity or permits a blanket legacy bypass. Fork keeps existing mutation argument and adds optional opts afterward; same validation and absolute cursor. Run restored state through the host validator, then structuredClone the validated value before mutations/dispatch on the strict method; reject noncloneable state before effects. Legacy methods retain documented existing state compatibility until the major migration. Clone checkpoint state and cumulative results on save as well, so in-memory store aliasing cannot change an older checkpoint. Hosts selecting JSON-persisted stores must validate JSON-compatible state; callable/client dependencies stay in RunOpts, outside checkpoint state. Document this serialization boundary and do not shallow-mutate stored nested references. Existing unversioned runWithCheckpoints remains useful for inspection; safe continuation requires version/validator and newly emitted v2 checkpoint.

Top-level condition/parallel step remains one checkpoint boundary. No mid-step resume, approval restoration, inherited active reservations, exactly-once effects, or active harness recovery. Those require operation intent/receipt ledger, reconciliation, backend/code compatibility and adapter atomicity. Current README references Plan 004 but no Plan 004 exists under plans: replace dangling reference with scoped contract + explicit deferred durable design.

Tests: 1/10/100 repeated continuation ends 111 not 121, new B/C checkpoints use 1/2; prior results/parent retained; wrong workflow/version/order/index/state/malformed data rejected before calls; tenant/signal/policy/accounting propagated; failed save stops next step; fork does not mutate original state; strict legacy rejection, retained legacy-wrapper behavior, and explicit migration fixture. Cursor fix and validation can be sequential commits, but new method is not exposed until both land.

### Proposed checkpoint regression using public classes

```ts
it("keeps an absolute cursor when continuing a continuation", async () => {
  const storage = new InMemoryStorage();
  const checkpointStore = new StorageBackedCheckpointStore<{ total: number }>(storage);
  const config: WorkflowConfig<{ total: number }> = {
    name: "absolute-cursor", register: false, definitionVersion: "1",
    validateCheckpointState: (value) => z.object({ total: z.number() }).strict().parse(value),
    initialState: { total: 0 }, checkpointStore,
    steps: [1, 10, 100].map((delta, index) => ({
      name: `add-${index}`, run: async (state) => ({ total: state.total + delta }),
    })),
  };
  const workflow = new Workflow(config);
  const first = await workflow.runWithCheckpoints();
  const firstCheckpoints = await checkpointStore.listForRun(first.runId);
  const afterA = firstCheckpoints.find((item) => item.stepIndex === 0);
  if (!afterA) throw new Error("Missing first checkpoint");
  const second = await workflow.continueFromCheckpoint(afterA.id);
  const secondCheckpoints = await checkpointStore.listForRun(second.runId);
  const afterB = secondCheckpoints.find((item) => item.stepIndex === 1);
  if (!afterB) throw new Error("Missing continued checkpoint");
  const third = await workflow.continueFromCheckpoint(afterB.id);
  expect(third.state.total).toBe(111);
  expect(secondCheckpoints.map((item) => item.stepIndex)).toEqual([1, 2]);
});
```

Import existing classes/types from source .js paths in checkpoint tests and Zod. `continueFromCheckpoint`, definition metadata and output status are proposed; store constructor/listForRun are existing. Checkpoint save failures can occur after an applied effect: assert no next step, expose the error, and never auto-retry the whole Workflow.

- [ ] Pin async lease acknowledgement, unknown commit and release timing first.
- [ ] Repair session high-water and cap/cancellation/finish parity, preserving historical host-control regressions.
- [ ] Pin disjoint and nested patch joins; map partial child outputs; implement ordinary failure policy and structural fatal propagation together.
- [ ] Repair absolute checkpoint cursors; add strict versioned continuation with validator, context forwarding, lineage and cloned snapshots.
- [ ] Keep legacy wrapper behavior explicit, publish migration/deprecation guidance, then update Team guidance and real fixtures.
- [ ] Run focused tests/declarations; review changed public statuses and packed consumers before combining milestones.

## E7 — Narrow Team handoff rather than restore obsolete protocol

Files: core `team/types.ts`, `team/__tests__/team.test.ts`, README/docs; only directly dependent CLI/doc recipes outside primary scope.

Add @deprecated to Handoff enum member and stop promoting it as a native Team recipe. Preserve enum/path through current major; no patch removal. Document shared memory/storage settings do not reconfigure borrowed Agents (currently consumed neither memory nor storage). Do not restore throwing transfers before siblings settle.

Use real native Agent+tool fixture to expose obsolete mock guarantee; supported replacement fixture verifies direct Agent handoff OUTSIDE harness via AgentConfig.handoff targets. INSIDE controlled execution direct Agent handoff remains rejected (`agent.ts:161`); use host-owned custom routing or tested Team route/broadcast/coordinate recipes. No implicit claim of policy-covered remote members or durable delegation.

Reimplementing Team handoff is deferred until a shared transfer outcome and one lifecycle owner are justified. Deprecation/docs improve honesty without extending orchestration.

## Sequence and future verification

1. Async persistence acknowledgement first; enables reliable future archive/summary persistence.
2. Log high-water repair; root tuple codec work precedes it if key layout changes. Document one owner.
3. Loop cap/cancellation parity, then terminal reasons with review of corrected statuses.
4. Workflow produced patches/cancellation independently after shared contracts settled.
5. Absolute checkpoint cursor, then validation/version/context/new named continuation; migration docs land together.
6. Team deprecation/guidance/integration evidence; no general rewrite.

Discovered commands, proposed gates (not run here):

```sh
npx vitest run packages/harness/src/runtime/__tests__/execution-drivers.test.ts packages/harness/src/runtime/__tests__/resident-history.test.ts
npx vitest run packages/core/src/session/__tests__/incremental-session.test.ts packages/core/src/session/__tests__/session-manager.test.ts
npx vitest run packages/core/src/agent/__tests__/controlled-loop.test.ts packages/core/src/agent/__tests__/loop-boundary-parity.test.ts packages/core/src/agent/__tests__/execution-boundaries.test.ts packages/core/src/models/__tests__/request-controls.test.ts packages/harness/src/runtime/__tests__/budget-reservations.test.ts
npx vitest run packages/core/src/workflow/__tests__/workflow.test.ts packages/core/src/workflow/__tests__/checkpoints.test.ts packages/core/src/team/__tests__/team.test.ts
npx tsc -p packages/core/tsconfig.build.json --noEmit --pretty false
npx tsc -p packages/harness/tsconfig.build.json --noEmit --pretty false
npm run build
npm run test:package
npx vitest run
git diff --check
```

Exact focused Biome commands should list changed files, for example `npx biome check packages/core/src/agent/llm-loop.ts packages/core/src/agent/agent.ts packages/core/src/agent/types.ts packages/core/src/workflow/step-runner.ts packages/core/src/workflow/workflow.ts packages/core/src/workflow/checkpoints.ts packages/core/src/workflow/types.ts packages/core/src/session/incremental-session-manager.ts packages/core/src/team/types.ts packages/harness/src/runtime/session-bindings.ts packages/harness/src/runtime/driver.ts packages/harness/src/drivers.ts`; omit paths not changed and add changed test files. Do not format unrelated source. Build precedes package-consumer checks. Existing package-consumption suites cover ESM/CJS declarations/imports; extend only for changed exported contracts. Fault tests use deterministic deferred promises/fake providers/storage. No paid/live external gate needed for local repairs; a concrete remote store gate is needed before advertising distributed durability.

Only dependent work outside core/harness is documentation and actual compile consumers. No queue/transport redesign required. Root evaluation milestone separately justifies structural runner integration.

Explicit deferrals/prerequisites: distributed atomic session mutation with concrete adapter; deep isolated Workflow state codec; recorded zero-effect playback; operation-ledger active recovery/exactly-once/reconciliation; policy coverage for remote Team members. Result remains composable local execution with acknowledged persistence and safe validated continuation, not a durable job engine.
