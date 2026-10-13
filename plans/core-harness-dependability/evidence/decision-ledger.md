# SDD ledger — plan: plans/core-harness-dependability/2026-10-13-core-harness-dependability.md

User authorized implementation in parallel on 2026-10-13: "start parallely and get these done". Prior analysis-only scope is superseded for planned implementation. No publication, live model spend, destructive migration or deferred architecture is authorized.

Workspace: /Users/xerycks/.codex/worktrees/core-harness-dependability/agentium
Branch: agent/core-harness-dependability
Baseline: local supplied-worktree snapshot commit, before task implementation. Original checkout manifest: /tmp/agentium-dependability-original-manifest.json. Preserve original checkout and unrelated changes.

Ruling: Parallel independent implementation overrides the SDD skill's serial dispatch guideline — user explicitly requested parallel work; disjoint file ownership and one shared-runtime integration owner prevent conflicts.
Ruling: Use native isolated worktree with copied supplied changes — preserve previous host-control implementation and unrelated deletions; never implement on main or reset original checkout.
Ruling: Use existing dependencies with local workspace-package links — no install/lifecycle run just to set up. Build fresh dist for actual consumer checks.
Ruling: Plans' "proposed / analysis-only" banners describe their creation time — current user authorization permits execution. Keep listed production-host gates and deferred features deferred.
Ruling: Parent owns all root exports, shared harness runtime/events/session-bindings/controllers and final documentation. Workers do not edit barrels or commit shared files.

## Preflight consistency and ownership

| Tasks | Producer / consumer or internal consistency | Finding / resolution |
|---|---|---|
| M1 core | RunOutput.reason/partial/providerFinishReason consumed by Workflow and harness adapters | Freeze shape in execution brief; worker owns core Agent/loop initially. |
| M2 storage / M3 memory | Memory stores consume unchanged StorageDriver; v1 physical keys explicit | Coherent; separate folders, no default key migration. |
| M1 core / M3 Agent close | Both touch agent.ts | Serialize Agent lifecycle changes after execution worker hands off. Memory worker owns MemoryManager only initially. |
| M1 harness / M5 / M6 | All touch runtime/driver.ts, types/exports | Parent integrates in sequence; worker modules handed over without runtime edits. |
| M4 / M1 | Workflow reads RunOutput status/reason, Team types separate from Team signal | Noncompleted outputs map to error evidence/no patch; typed shape agreed. |
| M5 / M6 | Recall references, diagnostics used by context and eval | Concrete types first, default scope unchanged; no automatic persistent facts. |
| M5 internal | Source-cycle deadline vs later validation | Fresh bounded validation windows and terminal authorized session; no reuse of expired cycle. |
| M6 internal | Collector after cancellation vs evidence completeness | New cancellation-safe observational callback; conservative partial cancelled/failed traces. |
| M7 / all | Public export/declaration/docs consumption | Parent verifies packed fixtures after fresh build; baseline-only consumers retained. |

## Task status

M0: complete — supplied baseline snapshot 531013327a0f7136b4eb8446ff1b302bf6f9ca51 preserved in the isolated checkout.
M1: complete — execution, acknowledgement, high-water, cap, cancellation and terminal contracts implemented; independent review corrections closed.
M2: complete — collision-free namespace/tuple-v1 contracts, explicit legacy migration and borrowed storage behavior verified.
M3: complete — tracked MemoryManager work, bounded drain, honest source context and Agent admission/close lifecycle verified.
M4: complete — owned-patch joins, fatal conflicts/cancellation, failure policy and versioned absolute continuation independently reviewed.
M5: complete — bounded scoped recall, incremental canonical summaries, runtime scope/validation/cleanup, factories and fixtures verified. Phase 2 facts remain deferred.
M6a: complete — bounded current-evidence completion decisions and cancellation-safe full-batch observations verified.
M6b/c: complete — structural EvalTarget, grading integrity, optional adapter and twelve-case actual-runtime memory corpus; lossy-summary metric correction closed.
M7: complete — three supported guides, published guide inclusion, declarations and core-only/core+harness/optional-eval packed consumers verified.

Final whole-branch review: approved after one corrective wave and scoped independent re-review; no actionable findings remain in M1–M7.
Final source commit: be98a75699f3651e4992dbcb9b6b29acaa513a8b.
Final combined gates: all workspace builds; 247 test files / 2739 tests passed (10 files / 29 tests gated skips); four separately enabled packed checks; core/harness/eval full types; three current guide examples; changed-file Biome and whitespace checks passed.
Original-checkout audit: the latest timestamped 790-path snapshot found 9 files changed since baseline. The separate copies and different native-continuation/input-recovery changes were preserved, not copied into this verified branch. No task command or agent edited the original checkout.

Ruling: close marks owned components disposed only after acknowledgement; retained first teardown failure and bounded secondary cleanup codes permit explicit retry while run admission remains blocked.
Ruling: After source reads/discovery, summary work may outlive the source-cycle deadline; later current-view checks receive fresh bounded validation windows. This preserves one bounded source cycle without discarding unchanged evidence after a slow model.
Ruling: Optional ExecutionServices.observeToolSettlements records all already-settled batch members before control checks; exact-object dedup prevents duplicate observations through existing observeTool calls.
Ruling: RecallStore.capabilities.canonicalArchiveReads is additive and required only for taskSummary; four-capability recall-only adapters remain supported. Constructor cannot infer archive seeking from generic boundedReads.
Ruling: Retrieval-stage await_input is bounded in the same held task-call slot. Allocation-stage await_input stops as recall_assembly_omitted because prompt capacity cannot change through another question; an explicit continue keeps uncertainty visible. Both decisions receive strict schema validation.
Verification companion: existing harness/core test fixtures had widened vi.fn signatures. Minimal annotations and standard RequestInit/Headers inspection repaired test TypeScript compilation without changing production embedding behavior. Full core/harness source+test checks now pass.

Ruling: Preserve the observed concurrent original-checkout changes rather than resetting or importing them into the verified worktree. Separate inodes and distinct native-continuation/input-recovery additions show worktree isolation; integrating the completed branch must reconcile the newer original state. If that classification is wrong, the audit still records the exact differing paths and hashes for investigation.
