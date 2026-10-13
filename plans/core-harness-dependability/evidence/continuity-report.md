# M5 bounded recall and incremental continuity implementation

Implemented in the isolated worktree only. Both features remain opt-in. No installs, paid provider calls, publication, commits, external writes, original-checkout edits, or subagents were used.

## Owned implementation

- New `packages/harness/src/runtime/recall.ts`: public protocol/types, strict Zod response/reference/scope validation, bounded indexed discover/read, actual serialized metadata/source byte accounting, host-estimated evidence tokens, query/candidate/excerpt limits, shared clarification allowances, source-cycle cancellation/deadline race, fresh bounded validation windows, safe fixed diagnostics, per-call immutable reference deduplication, and owned close cleanup including late open results.
- New `runtime/task-summary.ts`: bounded draft/record validation, retained `{id, reference}` citation mapping, exact per-conversation adjoining canonical-group coverage, source-view invalidation epoch, incremental additions only, explicit advisory task token floor, record/text/reference/token caps, post-model validation, and unchanged frontier on incomplete/failed/cancelled derived work.
- New `src/continuity-policies.ts`: `incrementalTaskSummaryPolicy`, `continuityContextPolicy`, `currentSessionRecallPolicy`; host-bound summary role via budgeted `controlModel`, strict bounded model JSON/citations, whole source-data user wrappers, exact-reference deduplication, full resident/tool/opaque replay preserved, and omission provenance.
- Updated `runtime/driver.ts`: constructor capability/bound/config validation; exact scope binding and explicit legacy import attestation; task call admitted before retention/continuity; no summarizer in arbitrary retention; at most one summary update per task prepare; shared same-slot live clarification; second assembly acceptance decision; final actual request estimator including tools/output and 128-token wrapper margin; pre-submit freshness; per-conversation in-flight update slots bound concurrent record creation and prevent conflicting lineage; fresh authorized terminal validation sessions; invalid derived records omitted from one awaited canonical commit; completed child summaries released; controller/protocol/acknowledgement behavior retained.
- Updated `runtime/context-policy.ts`: explicit optional recall/summary input and independent authorization of exact new continuity wrapper messages before existing immutable transform validation. Arbitrary new wrappers, altered source text, source trust promotion, and tool replay modification are rejected.
- Updated `runtime/session-bindings.ts`: optional exact `memoryScope` and conversation-keyed `taskSummaries` snapshot fields.
- New deterministic bounded fixture and tests: `runtime/__tests__/fixtures/continuity-fixture.ts`, `bounded-recall.test.ts`, `task-summary.test.ts`, `continuity-context.test.ts`, `continuity-runtime.test.ts`.
- At parent request, runtime `observeToolSettlements` observes every settled result before cancellation-sensitive processing, with a per-run WeakSet deduplicating exact objects. Existing `observeTool` still performs its later cancellation/control/hook checks.

## Contract rulings / additive surfaces

1. `RecallStore.capabilities.canonicalArchiveReads?: boolean` is additive. It must equal `true` when taskSummary is enabled, alongside residentHistory and the four bounded recall capabilities. A generic query-only reader remains compatible with the original four capabilities. The proposed protocol otherwise had no attestation capable of supporting its required constructor-time rejection of non-seekable canonical archives. Parent agreed; eval fixture advertises it.
2. `HarnessStartOptions.attestLegacyMemoryScope?: boolean` is the explicit host attestation for a meaningful untagged snapshot. `recallScope` accepts only trusted projectId/repositoryId dimensions; it cannot override tenant/user/session. Scope rejection releases the lease without committing or altering the snapshot.
3. All archive and query source I/O occurs under the single unchanged retrieval-cycle deadline **before** awaiting summary generation. Post-summary, pre-submit, and pre-commit checks use fresh finite validation windows. Moving query discovery after arbitrary summary latency would necessarily expire the one source deadline and violate the required long-model-latency fixture; this change does not renew source deadlines or add a hidden retry.
4. Retrieval-stage await_input uses the existing live requestInput mechanism, retains the admitted task slot, appends the reply as canonical user evidence, and consumes remaining source/query/token allowance. Allocation-stage stop or await_input produces explicit `recall_assembly_omitted`; only explicit uncertainty-aware continue submits after omitted source evidence. Allocation requires more prompt capacity or explicit partial continuation, not another hidden retrieval loop. Both decisions use the same strict bounded Zod schema.
5. Current-session policy stops on partial/failed recall. A host may explicitly continue after failure with safe source-status data and no derived evidence. Healthy zero accessible matches remain distinct from backend failure.
6. The runtime's automatic recipe reserves requested output, estimated tool schemas, and a 128-token wrapper margin. The supplied public recipe requires explicit maxRequestTokens/reservedRequestTokens. Final provider-specific request estimation still includes actual projected messages, tools, and requested output. Summary preflight uses a conservative source-byte input allowance plus 1024 tokens for wrapper/control overhead, its output cap, and an explicit essential task floor; final ordinary ledger admission remains authoritative.

## Integration APIs

Parent owns public barrels, policies re-export, and README. New public plan types reside in recall.ts/task-summary.ts; the three factories and their option types reside in continuity-policies.ts. Internal helpers are named exports for integration/test use: `openRecallCycle`, `createRecallUsage`, `validateRecallView`, `validateRecallConfiguration`, `boundRecallQuery`, `validateTaskSummaryConfiguration`, `validateTaskSummaryRecord`, `readTaskSummaryAdditions`, `advanceTaskSummaryCoverage`, `updateTaskSummary`. No `HistoryArchive.read` adapter shim exists. Canonical complete-group readers must honor limits before materialization and separately recheck scope/access per operation.

## Red / green evidence

- Initial bounded-recall seam: 2 tests failed for missing locator retrieval and failure-vs-empty behavior, then passed after implementation.
- Initial task-summary seam: contiguous complete-group coverage test failed with empty additions, then passed.
- Initial context seam: source-data wrapper test failed because evidence was absent, then passed.
- Initial actual-runtime seam: summary provider was never called before prepare integration; after integration it exposed the existing transform prohibition on introducing wrappers, which was resolved with independently authorized exact source messages. Actual captured provider requests and canonical snapshots now pass.
- Independent reviewer reproduced a late-open ownership leak. Two new tests failed with opened1/closed0 for post-result deadline and cancellation races, then passed with opened1/closed1 after ownership registration moved inside the operation callback and catch cleanup preceded cancellation rethrow. The earlier unresolved-late-open test also passes.
- During fixture expansion, two clarification tests timed out because the test called `RunHandle.reply` with an object instead of its existing `(id, input)` signature. Corrected the fixture call and awaited reply; no production workaround or weakened assertion.

Fresh final command results on the current owned source:

```text
./node_modules/.bin/vitest run \
  packages/harness/src/runtime/__tests__/bounded-recall.test.ts \
  packages/harness/src/runtime/__tests__/task-summary.test.ts \
  packages/harness/src/runtime/__tests__/continuity-context.test.ts \
  packages/harness/src/runtime/__tests__/continuity-runtime.test.ts \
  packages/harness/src/runtime/__tests__/resident-history.test.ts \
  packages/harness/src/runtime/__tests__/control-model.test.ts \
  packages/harness/src/runtime/__tests__/runtime.test.ts \
  packages/harness/src/runtime/__tests__/completion-verification.test.ts \
  packages/harness/src/runtime/__tests__/session-acknowledgement.test.ts
9 files passed; 105 tests passed (52 M5 tests + 53 runtime regressions).

./node_modules/.bin/tsc -p packages/harness/tsconfig.json --noEmit --pretty false
Passed, including new source tests/fixtures.

./node_modules/.bin/tsc -p packages/harness/tsconfig.build.json --noEmit --pretty false
Passed.

./node_modules/.bin/biome check [11 owned source/test/fixture files]
Checked 11 files; no fixes/errors on final read-only check.
```

The tests exercise physical source bytes/locator seeks (including a relevant final group in 10,001 groups), strict oversized/forged metadata rejection, forbidden scope, immutable whole negation/correction text and partial context, discovery-to-read revocation, shared clarification budgets, source timeout/cancellation, fresh validation after expired source deadlines, open-result race cleanup, incremental A then B, gaps/deletions, root/child coverage, record/citation/lineage caps, concurrent reserved record slots, task-capacity retention, arbitrary retention without derived calls, scope import/reuse, actual generate/stream requests, model-latency windows, pre-submit revocation, terminal validation timeout/revocation, canonical persistence, and protected-vs-read-only publication fixture behavior.

## Limits and remaining parent work

- Read fences are observation boundaries, not atomic transactions spanning provider submission and an independent session store. Only a host conditional publication implementation supplies the stronger deletion/write guarantee; the fixture demonstrates that distinction and the SDK does not advertise it.
- A noncooperative host adapter/provider may continue backend work after a race returns. Runtime responsiveness and bounded owned close are enforced; host adapters must stop physical I/O on signal and apply limits before loading data.
- There is no semantic contradiction detector, automatic fact promotion, cross-run recall cache, archive gap/tombstone skip receipt, recovery checkpoint, or task-token lease. Deleted/unavailable canonical groups block contiguous summary coverage; later accessible evidence remains independently queryable.
- A concurrent call or inaccurate provider estimator can defeat the advisory task floor. Final token admission remains explicit; staged summaries publish only after pre-submit validation and successful final task admission. Canonical sources remain preserved on failure.
- No live provider accuracy claim is made. Unit/runtime fixtures establish source coverage/provenance/lifecycle, not whether arbitrary model answers use that evidence. Parent/eval worker owns the separately captured answer-use acceptance metrics.
- Parent will run fresh package builds, full repository tests, packed ESM/CJS/TypeScript consumers, and documentation example compilation after handoff; those are not claimed here.
