# Implementation and release

- [x] Add reusable input lifecycle types/ports and runtime state, reply validation,
  timeout/cancel handling, events and optional question tool. Verify lifecycle tests.
- [x] Add built-in steering at core loop boundaries in both modes, with ordered
  receipt/application events. Verify held-tool and finalization-race tests.
- [x] Add public item contracts, provider capability reporting, summary separation,
  loop events and driver forwarding. Verify streaming/nonstreaming conformance.
- [x] Extend existing compaction grouping/validation and correlated events.
  Verify single-turn compaction, replay integrity and shared budget tests.
- [x] Document public usage, compatibility and capability limits; add changelog.
- [x] Run all tests, lint, builds and packed-consumer checks. Review final diff.
- [ ] Bump lockstep workspace packages/peers to the next available minor, push
  implementation and exact annotated release tag, and verify publish outcome.

Risks: cancellation during a pending tool; acceptance/finalization races; native
phase availability; opaque replay dependencies; aggregate usage under streaming.
Tests target these boundaries, not implementation details. No live model calls are
required for verification. Keep the original checkout's unrelated plans untouched.

## Verification (2026-10-09)

- All ten workspace packages build successfully.
- Full Vitest suite: 2,383 passed; 27 existing integration tests skipped.
- Biome: 679 files checked, no issues.
- Release lock and CommonJS declarations: 4 tests passed.
- Packed core/harness/CLI consumption: 2 tests passed, including ESM, CommonJS,
  TypeScript exports and the new conversational public API.
- Tests cover both Agent streaming modes, cancellation while a question tool
  waits, duplicate/stale replies, remaining active/model budgets, held parallel
  tools, final-model-call steering, finalization races, native phases/summaries,
  interrupted items, single-task compaction and correlated budget failures.
- Release version: 4.6.0; latest published baseline was still 4.5.0 at verification.

Provider references checked against installed SDK types and official docs:
- https://developers.openai.com/api/docs/guides/reasoning
- https://developers.openai.com/api/reference/resources/responses/streaming-events
- https://ai.google.dev/gemini-api/docs/thinking
- https://platform.claude.com/docs/en/build-with-claude/thinking
