# Current Accounting Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct Decisions GA cache billing and add verified missing current-model tariffs without rewriting historical costs.

**Architecture:** Keep the canonical normalizer/catalog/calculator/ledger path. Add explicit evidence versions and scoped tariff rules, retain existing supported rates, and leave unknown combinations unpriced. Do not expand the legacy flat price table to represent complex contracts.

**Tech Stack:** TypeScript, existing decimal arithmetic, pricing catalog, Vitest and provider HTTP fixtures.

**Spec:** [Design, Increment 2 and Global constraints](design.md).

## Global Constraints

- Runtime support stays `^22.18.0 || ^24.11.0`.
- Preserve existing provider constructors, question strings, answer shapes, cancellation, retry ownership, and stored ledger records.
- Preserve explicit caller token limits and timeouts; do not silently raise spending limits or change default models.
- Unknown billing facts or unsupported tariffs produce an incomplete/unpriced result, never a guessed zero cost.
- New price rules require a primary source URL, verification timestamp, exact model/API/billing dimensions, and a reviewed effective interval.
- No live model requests are required to write this plan; implementation tests use deterministic fixtures by default.
- Do not tag, publish, deploy documentation, or change package versions during implementation without a release instruction.
- No new production dependencies are planned. Any required optional SDK floor must be verified and documented for the affected feature rather than broadly breaking older supported providers.

## Review Focus

- Decisions cache reads/writes are disjoint subsets of inclusive input and never charged twice.
- Missing counters or inconsistent partitions cannot establish a complete charge.
- The new contract cannot silently reprice pre-verification usage or alter stored assessments.
- Actual returned model/tier determines the tariff; unknown aliases or missing billing dimensions remain unpriced.
- Context/date boundaries apply once; adding a supported regional Sol tier cannot enable unsupported Astra deployments.

## File responsibilities

- Modify `packages/core/src/models/usage-normalizers.ts`: Decisions payable measurements and affected normalizer version.
- Modify `packages/core/src/cost/catalog-data/reviewed.ts`: new catalog version, verified Decisions/Sol/Argon rules; retain other rule timestamps and expiry checks.
- Modify `packages/core/src/cost/__tests__/reviewed-pricing.test.ts`: replace obsolete input-only assertions with GA cache and tier/band tests.
- Modify `packages/core/src/models/__tests__/usage-conformance.test.ts` and `packages/core/src/cost/__tests__/accounting-lifecycle.test.ts`: measurement completeness, provider evidence and immutable history.
- Modify `packages/core/src/models/__tests__/billing-context-agent.test.ts`; create `packages/core/src/models/__tests__/model-alias-accounting.test.ts` only if independent HTTP fixtures are needed for DeepSeek streaming identity.
- Modify `packages/core/README.md`: canonical pricing and historical behavior; docs-repository `cost/overview.mdx`, `models/openai-decisions.mdx` and `models/deepseek.mdx` follow the same contract.

### Task 1: Correct Decisions cache measurement and charging

**Interfaces:** Preserve `normalizeProviderUsage(...)`, `calculateCharges(...)` and exported `REVIEWED_PRICING_CATALOG` interfaces. Produce versioned GA measurements: ordinary input, cache read, cache write, and zero payable output.

- [ ] Add failing tests `charges Decisions GA cache partitions once`, `keeps missing Decisions cache evidence incomplete`, and `does not rewrite a stored Decisions assessment`. For input 1000/read 800/write 100/output 50, assert payable quantities `[100, 800, 100, 0]`, inclusive input remains 1000, and standard global total is `0.0000305`. At 272001 input tokens and supported regional processing assert the documented factors apply once. Test absent cache fields, read+write > input, unknown models, and caller cancellation after usable billing evidence arrives.
- [ ] Run `npx vitest run packages/core/src/cost/__tests__/reviewed-pricing.test.ts packages/core/src/models/__tests__/usage-conformance.test.ts packages/core/src/cost/__tests__/accounting-lifecycle.test.ts`; confirm the obsolete input-only rewriting causes the intended failure.
- [ ] Remove the inclusive-input-only payable rewrite for the verified GA contract; retain output as a zero payable meter with contract evidence. Increase the Decisions normalizer version from `1.1.0` to `1.2.0` and keep other provider evidence versions unchanged. Replace Decisions rules in the new reviewed catalog with GA rates and a verified `effectiveFrom` timestamp; do not retain old inclusive-input rules in that new catalog where they could accept new normalized historical input. Preserve old catalog versions in recorded assessments and the pre-change snapshot fixture. Historical inputs before the verified start remain unpriced under the new catalog; no automatic reprice or ledger migration runs.
- [ ] Run the same tests plus `npx vitest run packages/core/src/cost/__tests__/calculator.test.ts packages/core/src/cost/__tests__/budget.test.ts packages/core/src/models/__tests__/openai-decisions.test.ts`. Expect all pass; update the old test that treats missing detailed cache evidence as fully priceable. Document the corrected contract and historical limits.
- [ ] Commit as `fix(core): account for Decisions GA prompt caching`.

### Task 2: Add only missing verified current-model tariffs

**Interfaces:** Consume existing `PriceRule` effective intervals/context bands and exact decimal rates. Produce a versioned reviewed catalog with Sol Ultrafast and Argon Standard paid global text rules, leaving unsupported endpoints/tiers unpriced.

- [ ] Recheck the primary sources linked in the design. Record verification time and the price-effective evidence in the commit or a concise test fixture comment. Inspect existing catalog rules first; do not re-add Haiku/Sonnet/Sol Standard support. Determine the documented Argon billing cutoff; if the date has no precise timezone, expire the introductory rule at the earliest plausible UTC cutoff and leave the uncertainty interval unpriced until the first unambiguous instant for the new rate. Do not guess a provider timezone.
- [ ] Add failing tests `prices Sol Ultrafast by actual supported region and context`, `bounds Argon introductory prices by verified dates`, and `keeps unrelated tariffs unchanged`. Assert Sol input `12`/output `60` per million at standard-length global Ultrafast; input `26.4`/output `99` at long-context US Ultrafast. Assert already-supported Sol/Haiku boundaries, cache-write TTL rates, and old catalog staleness behavior. Assert the Argon rule interval metadata and ordinary/read/output rates `2/0.1/10` before the verified transition and `4/0.2/20` after it; production catalog staleness still takes precedence, so an expired catalog must remain unpriced regardless of a future rule; explicit cache writes and unsupported tiers/APIs remain unpriced.
- [ ] Run `npx vitest run packages/core/src/cost/__tests__/reviewed-pricing.test.ts packages/core/src/cost/__tests__/catalog.test.ts`; confirm missing-rule failures.
- [ ] Add exact scoped rules. Extend helper parameters only as needed for per-rule verification/effective dates and model-specific regional support. Do not reset the shared verification timestamp of unchanged rules or extend catalog lifetime without revalidation. Preserve custom contract precedence and legacy `IncompleteCostError` behavior.
- [ ] Run the same tests plus `packages/core/src/cost/__tests__/cost-tracker.test.ts` and `packages/core/src/cost/__tests__/agent-cost-dx.test.ts`; expect all pass. Document supported/unsupported billing combinations.
- [ ] Commit as `fix(core): fill verified current-model tariff gaps`.

### Task 3: Prove model aliases preserve billing identity

**Interfaces:** Consume `BillingContext.requestedModelId`, `modelId`, `actualServiceTier` and existing catalog aliases. No global model registry or automatic request-ID rewrite is introduced.

- [ ] Add fixture tests `retains a rerouted Google model identity` and `retains a DeepSeek alias and served model in generate and stream`. Assert original request ID, returned served ID, actual response tier, and raw usage survive into ledger assessments. Without a verified tariff, assert `total === null` and an unpriced reason rather than the old model's price. With an explicitly supplied exact contract, assert that contract is selected. Demonstrate any existing passing path before making changes.
- [ ] Run `npx vitest run packages/core/src/models/__tests__/billing-context-agent.test.ts packages/core/src/models/__tests__/billing-context.test.ts packages/core/src/models/__tests__/model-alias-accounting.test.ts` (omit the final file if fixtures fit existing files).
- [ ] Fix only demonstrated identity gaps in `models/usage-normalizers.ts`, `models/providers/google.ts`, or `models/providers/openai-compatible.ts`. Keep provider/endpoint scoped aliases only when primary billing evidence proves the target rule. No supported DeepSeek tariff is promised by this task if evidence is insufficient.
- [ ] Rerun identity, reviewed-pricing and accounting-lifecycle tests. Update DeepSeek/Google migration guidance with both requested and served identities. Expect all tests pass and unknowns remain explicit.
- [ ] Commit as `fix(core): preserve served model billing evidence` if code changes were needed; otherwise include the regression tests/documentation in a `test(core)` commit.

Complete shared verification from the [umbrella plan](README.md). Decisions GA expansion depends on Task 1's corrected accounting contract.
