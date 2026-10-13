# Independent M1–M4 core review

Reviewed 2026-10-13, from baseline `531013327a0f7136b4eb8446ff1b302bf6f9ca51`, including the relevant new test/source files. This baseline contains the supplied preexisting work. Read-only source review; only this ignored report was written. Parent Agent integration continued during review. The tracked core diff hash at 01:12:13 UTC was `f7e5232dfbe87abe652c859b68b395383c16dacd4744c3ecf663c1854bdfeb4f`; this hash excludes untracked files and is an observation marker, not a release revision.

Read the original code-review and TypeScript skills, the design/master plans, execution/workflows and storage/memory companion plans, and all three implementation reports. Reviewed core Agent/loop/errors/types, incremental session, cost guard, storage/tenant codecs, memory lifecycle/context, Workflow/checkpoints, Team signal/deprecation, relevant fixtures and direct consumers. Harness runtime/recall is excluded as requested; no live adapters, paid providers, installation, commits, source edits or subagents were used.

## Standards and correctness findings

### P1 — Cache hits bypass the new terminal and cancellation contract

Locations in the inspected state: `packages/core/src/agent/agent.ts:737–778` and `:1250–1263`; the final semantic-cache store blocks also admit stopped outputs.

A normal run ending with `finishReason: "length"` now correctly returns `status: "stopped"`, `partial: true`, and `reason.code: "provider_length"`, but that result is still cached. A second identical request takes the cache path, which overwrites `status` with `completed`. The stream cache path emits a synthetic `stop` finish. Both hit paths bypass the cancellation guards in the main execution path. A pre-aborted request can consequently return completed or publish cached text and a successful finish. Delayed lookup/output guard aborts have the same missing boundary.

Confirmed with a real Agent and SemanticCache, using local in-memory vector/embedding doubles and no private-state mutation. Observed output:

```json
{"first":{"status":"stopped","reason":"provider_length"},"cached":{"status":"completed","reason":"provider_length"},"preaborted":{"status":"completed","reason":"provider_length"},"stream":["text","stop"]}
```

Correction: admit only completed answers to the cache and reject existing incomplete hits (or preserve their full terminal semantics). Apply cancellation checks before lookup, after awaited lookup/accounting/guardrail work, and before each cached publication/return. Keep ordinary run cancellation behavior consistent rather than moving the cache ahead of it. Add public run/stream cache-hit regressions, including a delayed or pre-aborted hit.

Confidence: high. The cache branches predate this diff, but the new stopped results now enter them, and the selected M1 contract expressly requires cancellation and terminal truth across ordinary Agent paths.

### P2 — Native handoff drops the new target outcome metadata

Locations: `packages/core/src/handoff/handoff-manager.ts:139–148` and `packages/core/src/agent/agent.ts:1445–1468` in the inspected state.

Nonstream HandoffManager constructs a subset of the last target output and omits `reason`, `partial`, and `providerFinishReason`. The streaming manager spreads the target output, but Agent subsequently copies only a stopped status into `streamOutcome`, from which it builds the source terminal result. A length/filter target therefore preserves `stopped` while losing the explanation and partial-output marker at the public source Agent boundary.

Confirmed with real source/target Agents and native transfer control in a local streaming probe. Target terminal output contained `stopped`, `provider_length`, `partial: true`, and finish `length`; source terminal output contained only `status: "stopped"`. The nonstream loss follows the explicit return shape above.

Correction: forward the complete selected terminal metadata through both handoff adoption paths; keep aggregate usage and source/target lifecycle identity separate. Add native run/stream handoff fixtures whose target ends with length/filter.

Confidence: high. This is an integration gap for new RunOutput fields, not a request to redesign the deprecated Team handoff protocol.

### P2 — An empty tool-call finish is still ordinary completion

Locations: `packages/core/src/agent/llm-loop.ts:502–505,519–540` and `:909–940`.

The tool protocol checks run only when at least one call is present. A structural provider returning `finishReason: "tool_calls"` with no calls takes the final-answer branch; `terminalMetadata` adds no stopped/error status, and Agent reports completed. The stream path has the same behavior when a tool finish arrives without accumulated tool fragments. This turns an incomplete provider turn into successful completion.

Confirmed public Agent probe: `{ "text": "not final", "status": "completed", "providerFinishReason": "tool_calls" }`.

Correction: require a nonempty validated tool batch for `tool_calls`; otherwise fail as a protocol error while preserving observed text/usage and preventing dispatch. Cover both generate and stream, with/without configured tools. Reject unsupported stream finish strings as appropriate to the same terminal contract.

Confidence: high. The branch is inherited, but E4 explicitly selects “Only stop is ordinary model completion”; this is a remaining implementation gap in that selected requirement.

## Finding repaired during review

### Reflection revision metadata was discarded

Originally `packages/core/src/agent/agent.ts` replaced the initial answer text/usage with a revision but did not adopt revision status/reason/partial/provider finish metadata, and it invoked another critic even after a stopped revision. A local probe produced `text: "truncated revision", status: "completed", providerFinishReason: "stop"` after a length revision.

Reported immediately to the parent. The parent added length/filter regressions, reported two intended reds, and changed the revision adoption path to forward terminal metadata/public messages, clear obsolete structured output, and stop further reflection on noncompleted revisions. I inspected that correction and the new reflection tests passed in my later focused run. The parent should retain these tests in the final combined verification.

## Specification assessment

No separate specification defect requiring a product decision was found. The findings above are implementation/consumer integration gaps against the already selected terminal truth and cancellation requirements.

The inspected implementation follows the plan in the other assigned areas: cap zero admits no effects and cap one retains its final-answer opportunity; controlled counters persist across revisions; accounted late response usage is observed before abort acceptance; memory owns summary/extraction final settlement; failed/timeout drain retains admission closure and resources for a later close; wrapper ownership and legacy encoding defaults are explicit; tuple-v1 scope/Redis identities preserve exact string boundaries; incremental recovery scans validated numeric high-water without claiming distributed atomicity; Workflow merges produced patches, preserves failed child evidence, honors continue/stop, propagates nested structural conflicts after sibling settlement, and clones/version-validates absolute continuation cursors and caller options. Team handoff deprecation and native fixtures accurately distinguish ownership limits.

Documented limitations remain intentional: shallow nested Workflow state aliasing, legacy checkpoint identity uncertainty, explicit storage migration, externally enforced single-writer session ownership, borrowed-client coordination, no forced cancellation of arbitrary callbacks, and no durable active-run/effect recovery.

## Verification evidence and limits

- Fresh reviewer command: `npx --no-install vitest run packages/core/src/agent/__tests__/loop-boundary-parity.test.ts packages/core/src/agent/__tests__/agent-close.test.ts packages/core/src/workflow/__tests__ packages/core/src/storage/__tests__ packages/core/src/memory/__tests__ packages/core/src/session/__tests__/incremental-session.test.ts packages/core/src/team/__tests__ packages/core/src/cost/__tests__/cost-tracker.test.ts --reporter=dot` — **20 files, 268 tests passed**, 06:39:27 local time.
- Fresh reviewer `npx --no-install tsc -p packages/core/tsconfig.build.json --noEmit --pretty false` — exit 0. Source declaration check only; not a full test-type check.
- Fresh reviewer `git diff --check -- packages/core/src` — exit 0 at the checked state.
- Fresh reviewer inline TypeScript probes used the public Agent/semantic cache/native handoff journeys and deterministic fake providers; their outputs are recorded above.
- A later concurrent run of reflection-outcomes plus handoff tests saw **56 passed / 2 failed**. Both failures were the parent's newly added handoff fixture constructing a target without `.agent`, before behavioral assertions. Reported immediately; that run is not valid red evidence for the handoff defect. The original reflection regression passed in the same run. Parent must rerun after finishing the fixture/implementation.
- Read implementation reports' red/green records, but did not independently recreate every baseline red. API-absence reds establish missing methods, while subsequent branch-specific green tests and source inspection establish only their covered behavior. No broader model-quality or live-backend claim follows.
- Existing embedding fixture/mock tuple errors were reported as baseline and were not classified as changed-source failures.
- No full monorepo build, packed consumer test, live backend, or model-quality gate was run by this reviewer. Parent final integration remains responsible for final exact-state checks and public documentation/exports.

## Correction verification, 2026-10-13 01:15 UTC

The parent requested a fresh check of the corrections and of the related loop settlement-observation ordering. Read current source and new cache/protocol/reflection/native-handoff fixtures. Fresh command:

`npx --no-install vitest run packages/core/src/agent/__tests__/cache-outcomes.test.ts packages/core/src/agent/__tests__/protocol-terminals.test.ts packages/core/src/agent/__tests__/reflection-outcomes.test.ts packages/core/src/handoff/__tests__/streaming-handoff.test.ts --reporter=dot`

Result: **4 files, 31 tests passed**, 06:44:03 local time. The parent reports the corrected handoff fixture first produced two intended missing-metadata failures and then passed after implementation; this supersedes its earlier construction-only failures. The source correction is independently visible and the final tests pass.

Disposition of prior findings:

- **Reflection: closed.** Revised output adopts all selected terminal metadata and public messages, clears obsolete structured output, and does not invoke a further critic after a stopped revision.
- **Handoff metadata: closed.** Nonstream manager returns reason/partial/provider finish metadata, and source streaming adoption copies it from the target result.
- **Cache incomplete-result false success: closed.** Cache reads/writes apply `isReusableCacheResult`, including status, partial and provider finish checks; historical incomplete records are ignored. Pre-aborted and delayed awaited paths now check cancellation. One remaining first-publication edge appears below.
- **Empty tool batch false success: closed.** Generate and stream reject with a typed `invalid_model_response` error carrying partial evidence. The direct exported loop's usage carrier has a separate counting defect below; Agent's wrapper masks it, so the Agent-only regression passes.

Remaining actionable issues found during correction verification:

### P2 — Observe every settled member of a cancelled tool batch

`packages/core/src/agent/llm-loop.ts:609–611` and `:981–983` invoke `observeTool` inside the per-result processing loop. The harness observer records settlement, then its post-effect `ensureActive` rejects on cancellation. That exits the loop after its first result; remaining already-settled results are journaled in `finally` but never sent to the settlement observer.

Confirmed using public `createHarnessEvalTarget` + `agentDriver` with two parallel tools and a barrier ensuring both apply before abort. Observed `{ "applied": 2, "calls": 1, "status": "cancelled", "observed": ["one"], "coverage": "partial" }`. Conservative partial coverage is correct but does not justify discarding a known second settlement. The parent explicitly requested this adjacent M6 integration check; this is not a review of unfinished recall/eval behavior elsewhere.

Correction: give all already-settled results an observation-only phase before cancellation/control middleware can terminate processing, or otherwise guarantee settlement-only observation of every remaining result. Do not invoke post-tool enforcement/transform hooks or new model/tool work after abort, and do not observe the first result twice. Add a two-result cancellation regression for run and stream.

### P2 — Direct loop protocol-error usage is doubled

`packages/core/src/agent/llm-loop.ts:942` passes `observedUsage(chunkUsage)` to the new empty-batch error after `chunkUsage` was already added to accumulated totals at `:904–911`. A direct exported `LLMLoop.stream` probe reporting usage `2/1/3` carries `4/2/6` in `error.output.usage`. Agent.stream reconstructs the error with its separate usage accumulator, hiding this from the new Agent-level test.

Correction: use the already accumulated `observedUsage()` at that point and assert direct-loop error evidence as well as the public Agent wrapper.

### P2 — Cache-hit event cancellation still permits the first text chunk

`packages/core/src/agent/agent.ts:1264–1270` emits `cache.hit` and immediately yields cached text without rechecking its signal. An ordinary EventBus observer can abort the caller controller on receipt of that event. Confirmed public Agent/real cache probe: the first iterator result is `{ type: "text", text: "cached" }` while `signal.aborted` is already true. The subsequent guard prevents the finish but does not prevent this first publication.

Correction: check the signal after `cache.hit` emission and immediately before yielding cached text. The run cache path already checks after its awaited usage lookup. A small public streaming regression pins the missing boundary.

All three correction-verification issues were sent to the parent immediately. They are concrete local failures, not speculative requirements. Parent edits continue, so final closure requires checking their eventual corrected state; no additional source files were edited by this reviewer.

## Final core correction disposition, 2026-10-13 01:22 UTC

All prior core findings are now **closed in the reviewed source state**. The direct streaming loop's invalid-response carrier uses the accumulated `observedUsage()` exactly once. The cached stream checks its signal immediately after the `cache.hit` event and before yielding text. Both loop modes invoke the optional evidence-only `observeToolSettlements` once for the settled batch before per-result cancellation/control processing. Harness uses a run-local WeakSet to keep ordinary/delegated observations from duplicating those batch observations; observer failures are bounded diagnostics and cancellation still prevents new work.

Fresh reviewer regression command selected core cache-outcomes, protocol-terminals, reflection-outcomes, native streaming-handoff, harness eval-target, and context-memory-acceptance: **6 files / 84 tests passed**, 06:52:54 local time. This includes the direct-loop counting/event-boundary regressions and the actual two-applied-effect cancellation fixture. The streaming batch source branch was independently inspected; at this moment the two-effect adapter fixture pins the ordinary Agent path. Any later streaming extension will be recorded in the expanded review.

No remaining actionable core correctness or specification defect was found in this pass. M5/M6 continuity/measurement findings and their correction evidence are tracked separately in `continuity-eval-review.md`. Source remains concurrently edited; this is scoped review evidence, not a final package or release gate.

Final expanded reviewer selection at 06:58:14 local time: **16 files / 222 tests passed**. It now includes both ordinary and streaming real-Agent two-applied-effect cancellation regressions, with both settlements observed exactly once and final cancelled/partial status retained. The earlier streaming coverage residual is closed. Final M5/M6 verdict, observation marker, source/test type checks, repaired acquisition/measurement findings and package-gate limits are recorded in `continuity-eval-review.md`.
