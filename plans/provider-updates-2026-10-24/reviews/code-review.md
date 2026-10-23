# Provider update code review

Base revision is `c6d52c5673beba25c2dddafcbbb28de7aa9e28c9`. Reviewed the final working-tree production diff, relevant untracked modules/tests, all five provider plan documents, and `/tmp/agentium-provider-design-judgment.md`. No source, index, branch, or commit changes were made. Reviewer model is inherited and unverified.

## Assessment

No remaining actionable standards/correctness or specification findings. One signed-stream replay defect was reproduced and fixed during review. The native Decisions boundary and canonical accounting changes have no additional actionable findings. Full build/type/lint/package evidence belongs to the parent's verification run. This review did not make live provider calls.

## Standards and correctness

No remaining findings.

## Resolved during review

### P1. Retain earlier signed parts when a streamed tool turn finishes

Pre-fix location was `/Users/xerycks/Xhip/agentium/packages/core/src/models/providers/google.ts:271`, specifically the replay replacement at lines 271–274 and final-chunk classification at line 311. The current implementation accumulates parts and uses the whole-turn call counter.

When two parallel function calls arrive in separate SSE chunks, the first chunk can contain the signed first function call and the final chunk can contain the second function call with `finishReason: "STOP"`. The terminal branch replaces `replayParts` with only that final chunk. The provider emits both tool calls, but its finish event retains only the second call in `providerExtras.googleParts`. `toGoogleMessages()` then prefers that incomplete replay over the normalized assistant calls. The next HTTP request contains the second call followed by both function results, with the first call and required signature missing.

I reproduced this against the installed `@google/genai` serializer and a local HTTP/SSE fixture. The rerunnable fixture is `/tmp/agentium-google-split-replay.ts`; run it with the repository's `node_modules/.bin/tsx`. First response chunks were a signed `one` call and a terminal unsigned `two` call. Observed emitted call IDs were `["one", "two"]`; observed retained `googleParts` contained only `two`. The second serialized request contained only model call `two`, followed by outputs for `one` and `two`.

The same state error affects a final text/signature chunk after a prior function call. `hasToolCalls` inspects only final-chunk parts, so the turn can become `stop` and the Agent rejects its pending calls before execution.

Google's [thought-signature documentation](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures) requires the first parallel call's signature to be returned in the original part. It documents strict current-turn signature validation. This causes otherwise valid streamed Argon tool turns to fail when continued.

The owner fixed this by accumulating all response parts in order and deriving terminal tool-call classification from the whole turn. Added real-SDK fixtures cover a second-call terminal chunk, a text-only terminal chunk, and a terminal chunk without content. Each asserts both calls, retained signatures, the `tool_calls` finish, and the exact second serialized request. I reran the independent reproduction and observed both calls and the original signature in the second request. I also independently ran the three split-chunk regression cases; all three passed, with the other 36 cases skipped by the name filter.

Confidence is high. The defective branch existed before this diff but directly contradicted the approved signed-replay deliverable. The final changes now cover split-chunk tool history, which the earlier single-chunk fixture did not establish.

## Specification

No remaining findings. The resolved P1 above covered Gemini Task 2 and the global preserve-signed-replay constraint. The final class-based native Decisions example and packed declarations preserve the generic registry factory contract without falsely promising `evaluate()` on custom `ModelProvider` overrides.

Confirmed the following in code and deterministic fixtures:

- Argon option validation precedes dispatch, preserves explicit output limits, and rejects continuation after retaining available usage.
- Decisions native JSON is bounded by depth, value count, and compact UTF-8 bytes; object-only roots and arrays of objects are enforced. The [current Decisions create reference](https://developers.openai.com/api/reference/resources/decisions/methods/create) supports the reviewed role/call and image shapes.
- Native and adapted Decisions requests share `evaluate()`, preserve roles and call IDs, reject unsupported evidence, count question/output/input images together, and use the SDK's generic `post` path with retries disabled.
- Invalid Decisions responses retain usage; pre-dispatch, in-flight, and post-response cancellation paths have explicit coverage.
- Decisions payable cache partitions remain disjoint; output is a derived zero meter with contract evidence. Version 1.2.0 is scoped to Decisions and Argon. Stored historical assessments are not rewritten.
- Sol Ultrafast is scoped to Responses and supported regions. Argon excludes explicit-cache writes and unsupported endpoint/tier combinations. New effective timestamps and the date-only transition gap preserve old catalog expiry.
- Public type/evaluate exports are included in the existing packed-consumer fixture.

## Declined to judge

- Real provider account access, endpoint acceptance, and live billing reconciliation. No credentialed provider call was authorized or made for this review.
- Whether Google assigns a particular undocumented timezone to its December transition. The approved conservative gap is explicit and supported by the parent's source check.
- New tariffs for returned version-suffixed or retired aliases without exact billing evidence. Leaving them unpriced is the approved behavior.
- Generalized model registries, Interactions continuation, new SDK dependencies, background execution, and unrelated provider refactors. These are explicitly deferred.
- A separate comment-only delegate. The review assignment prohibits nested delegates. No comment-style findings are claimed.

## Review method

The read-only investigation followed the code-review and TypeScript skills. The Principles section was read in full. Prove It Works changed the check from trusting the one-chunk fixture to inspecting a real second serialized request. Minimize Reader Load guided tracing the same replay array through stream finish, stored assistant history, and the next request instead of inferring behavior from helper names. Throughput checkpoint is n/a for this read-only investigation. Cross-turn Poteto hook state was not verified.
