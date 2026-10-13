# Implementation and validation results

Completed in the proposed dependency order. Source changes are in core adapters/execution boundaries and harness runtime; public root exports and both package READMEs describe the supported contracts.

## Original proposals

| Proposal | Finding and resolution |
| --- | --- |
| Retry/deadline control | Confirmed narrow configs and fixed provider retries. Also found an additional Agent retry wrapper. Exported constructor/factory controls for Agentium and SDK retries and timeouts; controlled Agents no longer add implicit outer retries. Waits honor cancellation and streams never replay after establishment. SDK-owned retries remain opaque. |
| Budgets and finishing | Confirmed harness reservations omitted input and no finishing reserve/snapshot existed. Corrected the broader claim: core monetary accounting already had independent store-backed reservations. Added harness input/output reservations, call-slot protection during projection, snapshots, idempotent settlement, unknown-usage charging and explicitly granted tool-free finishing calls. |
| Resident history | Confirmed context projection leaves canonical records resident. Existing core retention already groups turns. Added opt-in archival/retention and verified retrieval, persisted references, released built-in Agent copies, and archived completed child transcripts. |
| Input validation | Confirmed internal validator was absent from package-root exports. Added root validation/parsing and immutable metadata; start/send/reply now share validation. Correlation and live state remain consumption-time checks. |
| Endpoint/capabilities | Confirmed silent Responses-to-Chat reasoning downgrade, including fallback after raw metadata consumption. Required Responses now fails closed, automatic conversion rejects semantic loss, and host capability facts support preflight without a library registry. |

## Ownership and compatibility

Adapters own request construction, SDK options and continuation semantics. Harness owns per-run resource admission, live lifecycle, resident-history references and grants. Host owns retry policy selection, authoritative token estimates/capability data, archive implementation and storage retention. Currency budgets remain in core accounting.

Preserved ordinary adapter retry defaults and standalone Agent retry defaults. Necessary changes: harness-controlled Agent outer retries default to zero; incompatible endpoint fallback now throws; finite token budgets reserve input as well as output; unknown submitted-call usage is charged conservatively; initial run input now obeys the same content/byte limits as replies. History behavior changes only when explicitly configured.

Call slots are reserved before controllers/context projection, without increasing used calls. Token reservations are acquired after projection/capability validation. Failed preparation and pre-cancelled submission release without charge. Known billed normalization failures reconcile ModelUsageError usage; stream abandonment/unknown usage charges projected capacity. finishModel never skips role grants, option allowlists, tool-free result validation or the final completion policy.

## Material limitations

* Token sizing and configured model facts are host-supplied/advisory until verified by the provider. Hard physical-token bounds require conservative estimates, bounded output and a single explicit retry owner. Unknown SDK retry consumption cannot be reconstructed; real overruns remain recorded rather than hidden.
* Resident limits apply per active conversation at safe model/session boundaries. Host instructions and the latest whole turn must fit; failure snapshots preserve evidence even if oversized. Custom-driver copies, many concurrent sessions, archive-reference metadata and archive storage remain host-owned. No backend is bundled.
* Unknown opaque continuation requires explicit host attestation; explicit unsupported eviction is rejected. Retrieval verifies exact JSON message content against the saved digest and does not automatically promote archived content to instructions.
* Session snapshots are not resumable active-run checkpoints.

## Verification

Final checks on 2026-10-12:

* `npm run build`: all workspaces passed.
* `npx tsc -p packages/core/tsconfig.build.json --noEmit --pretty false`: passed.
* `npx tsc -p packages/harness/tsconfig.build.json --noEmit --pretty false`: passed.
* `npx vitest run`: **223 files passed, 10 skipped; 2,448 tests passed, 27 skipped**. Existing local HTTP tests required localhost-binding permission and passed with it enabled.
* `npm run test:package`: both packed-package tests passed, including ESM, CommonJS and public TypeScript imports without optional SDK dependencies.
* Biome on changed TypeScript files and `git diff --check`: passed.

New suites: `core/src/models/__tests__/request-controls.test.ts`, `endpoint-capabilities.test.ts`, and harness runtime `budget-reservations.test.ts`, `resident-history.test.ts`, `public-input.test.ts`. They cover backoff cancellation in adapter and Agent layers; deadlines during retries/streaming; installed-SDK retry ownership and visibility; metadata-only stream failure; concurrent reservations, late usage, parse-error usage and release; finishing protection and completion rejection; signed exchange replay, archive failure/corruption/scoping; encoded UTF-8 limits and root exports; required endpoint semantics, capability limits and unknown-capability policy. Existing compaction, accounting, driver, continuation, live-input and package suites remain passing.

## Explicitly deferred

* Skill-reference paging: confirmed the built-in tool reads the entire file. Future design should include stable offsets/revisions, bounded pages and truthful omission markers.
* Durable active-run recovery: requires versioned execution checkpoints, pending-input claims and safe continuation of already-started effects. No live-run restoration was added.

The pre-existing untracked `plans/2026-10-10-sdk-audit/` directory was left untouched.
