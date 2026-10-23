# Scoped comment review

Reviewed the current working-tree diff against `c6d52c5673beba25c2dddafcbbb28de7aa9e28c9`. No source edits, delegates, connectors, or network calls. This report is the only file written.

## Verdict

No additional comment deletions recommended. No `MUST KILL` flags.

The diff adds or revises ten comment blocks. Nine qualify as exported API documentation. The remaining Argon date comment has a plausible external-constraint exception, with source verification deferred to the parent as described below.

Three obsolete comment blocks are already deleted by the implementation. Keep those deletions.

- `packages/core/src/models/providers/openai-decisions.ts` removes the claim that the endpoint accepts only user messages. The native input schema now accepts system, developer, assistant, user, and historical tool items.
- `packages/core/src/models/usage-normalizers.ts` removes the inclusive-input-only billing claim. The implementation now preserves payable input/cache partitions and sets only output to zero.
- `packages/core/src/cost/catalog-data/reviewed.ts` removes the obsolete Decisions input-only contract claim. The tariff row now contains distinct input, cache-read, and cache-write prices.

One existing documentation block is replaced in `thinking-replay.ts`. This is a correction, not an additional deletion recommendation.

## Accepted keep exceptions

- `packages/core/src/models/decisions.ts:24,27,101,160`. `DecisionInstructionPart`, `DecisionJSONValue`, `DecisionInputPart`, and `DecisionInputItem` describe the exported input contract. The finite JSON claim matches `validateDecisionJSON`; shared text/image schemas own the cache breakpoint; history is serialized as evidence rather than executed.
- `packages/core/src/models/providers/openai-decisions.ts:32,34,38,114`. The cache configuration, `OpenAIDecisionsEvaluateOptions`, and `evaluate` comments document caller-visible behavior. `evaluate` forwards the explicit cache fields and submits the validated evidence in one request.
- `packages/core/src/models/thinking-replay.ts:158`. The revised `applyGoogleRequestExtras` doc removes a stale Gemini 3.8-only restriction after adding Argon handling. Retain the exported function's behavior summary.
- Nearby existing documentation for `DecisionQuestion`, `DecisionAnswer`, `ModelQuestions`, `OpenAIDecisionsConfig`, `OpenAIDecisionsProvider`, and `REVIEWED_PRICING_CATALOG` remains useful API contract text. No stale claim identified that requires deletion.

## External claim requiring parent evidence

`packages/core/src/cost/catalog-data/reviewed.ts:215` says the source gives December 1 without a timezone. The tariff data and `reviewed-pricing.test.ts:204` consistently implement a worldwide 26-hour uncertainty interval from `2026-11-30T10:00:00.000Z` to `2026-12-01T12:00:00.000Z`.

The comment explains a vendor constraint rather than an unexplained workaround. Keep it if the parent's fetched source confirms the date-only wording. This read-only, no-network review cannot independently certify that external wording. Do not present it as independently verified here. The parent received this qualification during the review.

## Suppressions and skips

No new or changed lint/TypeScript suppressions occur in scope. The four existing `@ts-expect-error` directives in `packages/harness/src/__tests__/package-consumption.test.ts:349,351,353,355` are intentional negative package-contract tests. Removing them would break the test mechanism. They are not production type-check escapes.

Historical `consume`, `drain`, and explanatory test comments are unchanged. No stale claim was identified near a changed test block, so historical cleanup was skipped. Existing unrelated provider comments were likewise excluded. README, barrel exports, plan artifacts, dependencies, and vendor-source fact checking were outside this review.

## Files inspected

Source files were `decisions.ts`, `decision-input.ts`, `providers/google.ts`, `providers/openai-decisions.ts`, `thinking-replay.ts`, and `usage-normalizers.ts` under `packages/core/src/models`, plus `packages/core/src/cost/catalog-data/reviewed.ts`.

Changed tests were `accounting-lifecycle.test.ts`, `reviewed-pricing.test.ts`, `billing-context-agent.test.ts`, `openai-api.test.ts`, `openai-decisions.test.ts`, `usage-conformance.test.ts`, `decision-input.test.ts`, `google-argon.test.ts`, `model-alias-accounting.test.ts`, and the harness `package-consumption.test.ts`. New test files contain no comments.

Minimize Reader Load kept the review focused on comments that add contract information rather than demanding cosmetic rewrites. Prove It Works required inspecting the actual diff, schemas, call paths, and assertions before assigning keep exceptions. Tests were read, not executed. No runtime correctness verdict is implied.
