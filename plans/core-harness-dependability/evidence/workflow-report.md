# M4 Workflow integrity implementation report

Status: Implemented in the assigned worktree, within owned Workflow paths and Team types/handoff fixtures. No subagents, commits, installs, publication, paid providers or live effects. Parent integration (barrel exports/harness adapter and root documentation) remains separate.

## Changed files

- `packages/core/src/workflow/step-runner.ts`: produced-patch execution, nested patch accumulation, declaration-order/strict joins, failure policy, child-output mapping, abort guards/backoff and no controlled-effect retry. Public executeSteps still returns state/results; patches stay private. Preserves the existing trusted host generic state cast inside dispatchEffect so approved callback arguments continue to drive function execution.
- `packages/core/src/workflow/types.ts`: ParallelStep.merge; WorkflowConfig.failurePolicy, definitionVersion, validateCheckpointState; optional-declared WorkflowResult.status/reason; StepResult.output; WorkflowContinuationOptions = RunOpts.
- `packages/core/src/workflow/errors.ts` (new): WorkflowMergeConflict (`workflow_merge_conflict`, stepName, frozen/bounded conflictingKeys up to 100); WorkflowCancellationError (`workflow_cancelled`, stepName); WorkflowCheckpointError (`checkpoint_incompatible`, cause).
- `packages/core/src/workflow/workflow.ts`: common context/lifecycle/accounting handling, honest aggregate status, absolute checkpoint iteration, cumulative results and lineage, strict v2 continuation, context forwarding, envelope validation and cloned state/results. Deprecated legacy replay/fork wrappers retain acceptance through the current major and gain cursor repair/name validation and opts.
- `packages/core/src/workflow/checkpoints.ts`: additive v2 definition metadata and parent lineage fields; corrected continuation terminology.
- `packages/core/src/workflow/README.md` (new): scoped state ownership, failure/cancellation semantics, strict continuation and explicit host migration, JSON/clone boundaries and durability deferrals.
- `packages/core/src/workflow/__tests__/integrity.test.ts` (new): 19 behavioral tests covering initialized disjoint patches in both settlement orders, same-value writes, nested strict propagation/sibling settlement, partial output, continue/stop, successful sibling merge, cancellation/backoff/controlled effects, invalid patches, shallow-reference limitation, Agent patch composition, checkpoint evidence and condition stop.
- `packages/core/src/workflow/__tests__/continuation.test.ts` (new): 20 behavioral tests covering repeated continuation, definition/cursor/state/envelope validation, legacy acceptance/migration, reference-store snapshot isolation, fresh caller identity/policy/child key/dependencies, accounting context, noncloneable strict state, callable legacy state, and persistence/cancellation boundaries.
- `packages/core/src/workflow/__tests__/workflow.test.ts`: existing parallel-error expectation now asserts error group/failed aggregate while successful sibling state survives.
- `packages/core/src/team/types.ts`: @deprecated TeamMode.Handoff guidance; honest memory/storage configuration comments without changing Team ownership.
- `packages/core/src/team/__tests__/team.test.ts`: replaced obsolete thrown-HandoffSignal mock guarantees with real Agent/model/native-tool fixtures: unconfigured native transfer fails instead of Team routing; direct configured Agent handoff succeeds outside host services; configured member handoff remains Agent-owned; controlled direct handoff rejects before model dispatch.

## Behavioral contract and rulings

Every branch carries produced writes separately from its working snapshot; merge never infers writes by diffing state. Conditions/serial execution accumulate produced writes. Default parallel ordering is declaration order, independent of settlement timing; intentional writes of an unchanged value remain owned writes. Strict conflict detection happens before parent mutation, and structural conflict/cancellation rethrows through every parent only after started parallel siblings settle. A failed strict join cannot produce a checkpoint or downstream call. Earlier checkpoints/external effects remain evidence.

Ordinary failures are collected by default, but never produce aggregate completed. Stop policy skips later serial entries, including unstarted groups; already-started parallel siblings settle and successful patches may join. Error/stopped child text/status/reason stays in StepResult.output with no named state patch. A legacy child with missing status remains completed. Cancelled children throw WorkflowCancellationError; parent signal preserves its existing abort reason. Checks after function/Agent awaits, joins, checkpoint waits and final accounting prevent known cancellation becoming completion. Backoff uses the existing abortable helper with timer cleanup. Controlled dispatchEffect rejections are never automatically retried by Workflow.

Construction requires definitionVersion/validator together. v2 records bind workflow name/version/ordered top-level names/absolute index and step name; Zod validates the external envelope, then the host validator recovers state. Strict restored state is structured-cloned before dispatch/fork mutations. Saved state/results are cloned; continuation starts from prior results and writes absolute indices with parent checkpoint/run lineage. Caller identity/mode/signal/metadata/services/policy apply to the fresh context; supported child apiKey/dependencies/questions are forwarded but not checkpointed. No blanket legacy bypass exists in strict continuation.

Compatibility ruling: do not require a strict definition version/validator or matching historical step name for unversioned replay/fork. Those wrappers validate workflow name and bounded cursor, keep legacy acceptance through this major, and write corrected absolute indices going forward. Historical restarted cursors cannot prove original identity; explicit offline migration must establish the original absolute index/version/state. v2 records are strict even through legacy wrappers. Generic legacy checkpoints may contain callables/opaque clients in custom non-JSON stores; ordinary containers are recursively copied, retaining references only for noncloneable opaque dependencies. Applying structuredClone rejection to every legacy wrapper/save would introduce the prohibited patch-level compatibility break. Strict v2 rejects noncloneable restored state. JSON-backed stores still require host JSON-compatible state validation.

Shallow branch snapshots are a documented compatibility limitation: direct nested mutations can affect siblings/input. A negative fixture deliberately proves it. No deep isolation, recorded playback, mid-step recovery, exactly-once effects, restored approvals/reservations or durable harness execution is claimed.

## Red/green evidence

All commands ran from `/Users/xerycks/.codex/worktrees/core-harness-dependability/agentium` on 2026-10-13 with existing dependencies/Vitest 4.1.11.

1. RED: `npx vitest run packages/core/src/workflow/__tests__/integrity.test.ts` — exit 1, 13 failed / 2 passed (15 initial tests). Representative output: disjoint merge received `{ a: 0, b: 2 }` instead of `{ a: 1, b: 2 }`; nested strict join resolved and dispatched next; partial/cancelled child resolved as successful named output; late function abort resolved completed; fake-timer backoff cancellation stayed pending until the 15s test timeout. Aggregate status was absent. These failures exercised the intended baseline defects, not import/setup errors.
2. RED: `npx vitest run packages/core/src/workflow/__tests__/continuation.test.ts` — exit 1, 13 failed / 2 passed (15 initial tests). Output: `workflow.continueFromCheckpoint is not a function`; version-only/validator-only construction did not throw. Baseline clone fixtures using JSON storage were characterization passes; final clone tests use a reference-retaining custom store so snapshot isolation is actually tested.
3. Initial GREEN: same two new test files — exit 0, 30 tests passed / 2 files.
4. Existing focused regression initially found the intended compatibility correction: parallel group previously asserted `done` despite a failed child; changed expectation to error/failed aggregate plus preserved success state per agreed requirements.
5. Final GREEN: `npx vitest run packages/core/src/workflow/__tests__ packages/core/src/team/__tests__/team.test.ts` — exit 0, 83 tests passed / 5 files (06:35:54, 432ms).
6. `npx tsc -p packages/core/tsconfig.build.json --noEmit --pretty false` — exit 0, no diagnostics (final source declaration check).
7. `npx biome check packages/core/src/workflow packages/core/src/team/types.ts packages/core/src/team/__tests__/team.test.ts` — exit 0, 11 files checked, no fixes applied.
8. `git diff --check -- packages/core/src/workflow packages/core/src/team/types.ts packages/core/src/team/__tests__/team.test.ts` — exit 0, no whitespace findings.

Broader checks / limits:

- Expanded native journey regression command added `packages/core/src/handoff/__tests__/agent-handoff.test.ts` and `streaming-handoff.test.ts` to the focused suite: 123 passed / 1 failed / 7 files at 06:34:49. Failure is outside M4 paths: streaming-handoff.test.ts:490, target cancellation transcript expected tool IDs `[transfer, target-work]`, received `[transfer]`. Reported to parent for M1 investigation; not modified here. The focused M4/Team suite passes.
- `npx tsc -p packages/core/tsconfig.json --noEmit --pretty false` final exit 2 only on unowned tests: Team cancellation fixture model return widening and missing mode at lines 18/39/48, and pre-existing vector embedding mock tuple/undefined errors at lines 482–705. No Workflow/owned Team fixture diagnostics remain. Source declaration check passes; this does not establish the entire test-type matrix green.
- Whole-worktree `git diff --check` found a concurrent unowned `packages/core/src/agent/types.ts:355` trailing blank line; owned paths pass. Reported to parent, not changed here.
- Full monorepo build/package consumption/default suite left to parent integration. No provider/network gate needed for these local regressions.

## Parent integration requirements

Export from core root:

- WorkflowMergeConflict, WorkflowCancellationError, WorkflowCheckpointError from `./workflow/errors.js`.
- WorkflowContinuationOptions from `./workflow/types.js`.
- Existing WorkflowConfig/WorkflowResult/StepResult/ParallelStep/WorkflowCheckpoint exports already carry additive fields.

Update harness workflowDriver mapping: prefer result.status completed/failed; retain old error-step fallback for structural legacy Workflow outputs; forward workflow_step_failed reason; preserve failed partial state and stepResults when a result exists. Thrown WorkflowCancellationError/code workflow_cancelled maps to cancelled (even without a parent AbortSignal); strict merge conflicts map to failed. The core Workflow emits run.complete with output.status error for an ordinary aggregate failure, and throws/emits run.error for structural/cancellation outcomes. Adapter remains durable:false.

Root README/documentation owned by parent should reference workflow/README.md, remove dangling Plan 004 claims, describe continuation as fresh effects rather than recorded replay, and replace native Team Handoff recipes with direct Agent handoff outside controlled execution or host-owned routing / tested Team route/broadcast/coordinate within it. Team memory/storage config does not configure borrowed members. Do not claim policy-covered remote members/durable delegation. Team ownership was not redesigned.
