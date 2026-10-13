# Storage isolation M2 and MemoryManager lifecycle M3 report

Implemented in the authorized isolated worktree only. No commits, installations,
provider/network calls or edits outside the assigned paths. Parent owns Agent,
root exports, README and final integration/review.

## Changed files and behavior

- `packages/core/src/storage/in-memory.ts`: separate namespace maps prevent
  delimiter collisions; literal startsWith prefixes and JSON cloning remain;
  deleting the last record removes its empty namespace map.
- `packages/core/src/storage/key-codec.ts`: internal versioned JSON scope tuples
  preserve absent versus empty identifiers; four-digit UTF-16 hex segments
  preserve exact JS strings (including Unicode and unpaired surrogates) and
  literal prefix identity. Malformed physical segments reject with TypeError.
- `packages/core/src/storage/scoped.ts`: additive ScopedStorageOptions
  (`keyEncoding?: "legacy" | "tuple-v1"`, `ownsInner?: boolean`), defaults legacy
  and owned. Initialization remains forwarded, with driver-owned idempotency.
- `packages/core/src/tenant/tenant-storage.ts`: same additive options, preserving
  legacy `t:<tenant>:<namespace>` keys; tuple-v1 uses the common scope codec.
- `packages/core/src/storage/redis.ts`: additive encoding config preserves legacy
  defaults and TTL behavior; v1 keys are
  `agkv1:<hex keyPrefix>:<hex namespace>:<hex key>`; SCAN uses only encoded literal
  prefix plus trailing `*`, consumes every page, and decodes final key segments.
  There is no fallback or automatic migration.
- `packages/core/src/memory/memory-manager.ts`: per-store background ownership
  covers overflow summaries, extraction operations and constructor-launched
  storage initialization through final settlement. Monotonic failures are
  counted once per failed owned operation before removal and reported once as
  memory.error. afterRun remains best effort and resolves after every extraction.
  drain waits for the set to empty, including new work added during waiting;
  timeout/abort retain ownership and pending operations; listeners/timers are
  cleaned on every completion path. Long deadlines are chunked to avoid Node
  timer overflow. awaitExtractions delegates to an unbounded drain and now waits
  for summaries too.
- Same file: rememberWithResult follows existing destination precedence (user
  facts, learnings, user-scoped entities); remember awaits it and still returns
  void. All context paths use one source-data wrapper; admission counts complete
  rendered strings including separators. Sections are atomic, priorities/ties
  stable; omissions get a marker only if some context is admitted and the marker
  fits. With no admitted sections, context is empty. Configured memory maxTokens
  must be a positive safe integer.
- New tests: `storage/__tests__/isolation.test.ts`,
  `storage/__tests__/key-codec.test.ts`,
  `storage/__tests__/redis-key-codec.test.ts`,
  `memory/__tests__/memory-lifecycle.test.ts`,
  `memory/__tests__/memory-context-contract.test.ts`.

## Rulings

- Ruling: prepare a user-scoped `_manual` entity before its first manual fact —
  EntityMemory.addFact silently returns if the entity is absent, so copying that
  call and returning stored:true would be false — cost if wrong: entities-only
  remember now creates a manual-memory entity where the legacy code could no-op.
  A test first failed with undefined persisted fact, then passed with the fix.
- Ruling: preserve existing user-scoped learning requirements — LearnedKnowledge
  defaults to scope=user and rejects omitted userId; do not silently elevate an
  unscoped remember into a global learning — cost: result-bearing writes to
  learnings without userId still reject instead of returning stored:false.
  Test covers successful scoped learning and existing unscoped rejection.
- Ruling: track constructor-launched storage initialization too — it is owned
  asynchronous work that can outlive Agent construction — cost: close may now
  wait for driver initialization, and initialization failures emit memory.error.
- Ruling: use no omission-only string when no whole section fits — this preserves
  an empty context for budgets smaller than the wrappers and avoids spending the
  entire allowance on a diagnostic — cost: no textual omission notice in that
  case (per the plan's optional-diagnostic allowance).

## Red/green evidence

1. `npx vitest run packages/core/src/storage/__tests__/isolation.test.ts`
   before implementation: 1 file failed, 4 tests failed. Values were overwritten
   across colon-delimited namespaces/scopes, and borrowed close erased shared
   data. Full output saved as `storage-red.log`.
2. `npx vitest run packages/core/src/storage/__tests__/redis-key-codec.test.ts`
   before implementation: exit 1, 3 tests failed. Physical segments collided,
   SCAN patterns contained literal glob IDs, and v1 read legacy data.
3. `npx vitest run packages/core/src/storage/__tests__` after M2:
   exit 0, 4 files passed, 38 tests passed.
4. `npx vitest run packages/core/src/memory/__tests__/memory-lifecycle.test.ts`
   before implementation: exit 1, 6 failed. awaitExtractions settled before the
   held summary; drain was missing in the other cases.
5. `npx vitest run packages/core/src/memory/__tests__/memory-context-contract.test.ts`
   before implementation: exit 1, 12 failed. Fit-all contexts lost wrappers;
   wrapper overhead was omitted; partial rules were admitted; invalid budgets
   were accepted; rememberWithResult was missing.
6. Focused M3 after first implementation: 17/18 passed; the remaining failure
   exposed the existing user-scope learning precondition. The corrected test then
   reproduced the entity no-op (undefined persisted fact), fixed above.
7. Final affected suite after formatting:
   `npx vitest run packages/core/src/storage/__tests__ packages/core/src/tenant/__tests__ packages/core/src/memory/__tests__`
   exit 0, 11 files passed, 116 tests passed. Output: `storage-memory-green.log`.
   Includes initialization, pre-aborted wait, deadlines beyond 2^31-1, timeout,
   cancellation, later successful drain, newly added work, overlapping drain
   failures, single diagnostics, timer/listener cleanup, scope collisions,
   absent/empty IDs, literal/glob prefixes, TTL, Unicode and surrogate identity.
8. Biome check of all 11 owned source/test files: exit 0,
   `Checked 11 files ... No fixes applied.`
9. `npm run build:core`: exit 0; both ESM and CJS bundles and declaration emission
   passed; `Generated 284 CommonJS declarations.` Existing dynamic-import and
   CommonJS recommendation warnings remain.
10. `npx tsc -p packages/core/tsconfig.json --noEmit --pretty false`:
    exit 2 after my fixture fields were corrected. No owned file errors remain;
    the captured output reports concurrently edited team-cancellation fixture
    errors and existing vector/embeddings test mock tuple errors. Full output:
    `storage-memory-typecheck.log`. The earlier workflow generic error was
    resolved by its owning worker before the successful core build.
11. Scoped `git diff --check`: exit 0.

No full monorepo test or live backend-integration claim is made. Redis tests use
the existing optional-dependency mocking seam with a local client double.

## Parent integration requirements

Export `ScopedStorageOptions` from storage/scoped.ts and `MemoryDrainOptions`,
`MemoryDrainResult`, `RememberResult` from memory/memory-manager.ts in the core
barrel. Existing RedisStorageConfig gains keyEncoding; keep the physical codec
internal.

Agent.close must hold lifecycle admission closed and await memory.drain before
disposing any owned resources/storage, including closeStorage:false. Default
deadline is 30_000ms. status=timed_out/cancelled means remote writes are still
possible; retain resources and allow a later close attempt. drained with failed>0
means settlement, not persistence success. Use the plan's MemoryDrainError and
AgentLifecycleError exports. Busy admission/concurrent close/retry/idempotent
teardown remain parent-owned.

Agent.buildMessages must move only MemoryManager-generated context to the
source user message with providerExtras memoryContext version=1/trust=source;
retain host system instructions; count the rendered source message as fixed
context and keep it out of canonical new messages/history. Wrapper labels alone
do not change provider authority.

README and relevant shared-client examples should explicitly select tuple-v1
and ownsInner:false, explain legacy ID restrictions/defaults and drain behavior,
and include the migration recipe: freeze writers; trusted logical inventory;
export through intended owners; detect duplicate identities; import into a
distinct v1 prefix; compare counts/payload digests; cut over every writer;
retain read-only legacy data for the rollback window. Never print payloads.

## Risks and scope limits

Legacy encoding intentionally remains ambiguous for unrestricted IDs until the
host migrates. New codecs do not rewrite old persisted data. Wrapper initialization
is still forwarded even when borrowed; the shared driver's owner controls safe
initialization/teardown. Source-label admission uses the existing countTokens
estimator (exact tokenizer when available), not a new tokenizer contract.

Direct host operations on exposed memory stores remain host-owned; drain tracks
operations launched by MemoryManager internally. Foreground direct memory APIs
are awaited by their caller; hosts must coordinate concurrent direct use with
closing the shared driver. Existing store-level fallback/caught failures are
preserved; the manager counts failures that reject its owned operation, not a
recovered provider error.

Slice self-review completed: checked codec boundaries, legacy defaults, final
write ownership, deadline-only cancellation, failure interval accounting and
whole-section token admission. Parent's whole-branch review remains required.
