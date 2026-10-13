# Independent M5/M6 continuity and evaluation review

Read-only source review against baseline `531013327a0f7136b4eb8446ff1b302bf6f9ca51`, including untracked implementation/fixture files, in the managed `core-harness-dependability` worktree. The parent expanded the original M1–M4 review to these integrated changes. Original code-review, TypeScript, agent-memory-design and agent-evals skills were read. The master/design, context-continuity and completion/evaluation plans were reviewed. No source edits, installs, paid/network provider calls, commits, or additional agents were used. Only this ignored report and the core review report were written.

## Standards and correctness findings

### P2 — Acquired recall session lost at the deadline acceptance boundary (repaired)

In `packages/harness/src/runtime/recall.ts`, `openRecallCycle` previously assigned `session = opened` only after `withinWindow` accepted the asynchronous result. A backend can successfully acquire a session and return it after the deadline (or concurrently with cancellation). The operation callback still sees `openAbandoned === false`, then the window's post-result check rejects. The caller never registers the acquired session, and `cycle.close()` cannot release it.

Reviewer public source probe with a five-millisecond deadline acquired a session and synchronously returned just after its deadline. Before correction: `{ opened: 1, closed: 0, status: "failed" }`, even after closing the cycle. This is a resource-ownership implementation defect against the selected bounded-recall lifecycle, not a request to force backend cancellation.

Owner added deadline and caller-abort race regressions. Reviewer independently ran them while red: **2 intended failures / 129 passes** across the selected ten-file integration group at 06:55:20 local time. Both failures were `closed: 0` when `closed: 1` was required. The correction registers ownership inside the acquisition callback before acceptance and closes an owned acquired session in the catch before rethrowing caller cancellation. The preexisting late unresolved-open cleanup remains covered.

Reviewer repeated the same public probe after correction: `{ opened: 1, closed: 1, status: "failed" }`. Fresh bounded-recall group: **17 tests passed**, 06:55:56 local time. Finding closed.

### P2 — Assembled evidence metrics rehydrate archive text omitted from summaries (repaired)

In `packages/harness/src/__tests__/context-memory-acceptance.test.ts`, `promptReferences(..., true)` accepted summary citation mappings, then the assembled-coverage labeler and `promptEvidence` fetched the original archive body for those mappings. Original archive text is not necessarily present in the summary sent to the model. A lossy summary retaining a valid evidence ID but replacing its text with unrelated content therefore earned assembled evidence coverage and source support for a requirement that the model never saw.

Sent the concrete summary-only scenario to the eval owner: retain the deployment-approval archive reference but omit the approval text from `draft.text`; references may remain present, while assembled sufficient-content coverage must be zero. The owner independently reproduced two intended red tests. The same check exposed that the earlier summary-only condition still sent full canonical archive excerpts alongside the summary, which undermined the intended comparison.

The correction inspects the actual source/summary wrapper text, requires fixture-pinned sufficient content plus matching validated references, distinguishes retained references from sufficient summary/full-source content, and removes raw canonical archive excerpts from the summary-only projection. Archive bodies now map citation locations to labels only; they are not reconstructed as model-visible prompt content. Runtime summary behavior did not need to change for this measurement repair.

Reviewer inspected the new projection, `promptEvidenceParts`, exact-revision/location labeling, clause-based support calculation, and three lossy/stale-summary regressions. The deployment fixture now records retained-reference coverage 1, summary-reference coverage 1, summary-content coverage 0, full-source-prompt coverage 0, assembled coverage 0, and either an uncertain answer or an unsupported forced approval answer. A valid-reference summary retaining only the superseded npm decision also has zero sufficient-content coverage. The paired summary-only condition explicitly asserts full-source-prompt coverage 0. All passed in the final reviewer integration selection. Finding closed.

## Specification assessment

No independent specification defect requiring a product decision was found. The two findings are implementation/lifecycle and evaluation-measurement defects against existing selected requirements.

Reviewed scope and revision handling: exact host scope attestation and legacy import, per-conversation canonical coverage, immutable archive ranges, complete group reads, source revision validation after summary work and before task submission, fresh terminal validation, invalid-summary removal without losing canonical history, resource cleanup, bounded clarification, source-role wrappers, whole-excerpt omission with a second host decision, and normal task-call admission before summary preparation.

Reviewed completion/adapter/grading: pass/fail/unknown verifier mapping, shared bounded decision validation, last completion decision as an observation independent of final status, tool outcomes distinct from business success, cancelled settlement observation, fixed eval identity and supported RunOpts, bounded metadata-only tool traces, per-run observer isolation, explicit-session ownership until actual settlement, generated output retained through grading timeout, valid zero grades distinct from infrastructure errors, and complete-grade denominators. No additional actionable defect was found in these inspected paths.

## Evidence and limits

- Fresh six-file core + adapter + acceptance regression selection: **84 passed** at 06:52:54 local time, before the two expanded-review findings were corrected.
- Fresh ten-file continuity/completion/eval integrity selection: **129 passed, 2 intended acquisition-race failures** at 06:55:20 local time. This was concurrent red evidence, not a final green claim.
- Fresh bounded-recall correction verification: **17 passed** plus the repeated public source probe at 06:55:56 local time.
- Read implementation reports' red/green evidence where available; missing-API failures establish API absence, not every behavioral contract. Tests that passed initially are characterization evidence. Broader exact-state/package verification remains with the parent.
- Sources and tests continued changing during review. Final review will record subsequent corrected groups. No full monorepo, packed consumer, live-backend, model-quality, or publication-readiness claim follows from these local tests.
- Host adapters remain responsible for genuinely bounded backend I/O and current scope/revision attestations. Cooperative cancellation is not physical interruption or rollback. Advisory task token floors are not atomic future-task reservations. Ordinary session snapshots are not durable active-run recovery. Conditional host publication is required to eliminate the final revocation/commit race. Deterministic recorded-provider acceptance establishes contracts and measurement behavior, not statistical model quality or live prompt-injection resistance.

## Final verdict and verification, 2026-10-13 01:28:54 UTC

**No remaining actionable standards/correctness or specification findings in the reviewed M1–M6 scope.** Both expanded-review findings above and all prior core findings have been repaired and verified. The ten-file red run independently witnessed the acquisition regressions; eval owner supplied the intended lossy-summary reds, whose corrected source and final behavior were independently reviewed. No spec/product decision remains from this review.

Fresh reviewer final selection:

```sh
npx --no-install vitest run \
  packages/core/src/agent/__tests__/cache-outcomes.test.ts \
  packages/core/src/agent/__tests__/protocol-terminals.test.ts \
  packages/core/src/agent/__tests__/reflection-outcomes.test.ts \
  packages/core/src/handoff/__tests__/streaming-handoff.test.ts \
  packages/harness/src/runtime/__tests__/bounded-recall.test.ts \
  packages/harness/src/runtime/__tests__/task-summary.test.ts \
  packages/harness/src/runtime/__tests__/continuity-context.test.ts \
  packages/harness/src/runtime/__tests__/continuity-runtime.test.ts \
  packages/harness/src/runtime/__tests__/completion-verification.test.ts \
  packages/harness/src/runtime/__tests__/session-acknowledgement.test.ts \
  packages/harness/src/__tests__/policies.test.ts \
  packages/harness/src/__tests__/driver-outcomes.test.ts \
  packages/harness/src/__tests__/eval-target.test.ts \
  packages/harness/src/__tests__/context-memory-acceptance.test.ts \
  packages/eval/src/__tests__/target-contract.test.ts \
  packages/eval/src/__tests__/result-integrity.test.ts --reporter=dot
```

**16 files / 222 tests passed**, 06:58:14 local time. This includes both real Agent.run and Agent.stream two-applied-effect cancellation cases, exact-once settlement observations, scope/lineage/terminal-freshness cases, strict second assembly decisions, concurrent summary record slots, and the corrected summary-only measurements.

Additional fresh reviewer checks: core/harness/eval build tsconfigs with `--noEmit --pretty false` all exit 0; final harness and eval full source/test tsconfigs both exit 0; scoped `git diff --check` exits 0. No installation was needed. The final tracked core/harness/eval source diff SHA-256 was `8f79869f192a29f9306aca3f9ed342ff9c4251e5cbd36bf32caafa745064a890`; this excludes untracked files and is an observation marker, not a committed release revision. New source/fixture files were included in inspection and test selection.

Read the completed continuity/eval reports and the new DEPENDABILITY/storage documentation. Documentation states the relevant lifecycle, storage migration, source-trust, callback, scope, token-floor, conditional-publication and live-quality limits. The parent's fresh full build/packed consumer/whole-repository gate remains separate; this review does not claim it or release readiness. The evidence metric is a deterministic fixture clause matcher, not a general semantic judge.
