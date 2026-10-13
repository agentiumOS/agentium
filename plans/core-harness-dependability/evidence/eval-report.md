# M6b/M6c implementation evidence

Implemented in `/Users/xerycks/.codex/worktrees/core-harness-dependability/agentium`, based on commit `531013327a0f7136b4eb8446ff1b302bf6f9ca51` plus the shared dirty implementation state. No commits, dependency installation, live/paid providers, external applications, or original-checkout source edits were performed. Parent owns barrels and all shared runtime/core changes; this report describes the eval worker's owned files only.

## M6b behavior

- `EvalTarget` is structural: `run(MessageContent, RunOpts?) -> Promise<RunOutput>`. Existing `agent` config properties, ordinary Agent compatibility, wrappers and conversation runners remain supported. The existing object-keyed weak-map session reservation continues until the actual underlying target callback settles, including ignored cancellation.
- Legacy valid score results normalize to `graded`. Valid zero/false is a task failure. Invalid/thrown scorer results and malformed model judge payloads become `infrastructure_error`; case grading is incomplete, overall pass stays false, and timeout/cancellation classifications remain intact.
- `CaseLifecycle` captures the generated output at actual target settlement, before its post-operation deadline check. Judge timeout/cancellation preserves that output and never restarts generation.
- Legacy totals/average remain available. New complete-grade denominator, infrastructure-case count, and valid-grade mean separate execution coverage from grading coverage. An empty valid-grade denominator reports null.
- `createHarnessEvalTarget` exists only in the existing optional testing subpath. No core/harness eval import or dependency was added. Target capture preserves class ability/policy receivers, fixed verified identity, declarative grants/budgets, explicit-session history, and per-run observer isolation.
- Only sessionId/signal/runMode and identical userId/tenantId are accepted RunOpts. Specified unsupported options fail before provider work. Failed native status maps to error; legacy awaiting_input maps to stopped. Original status/reason/budget and cleanup diagnostics are weak-map observations on the returned output object. TTFT stays absent.
- Tool traces contain bounded IDs/names/errors/denials with source bodies omitted. Count/byte overflow, observation errors, failed/cancelled status conservatively mark partial coverage. A partial prefix cannot establish forbidden-effect absence. Runtime-owned session resources close after settlement; borrowed pools and existing Agent instances remain host-owned.

The parent/continuity runtime owners supplied the cancellation-safe settlement hook. Regression evidence exposed a core guard preceding settlement observation, then a second whole-batch problem: both concurrent effects applied but only one settlement reached the observer after cancellation. Parent added a neutral batch observation port and continuity owner implemented runtime observation/dedup. The adapter now records both effects once while preserving cancelled/partial status and one model invocation.

## M6c fixture and interpretation

`context-memory-eval.v1.json` pins corpus revision (now context-memory-v1.1), source ID/revision/location, valid alternative evidence groups and model-visible sufficiency clauses, fake task/summary model snapshots, scorer version, generation settings, common execution/context bounds, and twelve scenarios. Labels are outside agent-visible input and source data. The recorded task provider receives an object without the gold fields.

The acceptance runner uses real HarnessRuntime, Agent driver, context projection, bounded host RecallStore, canonical archiving, incrementalTaskSummaryPolicy, session storage, aggregate admission, and completion verification. It has no live network dependencies. The twelve scenarios cover correction/supersession; archived early requirement; two source sessions; retrieved-but-omitted prompt evidence; stale answer with correct gold context; uncertainty; environment conflict; tenant/project collision-shaped IDs; deadline/cancellation/partial retrieval; malicious source instructions; incomplete trace; and successful execution settlement with exitCode1 rejected by completion.

Metrics are measured at distinct boundaries:

- Discovery hit@5 uses returned candidate references. Any sufficient evidence hit differs from all-required-group coverage; equivalent current sources satisfy the same group.
- Read coverage uses complete query evidence from actual RecallResult, excluding incomplete spans and separate canonical-summary reads.
- Assembled coverage inspects actual model request references. Canonical archive references resolve through captured, host-validated message records only to identify the labelled source locations. Content credit requires the actual prompt wrapper text to retain every pinned sufficiency clause for that source. Summary reference retention, summary content coverage, and full-source prompt coverage are separate fields; absent archive bodies are never rehydrated as model-visible evidence. Complete retained historical source messages are measured independently. No retrieval metric searches a final answer for citations.
- Final correctness, source support, stale use, conflict answer, appropriate insufficient-evidence abstention, and unnecessary answerable-case abstention are separate deterministic checks. Merely having references does not make a stale npm answer supported.
- Logical calls, prompt/completion/total tokens, unknown usage, source/discovery bytes, measured backend retrieval duration, total continuity duration, total task duration, and prompt evidence tokens are retained separately. Canonical preparation read bytes/time and actual summary provider calls/tokens/time are explicit. Cold and amortized preparation cost are equal in these one-task cold fixtures; no warm-cache saving is claimed.

A paired two-session task runs full history, incremental summary with query recall disabled, and incremental summary plus bounded query recall from identical host-scoped source data/task sequence. It holds task snapshot, generation settings, grants, budgets and context ceiling constant. Observed cold model counts are 1/2/2 and summary preparation calls 0/1/1; all retain both evidence groups in the prompt and produce the correct deterministic output. Full history exceeding the common context ceiling fails before task provider dispatch and is recorded as an infeasible baseline.

These fixtures verify exact runtime/measurement contracts, not stochastic model quality, prompt-injection resistance of a real model, or statistical equivalence. The versioned pilot envelope is proposed only: 24 scenarios × 3 conditions × 3 repeats, 216 task runs, concurrency2, declared task/judge limits, severe invariant blocking, one bounded follow-up then inconclusive for noisy quality shifts. It is marked not authorized/not run. Actual evaluation spend: zero provider calls billed; all provider responses are local recorded fixtures. No pricing or live quality claim is made.

## Red evidence and scope

- Initial eval target/integrity selection: 49 passed / 3 failed. Missing grade coverage, lost completed output after judge timeout, and malformed JSON judge incorrectly classified were the three intended red failures.
- Initial adapter selection: 19 failures, all from the missing createHarnessEvalTarget API. Once implemented, remaining semantic failures were corrected test fixture assumptions (denial is the existing string union; policy method is decide), and the cancellation settlement regression remained red until core/runtime integration.
- Parallel-effect regression: both effects applied and one model call ran, but observed tools contained only first_effect. It passed after the shared batch port/dedup correction.
- M6c added red checks for absent archival-summary preparation and summary-only correctness; these passed after actual summary preparation/three-condition execution. Source-support red caught a stale answer being treated as supported solely due to references. Partial-span red caught incomplete query evidence counted as sufficient. Any-hit red caught conflating a single valid required-group hit with complete multi-group coverage.
- Existing behavior/extra adapter edge checks that passed on first execution are characterization coverage, not claimed red evidence. No shared implementation was reverted to manufacture red states.

## Executed verification

Before the final two metric-specific tests, the following file selection completed with 7 files / 151 tests passing:

```sh
npx vitest run packages/eval/src/__tests__/target-contract.test.ts packages/eval/src/__tests__/result-integrity.test.ts packages/eval/src/__tests__/eval.test.ts packages/eval/src/__tests__/reliability-eval.test.ts packages/eval/src/conversational/__tests__/trajectory-scorer.test.ts packages/harness/src/__tests__/eval-target.test.ts packages/harness/src/__tests__/context-memory-acceptance.test.ts
```

After the metric-specific additions, adapter + memory acceptance completed with 2 files / 51 tests passing (30 adapter, 21 acceptance). Final combined rerun is recorded below after completion.

Additional completed checks: eval build tsconfig noEmit; harness build tsconfig noEmit; eval full source/test tsconfig noEmit; changed-owned-file Biome check (17 files, clean); git diff --check clean. A broader harness source/test check was run and revealed peer-owned test typing issues; after peer fixes, its last remaining diagnostic was continuity-runtime.test.ts133 readonly capabilities assignment, communicated to that owner. This is not an eval/harness build diagnostic. Parent runs final fresh builds/packed consumers and broader repository gates; this worker does not claim those from source-only tests.

Final combined run at 2026-10-13 06:52 UTC: **7 files / 153 tests passed** (all eval source tests in that selection, 30 adapter and 21 memory acceptance). Eval build noEmit, harness build noEmit, and eval full source/test noEmit completed with no diagnostics on that source state. Changed-owned-file Biome and diff checks remain the required final formatting checks after any subsequent review edits.

Final follow-up at 06:52 UTC: harness full source/test tsconfig also completed **with no diagnostics** after the peer-owned fixture correction. Biome check over the 17 owned source/test files completed clean with no fixes; git diff --check completed clean.


## Final review correction: lossy summary and streaming settlement

The independent reviewer identified an M6c false positive after the initial handoff: prompt metrics resolved valid summary evidence references back to original archived source text, so a summary that omitted a requirement could still receive assembled/source-support credit. Reproduction used the actual summary-only condition with a valid-ID draft containing only “Unrelated update retained.” Both new tests failed with assembled coverage1 even though the deployment requirement was absent from the actual task prompt. This was a measurement defect; runtime summary validation correctly established only reference/range integrity.

The correction parses actual prompt wrapper text and checks versioned gold sufficiency clauses plus exact ID/revision/locator. The scorer version is now `source-group-and-visible-content-v2`. Retained-reference coverage, summary-reference coverage, summary-content coverage, full-source prompt coverage, and combined assembled coverage are distinct. Summary reference IDs never recover text absent from the prompt. A third regression retains only the superseded npm statement with valid current evidence IDs: reference coverage1, summary/full-source/assembled content coverage0, stale-use1, unsupported/incorrect answer.

The summary-only paired condition now explicitly omits full archived excerpt bodies, preserving only summary/status projection; the earlier condition included canonical archive additions alongside the summary and therefore was not a sufficiently isolated summary-only comparison. Current paired evidence establishes summary-content coverage1 and full-source prompt coverage0 for that condition. The prompt-allocation source fixture was reduced to 80 repeated context sentences and revised to r2/corpus v1.1 so complete canonical preparation + complete query reading fit the fixed 2048 evidence-token ceiling while the full source still exceeds the 400-token prompt allocation. This preserves the intended retrieved-but-not-assembled contract without widening budgets.

The two-parallel-applied-effect adapter regression is now parameterized over actual Agent.run and Agent.stream through agentDriver. Each path applies two effects, invokes the provider once, observes both IDs once, and returns cancelled/partial. The ordinary path's prior red evidence is retained; the streaming extension passed initially on the already-fixed shared implementation and is integration coverage, not a manufactured red claim.

Post-correction check at 06:56 UTC: adapter + memory acceptance **55 tests passed** (31 adapter,24 acceptance), harness full source/test TypeScript check passed. Final combined verification follows below.

Final post-correction combined run at 2026-10-13 06:57 UTC: **7 files / 157 tests passed**, including 31 adapter and 24 memory acceptance tests. Both harness and eval build tsconfig noEmit checks and both full source/test tsconfig noEmit checks completed without diagnostics. Biome checks on testing.ts and both owned harness test files completed clean; git diff --check completed clean. Eval source files were unchanged since their preceding clean owned-file Biome check. Independent final review remains open pending the reviewer's verdict; workspace-wide/package-consumption checks remain parent-owned.

Independent final review subsequently closed the lossy-summary finding after inspecting the corrected source projection and metrics. The reviewer reported **16 files / 222 tests passed**, both harness and eval full source/test TypeScript checks clean, both run/stream two-effect cancellation verified, and no remaining actionable M1–M6 findings. The independent evidence is recorded in continuity-eval-review.md and core-review.md beside this report. This worker's own verification remains the 157-test selection above; broader workspace/package-consumption gates remain parent-owned.
