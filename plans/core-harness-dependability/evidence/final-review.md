# Final whole-branch review — core/harness dependability

## Reviewed inputs and disposition

Fresh independent read-only review in `/Users/xerycks/.codex/worktrees/core-harness-dependability/agentium`, branch `agent/core-harness-dependability`, against supplied-worktree baseline `531013327a0f7136b4eb8446ff1b302bf6f9ca51`. Preexisting host-control implementation is baseline. Reviewed tracked changes and relevant untracked source/tests, including the final eval fixture corrections that postdate `final-working-review.patch`. Read the master/design and companion plans, progress ledger, implementation reports and previous task reviews. Applied code-review, TypeScript and verification-before-completion guidance. No implementation, dependency installation, dist mutation, commits, live services or additional agents were performed by this reviewer.

**Final disposition: approved within the selected M1–M7 scope; no actionable review findings remain.** The initial direct-loop cancellation and package/documentation completeness findings below were corrected and received scoped re-review. The separate cancellation wording error was also corrected. Final correction evidence and verification limits appear below; parent integration owns the final combined build/test/package gates.

## Standards and correctness

### P2 — Recheck cancellation after yielding public events and before the raw stream chunk — closed

Location at review: `packages/core/src/agent/llm-loop.ts:872–874`, `LLMLoop.stream`.

When `publicMessageEvents` is true, the loop yields a public event and pauses in caller code. A caller may abort while consuming the last `message.delta` event for a chunk. On resume, the loop reaches the raw `yield chunk` without another cancellation guard, so text is published after cancellation is known. The same boundary exists between a yielded `message.completed` event and its raw finish chunk. `Agent.stream` has an outer guard that masks this for its users, but `LLMLoop` is a supported root export.

Confirmed with an inline source TypeScript probe using a deterministic provider and the public `LLMLoop`, `RunContext` and `EventBus`: first yielded `public_message/message.started`, then `public_message/message.delta`; caller aborted; the next iterator result was `{"value":{"type":"text","text":"answer"},"done":false}` while `signal.aborted` was true. No provider/network or source changes were used.

Requirement: E3 explicitly requires a signal check before publishing the next accepted chunk/event. Correction: check cancellation immediately before raw publication after any public-event yield, retain cancellation/failure observations and already observed usage, and pin both text and finish boundaries in direct-loop tests. Confidence: high.

### Corrected during review — Describe ordinary Agent cancellation accurately

The initial `packages/harness/DEPENDABILITY.md:36` statement that ordinary cancellation rejects was too broad. An admitted `Agent.run` catches cancellation and returns `status: "cancelled"`; pre-admission/early checks and streaming can reject. The guide's sample already checks non-completed statuses. Parent corrected the prose after this finding; source behavior did not need a change. This was documentation accuracy, not a newly introduced runtime behavior defect.

## Specification and packaging

### P2 — Ship or use portable links for the newly advertised guides — closed

Locations at review: `packages/harness/README.md:7`, `packages/core/README.md:47–49`, with allowlists at `packages/harness/package.json:50` and `packages/core/package.json:81`.

The new harness README links local `DEPENDABILITY.md`, but the harness package's `files` allowlist includes only `dist` and `CONVERSATIONAL-RUNS.md`. The core README links `src/storage/README.md` and `src/workflow/README.md`, but the core package only includes `dist`. Those guides therefore are not shipped beside the automatically included README. Cross-package relative links such as core's `../harness/DEPENDABILITY.md` also assume a monorepo checkout (the ordinary core-only journey deliberately lacks harness). Installed package readers cannot reach the new lifecycle/migration/continuation contracts through those links.

Requirement: M7 calls for complete supported journeys and packed-consumer/documentation coherence. Correction: include the intended package-local guides in package allowlists, and use verified portable hosted links where documents cross package boundaries or point at repository-only fixtures. Add focused packed-content assertions so the documentation links are checked along with code exports. Confidence: high from the actual package allowlists and README targets; the parent's fresh package gate owns final tarball evidence.

## Coverage and rationale

- Traced ordinary Agent and exported loop run/stream paths through tool-batch admission, terminal metadata, partial protocol errors, reflection, handoff, cache reuse, cancellation accounting, operation admission and close/drain ownership.
- Inspected incremental session high-water recovery, namespace isolation/explicit tuple-v1 encoding, borrowed wrapper closure, tracked summary/extraction writes, source-role memory assembly and truthful manual write outcomes. Retained documented one-writer, cooperative waiting and explicit migration limits.
- Inspected Workflow owned-patch joins, declaration-order/strict conflict behavior, nested fatal propagation, ordinary continue/stop semantics, cancelled child mapping, absolute continuation cursors, v2 identity validation, state/result cloning and forwarded caller options. No new defect found; documented shallow nested state and fresh-effect continuation limits remain intentional.
- Traced harness acknowledgement attempt/settlement/release ordering and no implicit retry after uncertain commit, cancellation-safe batch settlement observation, current-evidence completion decisions and bounded decision references.
- Traced continuity scope attestation, bounded discovery/reads, canonical complete-group reads, exact per-conversation summary frontiers, shared clarification budgets, whole-source prompt assembly, second omission decisions, fresh post-summary/pre-submit/current-terminal revision checks and cleanup. Host adapter conformance and the remaining cross-store publication race remain explicit limits.
- Reviewed final eval changes: the structural target keeps host authority fixed, isolates observations, bounds metadata-only traces and closes owned resources; active explicit sessions remain reserved through actual settlement; completed output survives grading timeout/failure; valid zero grades are distinct from missing infrastructure grades; complete-grade denominators exclude incomplete cases.
- Independently inspected the repaired acceptance metric. It now requires exact reference identity and actual model-visible sufficient content, reports retained references separately from summary/full-source content, and omits raw archive excerpts from the summary-only condition. The known lossy-summary finding is not duplicated. Added lossy and superseded-content regressions match that correction.
- Inspected root exports, optional testing/eval dependency boundaries, supported guides and packed-consumer fixtures. Parent owns fresh workspace builds, full default tests, declaration/packed-consumer gates and documentation snippet compilation; those outcomes are not inferred from source review.

## Evidence limits

The direct-loop cancellation probe above is fresh reproduced evidence. Fresh reviewer command `npx --no-install vitest run packages/harness/src/__tests__/context-memory-acceptance.test.ts packages/harness/src/__tests__/eval-target.test.ts --reporter=dot` completed with exit 0: **2 files / 55 tests passed**, local start 07:04:15. This independently verifies the final lossy-summary/superseded-content metric cases and run/stream settlement observations. Reviewer `git diff --check` also completed with exit 0 before the final corrective wave. Other findings are based on current source and package metadata inspection. This review does not establish live provider quality, backend conformance, distributed ownership/recovery, deletion migration, physical interruption/rollback or release readiness. No paid/live gate was run. Parent final integration records exact-state combined verification.

## Correction verification

Scoped re-review after `final_fixes` declared source stable:

- **Direct-loop publication: closed.** Current `llm-loop.ts:874` checks cancellation immediately before raw chunk publication. The two direct-loop regressions exercise suspension at the last public delta and last completed event, including failure observation and preservation of already settled usage. Repeated the original public source probe independently: after abort, the remaining event was only `message.failed`, followed by `RunCancelledError`; no raw text leaked.
- **Published guides: closed.** Core's allowlist now includes the two exact storage/workflow README paths; harness includes `DEPENDABILITY.md`. Same-package links stay local, while optional sibling-package and repository-only fixture links use explicit repository URLs. Reviewed installed-package guide assertions and the worker's completed `final-package-green.log` (**2 passed / 1 deliberately filtered skip**) plus `final-pack-dryrun.log` (both core guides and harness guide included). Hosted target checks prove paths against the local source tree; they do not assert that unmerged new files already exist on remote main. Final freshly rebuilt package behavior remains the parent's gate.
- **Cancellation prose: closed.** The guide now distinguishes admitted `Agent.run` cancelled output from early/pre-admission and streaming rejection.
- **Existing cost lifecycle fixtures: accepted.** Their earlier close-waits expectations contradicted the approved M3 busy-close behavior. The updated tests assert `AGENT_BUSY` without closing the owned tracker, allow provider/hook work to finish, verify totals `0.072` and `0.144`, then close exactly once. No production-close rollback or weakening occurred.

Fresh reviewer command: `npx --no-install vitest run packages/core/src/agent/__tests__/publication-cancellation.test.ts packages/core/src/cost/__tests__/agent-cost-dx.test.ts packages/core/src/agent/__tests__/agent-close.test.ts --reporter=dot` — **exit 0, 3 files / 28 tests passed**, local start 07:06:25. Fresh reviewer `git diff --check` completed without whitespace diagnostics after the corrective wave. No full suite, build, install or dist mutation was duplicated by this reviewer. No new defect was found in the accepted corrections.
