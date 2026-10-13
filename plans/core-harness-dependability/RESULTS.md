# Core and harness dependability implementation results

The approved M1–M7 implementation retains core's model/tool loop and harness's host-controlled execution boundary. Recall, incremental task summaries, completion verification and evaluation remain optional. No provider, database, replacement loop or persistent learning service was added.

**Status:** M0–M7 complete and independently approved. Final combined build, tests, type checks, guide compilation and packed-consumer gates passed. Checked source commit: `be98a75699f3651e4992dbcb9b6b29acaa513a8b`; source manifest SHA-256: `e868adfb4e03bebc9645299944bc400df044f8e5e5404a71e62e21e0d855e082`. The follow-up documentation commit only completes plan status and retains evidence.

## Scope and preservation

The user approved parallel execution with “start parallely and get these done”, after the analysis-only plan. Implementation runs in the attached managed worktree `/Users/xerycks/.codex/worktrees/core-harness-dependability/agentium`, branch `agent/core-harness-dependability`.

The original checkout is `/Users/xerycks/Xhip/agentium`, initially on `main` at `c5f9b5249d299f5d2d39b74c87b83f0da7c15570`, with supplied host-control work and unrelated deletions. A snapshot of that complete supplied state was committed as `531013327a0f7136b4eb8446ff1b302bf6f9ca51` before this task's source changes. That is the implementation/review baseline. Earlier manifest checks of 790 original paths, including absent-file sentinels, found no differences. The latest timestamped audit snapshot observed 9 of those captured paths changed since the baseline. Their separate file copies and distinct native-continuation/input-recovery additions were preserved, without reset or import. This task worked in the isolated checkout. Integration must reconcile the newer original state; [the audit](evidence/original-preservation.json) records exact paths and hashes and does not certify the concurrent implementation.

Only `@agentium/eval` needs functional changes outside core/harness: its runner must accept the real harness as a structural target and distinguish failed grading from task results. Other workspace packages are build/consumer regression gates. Persistent key migration, backend deployment, live quality tests, publication and distributed recovery remain outside this execution.

## Implemented behavior

| Milestone | Result |
| --- | --- |
| M0 — Baseline | Preserved all supplied changes, isolated implementation and recorded the actual baseline. |
| M1 — Execution integrity | Awaited session commit/release, retained unknown-write evidence without retry, recovered incremental log high-water, aligned tool-batch caps, propagated cancellation and kept provider/reflection/handoff/cache outcomes truthful. |
| M2 — Storage identity | Separate in-memory namespace maps, explicit tuple-v1 scope/Redis keys, literal prefixes and borrowed-wrapper ownership. Legacy persistent defaults and explicit migration remain. |
| M3 — Memory lifecycle | Tracked summary/extraction/final-write work, truthful drain results, busy/closing/closed admission, retryable acknowledged teardown, labelled source memory with full wrapper budgeting and `rememberWithResult`. |
| M4 — Workflows | Joined only produced patches, optional strict fatal conflicts, explicit ordinary failure policy, cancelled child propagation and version-bound absolute checkpoint continuation with caller context. |
| M5 — Context continuity | Bounded scoped recall, canonical complete-group summary frontiers, provenance and uncertainty, task-call admission, current-view checks, legacy scope attestation and owned-session cleanup. |
| M6 — Completion/evaluation | Current-evidence verifier, bounded validated decisions, cancellation-safe whole-batch observations, structural EvalTarget, optional testing adapter, honest grading denominators and actual-runtime memory acceptance. |
| M7 — Adoption/consumption | Three usage paths, ownership/outcome/migration guides, packed core-only/core+harness/optional-eval execution and ESM/CommonJS plus TypeScript declarations. All four final packed checks passed. |

The [usage guide](../../packages/harness/DEPENDABILITY.md), [storage migration guide](../../packages/core/src/storage/README.md) and [workflow contract](../../packages/core/src/workflow/README.md) describe public behavior and operational limits.

## Review corrections

Independent task reviews reproduced and closed lost reflection/handoff terminal metadata, reuse of incomplete cache records, empty terminal tool batches, doubled direct-stream usage, cache-observer cancellation publication, omitted settlements from a cancelled parallel batch, and late-acquired recall-session cleanup. Evidence measurement was corrected so valid summary citations cannot restore omitted archive text or receive full prompt-content credit. The summary-only condition excludes raw archive excerpts.

The fresh whole-branch review found a remaining direct-loop publication guard after a yielded public event, and missing package-local guides in the package allowlists. One final repair wave closed both findings and made new links portable. Two existing accounting tests now assert the approved `AGENT_BUSY` contract, preserve late costs `0.072` / `0.144`, and close the owned tracker once after settlement. The independent scoped re-review approved the corrections and reported no actionable M1–M7 findings. [Final review](evidence/final-review.md), [repair evidence](evidence/final-fixes-report.md).

## Verification

Final gates ran after the repaired core was rebuilt, using Node `v22.23.1`, npm `10.9.8` and Vitest `4.1.11`. All 96 committed implementation files match the verified source manifest. [Commands and exit codes](evidence/gates.json), [source hashes](evidence/final-source-state.json).

| Check | Observed final result | Evidence |
| --- | --- | --- |
| `npm run build` | Exit 0; all workspace packages built | [Build log](evidence/final-workspace-build.log) |
| `npx --no-install vitest run --maxWorkers=4` | Exit 0; 247 files / 2,739 tests passed; 10 files / 29 tests gated skips | [Full-suite log](evidence/final-full-tests.log) |
| `npm run test:package` | Exit 0; 2 files / 4 packed tests passed | [Consumer log](evidence/final-packed-consumers.log) |
| `npx --no-install tsc -p packages/{core,harness,eval}/tsconfig.json --noEmit --pretty false` (each package separately) | Exit 0 for all three full source/test checks, no diagnostics | [Gate record](evidence/gates.json) |
| Three exact current guide TypeScript fences, strict NodeNext against fresh declarations | Exit 0, no diagnostics | [Gate record](evidence/gates.json) |
| Biome on changed supported source paths; `git diff --check` | Exit 0; 89 files checked with configured exclusions, no formatting fixes or whitespace errors | [Gate record](evidence/gates.json) |
| Independent task and final review | No remaining actionable findings; final reviewer independently passed 55 acceptance/adapter and 28 lifecycle/publication tests | [Final verdict](evidence/final-review.md) |

The default suite deliberately gates optional Redis/MongoDB/Postgres integration, installed sandbox/LiveKit/OTel SDK fixtures, a downloaded transformer model, and packed consumption. The four package checks among those 29 skips ran separately and passed; the remaining 25 optional environment/backend gates were not enabled. No live-model quality pilot ran.

Packed consumers execute core-only, core+harness and optional eval journeys plus the CLI entry point. They use actual ESM/CommonJS exports, `.ts`/`.cts` declarations, runtime behavior and installed guide paths, without optional provider/database SDKs. Temporary fixture installs were offline with lifecycle scripts disabled.

The first combined run exposed a worktree-only missing CLI `commander` link, then two stale close-waits accounting expectations. Existing installed dependencies were linked without dependency/lockfile changes; the lifecycle fixtures were corrected without weakening production close. The final build and tests above followed those corrections. Standard clean-install CI remains a separate environment check.

## Decisions and deviations from the planning baseline

| Decision | Reason | Consequence if the choice is unsuitable |
| --- | --- | --- |
| Parallel independent slices with one shared-runtime owner | The user requested parallel execution; disjoint ownership protects shared contracts. | Coordination/review rework; no claim of safe concurrent editing to the same file. |
| Managed worktree plus a supplied-state snapshot | Preserve prior implementation and user deletions without editing main. | Integration must account for the snapshot baseline. |
| Reuse existing dependencies and build fresh dist | Avoid changing dependency state solely for setup; packed consumers need actual outputs. | Host-specific installed dependencies still need a normal clean CI install. |
| Execute after the later user approval | Proposed/analysis-only banners record the planning stage. | Earlier deferred production work stays deferred. |
| Parent integration of barrels/shared runtime, followed by independent review | Keep one owner for cross-slice contracts and verify the combined behavior. | Incorrect integration is exposed by shared tests and review. |
| Mark owned components disposed only after acknowledgement | Retain the first cleanup error and allow retry without reopening admission. | A non-idempotent host close needs its own receipt/reconciliation contract. |
| Finish source reads/discovery before a potentially slow summary call; use fresh validation windows later | A slow model should not expire unchanged source evidence already read within bounds. | Current-view checks remain separate fences, not atomic publication. |
| Add an optional batch settlement observation port and exact-object dedup | Observe every applied batch member before cancellation/control checks can stop processing. | Custom services retain the old method and must opt into batch observations for this guarantee. |
| Require `canonicalArchiveReads: true` only for summary-enabled recall | Generic bounded document reads cannot establish canonical archive seeking. | Host capability attestation must be truthful; constructor checks cannot certify a backend. |
| Stop allocation-stage clarification, retain bounded retrieval-stage clarification | More input cannot repair an unchanged prompt ceiling; explicit uncertainty continuation remains possible. | Hosts needing dynamic prompt reallocation must provide a different policy contract. |
| Preserve final original-checkout drift without reset/import | Concurrent native-continuation/input-recovery additions belong to the original checkout; isolation retains the verified baseline. | Integration must reconcile newer work; the audit records hashes if that classification is wrong. |

Minimal test mock annotations were also corrected for TypeScript verification, including existing embedding RequestInit/Headers inspections. Production embedding behavior was unchanged. The existing accounting tests are adapted to the deliberately stronger close admission rule. [The complete chronological ledger](evidence/decision-ledger.md) retains all eleven rulings and their context.

## Evidence limits and deferred work

The versioned memory corpus runs twelve scenarios through the actual harness with local recorded task/summary providers. It separately measures discovered/read evidence, model-visible prompt content, answer support/correctness, stale use, abstention, scope and preparation/resource cost. Full history, incremental summary and summary-plus-recall share task settings and resource ceilings. These deterministic contracts do not establish a live model quality improvement, statistical equivalence, prompt-injection resistance or a preferred memory backend.

Adapters remain responsible for authorization, bounded physical I/O, cooperative cancellation, revision truth, retention and atomic conditional publication when required. Validation fences do not close cross-store revocation/publication races. Cancelled callbacks can already have applied remote effects. Snapshots and checkpoints do not provide mid-step recovery, approval restoration or exactly-once effects. Unknown usage stays unknown. The optional paid pilot and live backend conformance gates were not run.
