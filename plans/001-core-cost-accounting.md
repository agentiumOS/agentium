# Plan 001: Make usage and cost accounting reliable inside core

> This is a build plan, not an implementation. Keep all accounting logic in `@agentium/core`.
> Read the complete plan before changing source. Follow the phases in order. Keep existing unrelated work intact.

## Status and baseline

- Priority: P1 overall. Non-model coverage follows the common foundation.
- Effort: L; deliver in several reviewed changes, not one large rewrite.
- Risk: high at public usage, streaming, retry, and budget boundaries.
- Dependencies: none outside the existing repository and its optional provider/storage SDKs.
- Planned at: `f192926b57ca6a287548d6d985af08e5658263bd`, 2026-10-08.
- Repository: `/Users/xerycks/Xhip/agentium`.
- Documentation: `/Users/xerycks/Xhip/agentium-docs`, reviewed at `52af1a5`.
- Review method: source inspection and official/reference documentation. No tests or builds were run during planning.
- User decision: cost tracking stays in core. Do not create a cost package or a pricing service.

Run these drift checks before implementation:

```sh
git diff --stat f192926..HEAD -- packages/core packages/browser packages/observability packages/eval packages/admin
git status --short
git -C /Users/xerycks/Xhip/agentium-docs diff --stat 52af1a5..HEAD
```

Compare changed accounting paths with the current-state excerpts below. Reconcile ordinary drift before editing. Stop if a newer implementation invalidates the contract or migration assumptions.

## 1. Objective

For every cost-bearing operation that Agentium can observe:

1. Preserve the provider's usage evidence.
2. Identify the actual provider, resource, API, and request attempt.
3. Convert usage into quantities with defined meanings.
4. Select a documented price rule for each required charge.
5. Store a reproducible assessment, including missing information.
6. Sum each selected charge once for runs, teams, workflows, sessions, users, and tenants, respecting group billing and attribution.
7. Apply budget policy before new work and settle it after work.

Support new adapters and billing units through documented extension points. Complete support must be demonstrated for named API/model/tier combinations. Do not advertise automatic accuracy for arbitrary adapters or future provider features.

## 2. Scope

### Source boundaries

Most new code belongs under `packages/core/src/cost/`. Provider-specific response parsing stays next to provider adapters under `models/`, `voice/`, `vector/embeddings/`, `rerank/`, and `toolkits/`.

Integration files in scope:

- `packages/core/src/models/{types,provider,openai-api,decisions,jev-sdk,fallback-provider,model-router}.ts` and `models/providers/*.ts`.
- `packages/core/src/agent/{agent,llm-loop,types,run-context,execution-services,reflection}.ts`.
- Core direct-call sites under `compression/`, `context/`, `tools/`, `memory/`, `graph/`, `team/`, and `workflow/`.
- `packages/core/src/events/{types,event-bus}.ts`; preserve existing observer isolation.
- `packages/core/src/{voice,vision,telephony,vector/embeddings,rerank,toolkits}/` only where usage is captured or accounting context is passed.
- `packages/core/src/storage/` only for optional accounting adapters/capabilities and identified completeness issues required by those adapters.
- `packages/core/src/index.ts`, core package manifest/lockfile only for public exports and an exact-decimal dependency if required.
- `packages/browser/src/browser-agent.ts`, `packages/observability/src/`, and accounting consumers in eval/admin. Keep calculation in core.
- Focused adjacent tests, core README, and the docs paths listed in phase 6.

Do not change model answers, tool authorization, prompt construction, routing policy, provider credentials, or unrelated storage behavior as part of the accounting migration. Do not build a billing dashboard, payment processor, subscription manager, or tax engine. Do not change the default OpenAI API just to implement accounting. Support the existing Chat Completions, Responses, and Decisions paths.

### Repository conventions

Use TypeScript ESM, named exports, explicit `.js` relative imports where the repo uses them, two-space indentation, double quotes, and semicolons. Keep provider SDKs optional. Use the existing Zod runtime-validation pattern for external usage and catalog data. Keep the public `CostTracker` class/import. Use small pure functions within the module. Tests use Vitest; follow `packages/core/src/cost/__tests__/cost-tracker.test.ts` for structure, not its incorrect billing assumptions.

Future branch: `agent/core-cost-accounting`. Use small conventional commits. Do not run the release script, commit, push, or publish without the operator's instruction.

## 3. Current state and root causes

The following excerpts are from the reviewed commit. They are drift anchors, not target code.

`packages/core/src/models/openai-api.ts:731`:

```ts
const reasoningTokens = usage?.output_tokens_details?.reasoning_tokens ?? 0;
return {
  promptTokens: usage?.input_tokens ?? 0,
  completionTokens: usage?.output_tokens ?? 0,
  totalTokens: usage?.total_tokens ?? 0,
  ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
};
```

`packages/core/src/agent/llm-loop.ts:360` then changes the total:

```ts
totalTokens: totalPromptTokens + totalCompletionTokens + totalReasoningTokens,
```

`packages/core/src/cost/cost-tracker.ts:249–263` guesses missing prices and can charge reasoning twice:

```ts
const p = lookupPricing(usage.pricingKey ?? modelId, this.pricing);
if (!p) return emptyBreakdown();
const nonCachedPrompt = Math.max(0, usage.promptTokens - cachedTokens);
const output = (usage.completionTokens / 1000) * p.completionPer1k;
const reasoning = usage.reasoningTokens && p.reasoningPer1k
  ? (usage.reasoningTokens / 1000) * p.reasoningPer1k : 0;
// Missing cache price later falls back to prompt price * 0.5.
```

`packages/core/src/models/providers/anthropic.ts:438–444` uses exclusive ordinary input as if it were the inclusive prompt total. Its stream retains only `message_start.usage.input_tokens` at line 293. `aws-claude.ts` repeats this loss. `cohere.ts:232–237` reads the native v2 `usage` object at the wrong depth.

`packages/core/src/agent/agent.ts:836` records only after main execution and reflection finish:

```ts
const entry = this.config.costTracker.track({
  runId: ctx.runId,
  agentName: this.name,
  modelId: this.config.model.modelId,
  usage: sourceUsage,
  sessionId,
  userId,
});
```

This loses leaf identity and can lose already consumed usage when later work fails. `llm-loop.ts:196` finalizes the first finish chunk, `llm-loop.ts:631` keeps the latest usage, and `agent.ts:1109` adds every finish usage. These semantics conflict.

`packages/core/src/cost/cost-tracker.ts:57–58` discards entries above 10,000. Its budget and summary methods read only that array. `agent.ts:261` omits scope IDs during mid-run checks. `cost/types.ts` has no tenant, attempt, catalog version, cache-write quantity, or unknown-cost state.

`packages/observability/src/accounting.ts:199–208` deliberately replaces a run total:

```ts
const delta = value - target.cost;
target.cost = value;
this.totals.total_cost_usd += delta;
```

Do not change `cost.tracked` into per-attempt amounts while this contract exists.

### Existing behavior to preserve

- `events/event-bus.ts:63–78` isolates observer exceptions. Accounting must not undo this protection.
- OpenAI Chat Completions already waits for its usage-only stream tail in `models/openai-api.ts:749–758`.
- Handoff source cost is recorded before delegated usage is merged. Preserve one-charge-per-leaf behavior.
- Local structured-output parsing in `llm-loop.ts:379–387` does not make a repair request. Do not invent a charge for it.
- Explicit zero tariffs, such as a documented free output category, are valid.

## 4. Internal design

```text
Provider request attempt
  -> usage evidence + actual billing context
  -> versioned normalizer
  -> canonical usage + required billing measurements
  -> matching catalog rules
  -> exact charge calculation
  -> stored assessment
  -> budget settlement + run projections + observation events
```

Suggested internal layout; these are modules inside the existing package:

```text
packages/core/src/cost/
  types.ts                 Public records and interfaces
  usage.ts                 Validation and aggregation invariants
  measurements.ts          Meter definitions and coverage validation
  calculator.ts            Pure exact arithmetic
  catalog.ts               Deterministic rule matching
  catalog-data/            Reviewed provider/model rules and source metadata
  accounting.ts            Attempt recording and assessment lifecycle
  context.ts               Explicit accounting context propagation
  budget.ts                Decisions and reservation orchestration
  store.ts                 Optional UsageStore and BudgetStore contracts
  stores/in-memory.ts      Local implementation
  stores/sqlite.ts          Durable single-host implementation
  stores/postgres.ts        Durable shared implementation
  cost-tracker.ts           Public facade and compatibility projections
  pricing.ts                Deprecated legacy pricing bridge
  __tests__/                Fixtures and contract tests
```

Do not create a framework of empty classes. Start with pure functions and a small accounting coordinator. Provider normalizers should not import database drivers or fetch prices.

## 5. Canonical records

### Identity and context

Separate a logical operation from its actual request attempts.

- `operationId`: one requested activity, such as answering or creating embeddings.
- `attemptId`: one observable leaf provider request. Each retry gets a new ID.
- `parentOperationId`, `runId`, `rootRunId`, `parentRunId`: attribution without charging parent summaries.
- `tenantId`, `sessionId`, `userId`: trusted scope from execution context. Use a defined local namespace when tenant is absent.
- `providerRequestId`: provider evidence when available. It is not the only deduplication key.
- Requested route/model and actual provider/model/resource are separate.
- `billingProviderId`: who charges the account; distinct from wire-format compatibility and model author.
- `api`: Chat Completions, Responses, Decisions, Messages, Converse, GenerateContent, embeddings, speech, or a provider extension.
- Requested and actual service tier; reasoning mode and effort; region; context band inputs; cache duration; account price-plan identifier.
- Record provenance for context: response, request, documented default, configured contract, or unknown. Do not turn a missing returned tier into Standard without a verified default rule.
- No credentials, authentication headers, prompt text, or full responses belong in accounting context.

Each attempt has independent `executionStatus`, `usageStatus`, and `pricingStatus`. A successful answer can have unknown usage. A failed answer can have complete usage. Keep those states separate.

### Usage contract

The intended shape is additive to the old display fields during migration. The following illustrates the contract; implementation must define exact exported types and validators.

```ts
type TokenCount = number | null;

type CanonicalTokens = {
  input: {
    total: TokenCount;
    ordinary: TokenCount;
    cacheRead: TokenCount;
    cacheWrite: TokenCount;
    cacheWriteByTTL: Array<{ ttlSeconds: number; tokens: number }>;
  };
  output: {
    total: TokenCount;
    reasoning: TokenCount; // A diagnostic subset of canonical output.
  };
  total: TokenCount;
  providerReportedTotal: TokenCount;
};

type Measurement = {
  id: string;
  meter: string; // e.g. token.input, token.cache_read, token.cache_write
  unit: string; // token, request, second, character, image, token-hour...
  quantity: string | null;
  dimensions: Record<string, string>;
  source: "provider" | "derived" | "measured" | "estimated";
  evidencePaths: string[];
};
```

Token counts must be finite, nonnegative safe integers. Generic quantities and money use validated decimal strings. If a provider exceeds safe integer limits, reject unsafe conversion and record an invalid observation until supported; do not silently lose precision.

Required rules:

1. Canonical input includes ordinary input, cache reads, and cache writes. Canonical output includes reasoning. These definitions stay fixed across providers.
2. OpenAI output already includes reasoning. Google candidates and thoughts require the API's documented mapping into canonical output. Anthropic ordinary input needs reads and writes added to produce inclusive input.
3. Preserve the provider's total separately. If known canonical components disagree with it, record the discrepancy and retain evidence. Do not force equality by clamping values or inventing a residual charge.
4. Cache-write total and its TTL buckets describe the same tokens. Charge the detailed buckets OR the total, never both. Missing TTL split with different rates means that write charge is unpriced.
5. Modality fields and reasoning are often subsets. A text/audio split must partition its parent before separate rates can be applied. Independent cache and modality marginals do not establish their intersection; mark unknown cells instead of guessing.
6. Missing is `null`. A normalizer may use zero only when the provider contract for that API/version establishes zero or non-applicability.
7. Preserve a bounded, validated copy of raw usage and the safe billing metadata needed for replay. Do not copy a whole model response into the store. Mark truncation if storage limits prevent complete raw retention.
8. Store schema version, normalizer ID/version, and normalization issues. Renormalization creates a new revision.
9. Totals for heterogeneous operations are views. A sum of token counts from different models is a usage statistic, not a price input.

### How the charges array is produced

The adapter supplies measurements and a coverage declaration: known meters, required-but-unknown meters, and unsupported billing features. The price catalog selects the applicable rule for each required meter. The calculator then emits a charge or an explicit unpriced item.

```text
raw usage
  -> normalizer produces input/read/write/output measurements
  -> context and capabilities identify any extra required meters
  -> catalog resolves the rule for EACH meter
  -> calculator creates charges[] with rate and evidence
  -> assessment reports complete, partial, or unpriced
```

Do not price every numeric field in raw usage. Do not assume a missing array entry means the provider had no additional billable work. Preserve unknown additional fields and flag unknown billing semantics.

Each priced charge stores:

- measurement ID and meter, original quantity, billed quantity, unit, and dimensions;
- rule ID/version, catalog version, source URL, verified date, and effective interval if known;
- exact price amount, currency, price denominator, and any quantity rounding/minimum;
- amount before and after explicit adjustments, with the rules and order used;
- charge inclusion scope, so reported provider totals and child charges cannot both enter a total.

Each unpriced charge stores `amount: null` and a machine-readable reason such as `missing_usage`, `missing_rate`, `ambiguous_rate`, `missing_context`, `unsupported_rule`, or `invalid_usage`.

Assessment fields include `knownSubtotal`, `total` (null unless complete), `unpricedCount`, `pricingStatus`, and `basis`. A known subtotal must never be labelled the final total. Keep currencies separate; currency conversion requires a separately sourced FX assessment.

Assessments also declare their target (`attempt`, `billing_group`, or `account_period`) and finality (`provisional` or `final`). A fully priced partial session remains provisional. Attempt measurements that contribute to a group-priced meter are labelled contributions; they do not also produce independent payable charges for that meter.

### Worked example with reads and writes

These are synthetic quantities and rates for a fixture, not a current provider tariff.

Raw inclusive input is 15,000, including 12,000 read tokens and 2,000 written tokens. Output is 500, including 100 reasoning tokens. Total is 15,500.

| Meter | Quantity | USD per million | Amount |
|---|---:|---:|---:|
| Ordinary input | 1,000 | 10 | 0.010 |
| Cache read | 12,000 | 1 | 0.012 |
| Cache write | 2,000 | 12.5 | 0.025 |
| Output, including reasoning | 500 | 50 | 0.025 |
| **Total** | | | **0.072** |

The ordinary input measurement is `15000 - 12000 - 2000 = 1000`, only because this fixture's normalizer declares an inclusive input total with disjoint cache categories. The reasoning detail produces no additional charge.

```json
{
  "pricingStatus": "complete",
  "knownSubtotal": "0.072",
  "total": "0.072",
  "currency": "USD",
  "charges": [
    { "meter": "token.input", "quantity": "1000", "amount": "0.01" },
    { "meter": "token.cache_read", "quantity": "12000", "amount": "0.012" },
    { "meter": "token.cache_write", "quantity": "2000", "amount": "0.025" },
    { "meter": "token.output", "quantity": "500", "amount": "0.025" }
  ]
}
```

The stored charge also contains its full rate snapshot and evidence fields. If the write rate is missing, the known subtotal becomes `0.047`, total becomes `null`, and the write item becomes unpriced. If the write rate is explicitly zero, the assessment can remain complete.

For an Anthropic-shaped fixture with ordinary input 1,000, reads 12,000, writes 2,000, and output 500, the same canonical counts result without subtracting reads from ordinary input.

## 6. Pricing rules

### Match on billing facts

Use provider/biller, exact resource/model identity, API, effective time, account contract, actual tier, applicable mode, region, context size, modality, cache duration, and meter dimensions. A field can be ignored only when the rule explicitly applies to all values of that field.

Resolution order:

1. Applicable explicit account contract/override with version and scope.
2. Exact provider/resource/API rule.
3. Explicit reviewed alias or deployment mapping to a rule family.
4. No match: unpriced.

At the same precedence, overlapping matches are a catalog error. Never select the first rule by insertion order. Remove general substring matching. Do not infer Azure deployment prices from its arbitrary deployment name.

Rules declare their required context. Use inclusive per-request input to select a context band when that provider requires it. Distinguish whole-request band changes from marginal tiered pricing. Do not use run-aggregate tokens to choose a request's band.

### Supported rule forms

- Unit price: quantity × price / denominator.
- Block rounding: provider-defined rounding and minimum units, applied at the specified request/session/account scope.
- Whole-request bands and marginal tiers, represented separately.
- Fixed operation fee with an explicit billable occurrence.
- Duration/integrated storage price, with start/end or provider-reported resource-time quantity.
- Explicit adjustments limited to named charge IDs/categories and a documented order.
- Provider-reported monetary amount, with currency and included scope.

Use a small validated rule union and pure evaluators. Do not execute expressions from fetched JSON. A custom calculator extension is trusted application code, registered explicitly with an ID/version; its output must pass the same validation and provenance checks.

Use exact decimal or rational arithmetic throughout. Decide the library in phase 1, put it behind one internal helper, and declare any imported library as a direct core dependency. Do not rely on a transitive dependency. Round for provider rules or presentation only, not to cents on every tiny call.

Base quantities and tariffs are nonnegative. Represent refunds and credits as explicit signed adjustments with their own source and scope; do not smuggle them in as negative token counts or negative base rates. Record the evaluator's precision and rounding policy version. Division by a non-decimal denominator must have a specified rational or precision policy, with fixtures that reproduce the stored result.

### Fast, Ultrafast, Pro, and other modes

Store `requestedServiceTier`, `actualServiceTier`, `reasoningMode`, and `reasoningEffort` separately. Use a supported combination's own rules. For OpenAI's documented Fast downgrade, the actual returned default tier selects Standard rates. Pro's aggregate usage is counted once; no universal Pro multiplier. A separate Pro model ID uses its own rule.

Do not multiply hosted-tool charges merely because token prices have a speed premium. Record batch/flex/cache/modality/region compatibility as provider rules, including when combinations are unsupported. Missing actual tier can be priced only under a documented fallback/default with recorded provenance; otherwise it remains unpriced.

### Catalog maintenance

Ship a reviewed, versioned catalog inside core. Keep data separate from evaluators. No price fetch belongs on the model request path. Permit the application to supply a pinned catalog or contract override.

Every update requires source URL, retrieval/verification date, model/API scope, applicable dimensions, and fixtures. Keep `verifiedAt` distinct from `effectiveFrom`; retrieval time is not proof of a tariff's start date. Do not backdate a current tariff onto historical calls without an explicit approximation label.

Community datasets can identify candidate updates. Confirm supported billing rules against primary provider sources before marking coverage complete. Maintain a catalog validation command/test that detects overlapping rules, negative/invalid prices, missing denominators, unsupported dimensions, and invalid aliases. Expiry policy must be explicit: old rules are reproducible but may be stale, not automatically current.

### Costs that are not per-call prices

Taxes, credits, monthly commitments, provisioned throughput, subscriptions, and negotiated account adjustments can require account-period data. Store them as separate period assessments or adjustments with an allocation policy. Do not fabricate per-call token rates. Display list-price estimate, provider-reported charge, and reconciled invoice amount as separate views. Never add them together as independent costs for the same scope.

### Billing groups and rounding scope

Use a billing group when a provider rounds or applies a minimum across several observations. Its key includes tenant, billing account or resource, meter/rule identity, required grouping dimensions, and the provider-defined session or billing interval. Keep rate/effective-time boundaries explicit. Membership references observation IDs, so replay cannot add the same quantity again.

Accumulate the group's measurements first, then apply its minimum/rounding once. Use the latest selected snapshot per contributing attempt/resource interval or each unique delta, according to the normalizer contract; do not sum cumulative observations. Store group usage revisions, immutable assessments, and one selected assessment per view. Late observations create a new revision and replace the selected assessment through the same atomic projection transaction used for attempt corrections. They do not append another full charge to spend. Open groups are provisional; closed groups can still receive explicit corrections with retained history.

Example fixture: two distinct operations each report 20 seconds in the same session. The tariff charges USD 0.01 per started minute at session scope. Combined duration is 40 seconds, billed duration is 60 seconds, and the single selected group charge is USD 0.01. If the tariff instead rounded each request separately, the total would be USD 0.02. Test both, plus replay, late duration, and rule-boundary cases.

Account totals include the group charge once. Per-call/run attribution is a separate versioned allocation view, never another payable charge. Default to unallocated group cost when no allocation policy exists; affected call/run views disclose incomplete attribution. An optional duration-proportional policy can allocate USD 0.005 to each of the two calls. Allocations must sum exactly to the group amount with a deterministic remainder policy. Parent views use allocations OR the original group charge as appropriate, never both. Reservation bounds must include potential group minimums; uncertain open groups retain a conservative hold until settlement policy allows release.

## 7. Request lifecycle

Meter at the leaf adapter request boundary. Routing and fallback wrappers carry parent context; they do not create another spend row for returned child usage.

1. Allocate stable operation/attempt IDs. Persist a start intent when durable accounting is enabled.
2. Check budget policy; reserve if supported and required.
3. Submit the provider request.
4. Capture safe request/response identity and raw usage before validating model output.
5. Merge usage observations under that API's rules.
6. Normalize, assess, and settle the attempt even if output parsing, a later tool, or a hook fails.
7. Persist the selected assessment and budget settlement. Emit observation events afterward.
8. Return model output or the original execution failure. Accounting errors have a distinct type/status and cannot enter model retry classification.

Keep record creation outside the retry callback for completed provider work. A failed store write retries the write using the same attempt/assessment IDs. It must never repeat a successful model request. A pre-dispatch durable-store failure can prevent a new request; a post-response failure records an accounting warning and blocks later work only according to policy. Do not throw a generic retryable model error after receiving the answer.

### Retries and visibility

Agentium retries and SDK transport retries must have one clear owner. For built-in adapters, prefer configuring SDK retries off and using a common metered retry primitive with existing retry eligibility/backoff preserved. Verify each installed SDK first. Where transport hooks give reliable attempt events, they can be used instead.

Do not silently change retry counts during extraction. Add fixtures showing equivalent retry behavior and separate attempt records. For custom/opaque SDKs where internal attempts cannot be seen, record `attemptVisibility: "opaque"` and the observed invocation. Do not claim physical-request completeness. A timeout alone establishes neither zero charge nor confirmed charge.

### Streaming

Introduce an internal usage-observation contract with `kind: snapshot | delta`, a stream/attempt identity, and a stable sequence or event ID. Support field-specific cumulative updates where the API defines them. Snapshots replace prior values for the same measurement. Deltas add once. Stale/duplicate revisions do not change totals.

Finish of content is different from final usage. Read usage independently of text/tools. Finalize after the transport closes or reaches its authoritative terminal usage event. Preserve the last known partial usage if cancellation/error happens first. Missing final usage means partial/unknown, not zero.

Keep public stream compatibility through an adapter while migrating consumers. Do not delay tool safety decisions or execute incomplete tools just to obtain more usage. For long-running realtime sessions, settle per response/turn or resource interval, not only at disconnect.

### Operation tree and extra model work

Meter answer generation, reflection critics/revisions, compression, compaction, tool selection, tool-result summarization, memory jobs, team planning/synthesis, workflow model steps, and child agents. Carry explicit accounting context through helpers; do not put request-specific mutable state on a shared provider instance.

Optional async-local context can help carry context inside an execution, but public/custom-provider boundaries must support explicit context and isolated concurrent runs. A wrapper over an already-metered provider must detect the existing attempt and avoid another charge.

Sum selected attempt charges and applicable billing-group charges by distinct charge ID. Group contributions are not payable attempt charges. Parent views report `ownCost` and `inclusiveCost` where needed, plus completeness and unallocated group amounts. They are not payable entries. Background memory work can finish after the initial run result; expose snapshot/as-of metadata and an explicit `flush`/drain operation instead of presenting an immutable final total too early.

## 8. Storage model

Use these logical entities; implementations can store JSON with indexed columns.

| Entity | Identity and contents |
|---|---|
| Operation | `(tenantId, operationId)`; parent/run attribution, kind, purpose, safe requested context. |
| Attempt | `(tenantId, attemptId)`; operation reference, ordinal, start/end, execution state, actual identity, request ID. |
| Observation | `(tenantId, attemptId, observationId)`; sequence/kind, raw usage, safe billing context, time, evidence status. Immutable. |
| Usage revision | `(tenantId, attemptId, revision)`; observation references, schema and normalizer versions, canonical usage, measurements, issues. |
| Billing group | `(tenantId, billingGroupId)`; account/resource, rule/grouping key, interval, unique observation membership, usage revisions, open/closed state. |
| Assessment | `(tenantId, assessmentId)`; target kind/ID and usage revision, catalog/rule versions, charges, total/completeness/finality, purpose: original/reprice/reconcile. Immutable. |
| Selection | `(tenantId, targetKind, targetId, view)`; current assessment for an attempt, group, or account period. Never sums all revisions. |
| Allocation | `(tenantId, assessmentId, allocationPolicyVersion, targetOperationId)`; derived share of a group/period amount. A reporting projection, not new spend. |
| Budget reservation | `(tenantId, reservationId)`; applicable scope keys/period, attempt, reserved quantity, state, reconciliation/expiry policy. |

Store ISO UTC timestamps and decimal strings. Do not depend on `Date` instances surviving JSON storage. Scope all keys and queries by tenant. Use opaque account identifiers, never keys or secrets.

Minimum query access paths: tenant+attempt; tenant+run; tenant+rootRun; tenant+session+occurredAt; tenant+user+occurredAt; tenant+provider/model+occurredAt. Cursor paging is required. Separate distinct operation/run counts from entry/attempt counts.

### Store interfaces and implementations

Define optional `UsageStore` and `BudgetStore` in core. Do not add mandatory methods to every existing `StorageDriver`.

- `UsageStore`: append observation with duplicate/conflict result, append usage revision/assessment, atomically select a revision where supported, query by cursor, aggregate selected assessments, and report durability/capabilities.
- `BudgetStore`: atomic reserve-if-available across all applicable scope keys, settle, release when confirmed safe, query, and reconcile uncertain reservations.
- `InMemoryUsageStore`: default local operation, no restart durability; its history eviction must not lower active budget totals. Explicit budget periods bound retained aggregates.
- SQLite: first durable local implementation. Transactional observation/selection/projection updates and schema migrations owned by cost storage.
- Postgres: shared-worker implementation with unique keys and atomic budget reservations. Reuse optional SDK configuration patterns; no mandatory database dependency.
- Existing generic KV storage may provide an explicit limited archival adapter. It must declare no atomic shared budgets and must not claim full historical aggregation if listing/pagination/retention cannot be proven complete. Do not auto-enable it for strict budgets.

For shared reservation budgets, both interfaces must come from one transaction-capable accounting backend. Require an idempotent `commitAssessmentAndSettle` operation that inserts the immutable assessment, compares the expected selection revision, updates every affected scope projection, and settles applicable reservations in one transaction. Its key includes tenant, target kind/ID, assessment, and revision. Concurrent admission reads those same committed budget rows. Reject independently configured usage/budget backends for this mode; two successful individual writes do not provide atomic settlement. Separate archival stores are allowed only as downstream copies.

Use a duplicate key for repeated delivery of the same observation. Reusing the key with different content is a conflict, not a successful duplicate. A genuine model retry has a new attempt ID. Enforce revision ordering with transactions/CAS where supported; a stale snapshot cannot overwrite a newer selected assessment.

Append raw observations before deriving assessments in durable mode. If derivation fails, retain evidence for replay. A crash after provider acceptance but before a result can still leave unknown usage. Start intents and reconciliation expose that gap; they cannot guarantee the provider reports missing usage later.

Repricing creates a new assessment. Default reports continue to use the original selected assessment until an explicit view change. Never rewrite history simply because the bundled catalog changed. Invoice adjustments must preserve their original currency, scope, and evidence.

### Scale assumption

Design initially for local SDK use and a shared service storing up to roughly one million attempts per month. This is a planning workload, not a measured Agentium limit. At an assumed 4 KB per compact attempt plus observations/assessment, base data is about 4 GB per month before indexes and stream evidence. Keep final/meaningful usage observations, not text chunks. Bound raw usage size. Indexed paging and incremental projections are sufficient first steps; no queue cluster or sharding is justified by current evidence.

## 9. Budget behavior

Use ledger totals and unsettled reservations, not an evictable display cache or delayed telemetry exporter. Keys include tenant, scope type, scope ID, period, and currency.

Preserve run/session/user controls, and add explicit root-run or operation-tree scope for child work. Define time windows for cross-run budgets. Validate limits as finite nonnegative amounts; zero blocks charged work and is different from absent.

Return a typed decision: allowed, warned, or blocked, with scope, limit, known spend, reserved amount, and unknown usage/cost status. Honor warn/stop/throw consistently. Emit a real typed budget event if documented; do not invent an error class only in docs.

Two modes:

- **Threshold mode:** checks known/estimated spend before new work and after observations. Can exceed the threshold because accepted requests continue and usage may arrive late. Default unknown policy: warn and continue, with explicit incomplete accounting.
- **Reservation mode:** atomic admission using conservative per-operation bounds. Requires an atomic `BudgetStore` and a valid bound on applicable charges. Default unknown policy: block before dispatch. If no bound exists, reject reservation mode for that operation or require an explicit configured bound.

Reservation mode controls admission, not an unconditional provider invoice ceiling. Hidden provider work, changing contract terms, or unavailable usage can exceed estimates. Record overruns and uncertain reservations. Do not automatically release an expired reservation for an accepted request whose outcome is unknown; reconcile it or retain a conservative hold. `warn` does not stop execution.

Reserve all applicable limits atomically, or roll back entirely. Settle actual known spend once, using the same attempt/reservation identity. A crash/retry cannot deduct twice. Budget projection correction needs an atomic delta if a selected assessment changes. Reporting-only repricing must not silently change budget balances.

## 10. Compatibility and developer experience

Keep `import { CostTracker } from "@agentium/core"` and `AgentConfig.costTracker`. The improved facade adds explicit asynchronous methods such as `recordUsage`, `queryUsage`, `queryCosts`, and `flush`; pure `calculateCharges` remains usable without an agent or database.

Illustrative intended usage; names must be fixed in phase 1 before implementation:

```ts
const tracker = new CostTracker({
  catalog: reviewedCatalog,
  store: usageStore,
  budget: budgetPolicy,
});

const agent = new Agent({ name: "assistant", model, costTracker: tracker });
await agent.run("Explain the result", { sessionId: "s1", userId: "u1" });
await tracker.flush();
const costs = await tracker.queryCosts({ sessionId: "s1", view: "original" });
// costs.total is null when incomplete; costs.knownSubtotal is still usable.
```

Provide custom-adapter examples that report all four token categories, actual context, and unsupported meters. Provide custom tariffs with explicit cache-read and cache-write prices. The calculator must work with a caller-supplied catalog and no network.

### Migration decision

**Execution update, 2026-10-08:** The user approved implementation, checks, documentation, and release, then explicitly selected version **4.5.0**. This supersedes the major-version recommendation below. The implemented read-path and token-semantics changes are documented in the 4.5 migration guide and changelog. The original design recommendation remains here as review history.

Do not silently turn `track()` or `getSummary()` into promises. Do not silently change `cost: number` into a string or map unknown cost to zero to satisfy its old type.

Introduce canonical records/async methods additively while the old path is explicitly deprecated. Switch the default behavior only in a documented major release, because unknown-cost handling and ambiguous legacy token semantics are observable changes. The existing coordinated release system already versions packages together; a separate package is unnecessary.

At the major cutover:

- Keep legacy method names synchronous for local compatibility. They are projections for known complete data, not durable queries.
- Legacy `track()` requires documented legacy usage semantics or an explicit adapter mapping. Ambiguous reasoning/cache/modality input raises a typed compatibility error; do not guess.
- Legacy numeric cost projections can return finite numbers for complete known costs. Unknown or partially priced results require the canonical query API and raise a typed incomplete-cost error in the old projection.
- `getEntries()` remains a bounded local snapshot. `getSummary()` must not claim durable all-time coverage; reject unsupported queries and document snapshot scope. Canonical async queries serve durable history.
- Internal execution uses canonical methods and preserves successful provider results when accounting is incomplete. It does not route through legacy projection errors.
- Legacy model-price overrides are migrated to explicit API/provider scope and separate cache categories. A `reasoningPer1k` field alone cannot prove independent reasoning billing.

If a major release is not acceptable, ship the canonical engine behind an explicit opt-in and finish migration design before changing defaults. Do not weaken correctness to claim a patch-compatible full revamp.

### Events and consumers

Add explicit `usage.recorded`, `cost.assessed`, and `cost.budget.exceeded` events with stable IDs, revisions, scope, and completeness. Final naming belongs in the phase 1 contract.

Keep legacy `cost.tracked` as a replacement run-total projection for complete known amounts during migration. Do not emit an unknown amount as zero. New events carry incomplete results, and observability must expose their status. Update the built-in consumers to deduplicate IDs/revisions and avoid reading both old and new events as independent spend.

Parent spans can display inclusive totals while only selected payable attempt/group/period charges contribute to global spend. Allocations and parent summaries do not create more spend. Admin/eval/browser/observability must consume core results rather than calculate their own model prices.

## 11. Ordered build phases

### Phase 1 — Fix the contracts and build provider fixtures

Files: `cost/{types,usage,measurements}.ts`, `models/types.ts`, adapter normalizers, `cost/__tests__/fixtures/`, `models/__tests__/usage-conformance.test.ts` (new), `cost/__tests__/usage.test.ts` (new), and public type fixtures.

1. Define exact types, invariants, status unions, context provenance, and compatibility behavior from sections 5 and 10. Validate raw input with Zod. Define registered meter keys without closing the API to custom meters.
2. Add sanitized raw response/stream fixtures per API path. Include schema/SDK version and source reference. Use synthetic metadata where real captures are unavailable and label it. Never copy credentials or prompts from conversation history.
3. Implement pure provider normalizers. Preserve raw evidence. Fix Cohere nesting and Anthropic cache semantics. Give OpenAI Chat/Responses/Decisions distinct mappings. Treat cloud/gateway billers separately.
4. Add conformance checks for the complete adapter inventory below. No adapter is marked complete without fixtures.
5. Define desired legacy projections and pin them with public type fixtures. Do not replace existing live accounting until the new path is integrated.

Initial regression fixtures:

- OpenAI: input 19, output 16, reasoning 9, total 35. Canonical total stays 35, not 44.
- OpenAI: input 19, output 76, reasoning 64, total 95. Canonical total stays 95, not 159.
- OpenAI cache example: 15,000 inclusive input; 12,000 read; 2,000 write; 500 output.
- Anthropic: 1,000 ordinary + 12,000 read + 2,000 write; 500 output; mixed 5-minute/1-hour write buckets.
- Google: candidates and thoughts separate, cache read, reported total, modality details, tool-use fields, and any unexplained residual.
- Cohere: `usage.tokens` differs from `usage.billedUnits` and neither disappears.
- Missing counters, explicit zero, malformed/negative/unsafe counts, conflicting subsets, and unrecognized schema fields.

**Verify:** `npx vitest run packages/core/src/models/__tests__/usage-conformance.test.ts packages/core/src/cost/__tests__/usage.test.ts` → all contract fixtures pass.
**Verify:** `npx tsc -p packages/core/tsconfig.json --noEmit --pretty false` → exit 0.

### Phase 2 — Record attempts at the provider boundary

Files: `cost/{accounting,context}.ts`, built-in provider request/retry paths, `models/{provider,fallback-provider,model-router}.ts`, `agent/{agent,llm-loop,reflection,run-context,execution-services}.ts`, and scoped direct-call sites.

1. Add an explicit accounting context and common metered invocation primitive. Ensure shared provider instances are safe for concurrent tenants/runs.
2. Meter leaf requests, preserve actual identity, and define retry ownership per SDK. Retain existing cancellation/routing/tool behavior. Distinguish transport attempts from opaque invocations.
3. Capture usage before output validation. Preserve available usage on failed/incomplete responses, parsing errors, cancellation, and late hook/tool failures.
4. Introduce stream observations; unify snapshot/delta handling and finalization. Preserve the existing OpenAI tail behavior.
5. Route reflection, compression, context compaction, tool selection/summaries, memory and team/workflow calls through the same boundary. Tag each operation purpose.
6. Derive run outputs from distinct canonical attempts. Remove generic prompt+completion+reasoning reconstruction and final-run charging in the new path. Keep each raw usage record; do not retain only the final providerMetrics object.
7. Preserve source/child distinctions for handoffs, subagents, and background jobs. Parent totals must not create charges.

Direct-call inventory to resolve, in addition to `agent/` and provider files:

```text
compression/compression-manager.ts
context/context-compactor.ts
tools/tool-router.ts
memory/curator.ts
memory/stores/{summaries,graph-memory,entity-memory,user-profile,
  learned-knowledge,user-facts,procedure-memory}.ts
graph/retriever.ts
team/team.ts
workflow/step-runner.ts
```

These paths are under `packages/core/src/`. Re-run the direct-call search and classify every remaining production match; either it uses the new context/boundary or it has an explicit unmetered/opaque capability explanation.

**Verify:** `rg -n '\.(generate|stream)\(' packages/core/src/agent packages/core/src/memory packages/core/src/compression packages/core/src/context packages/core/src/tools packages/core/src/team packages/core/src/workflow packages/core/src/graph` → reviewed inventory with no unexplained bypass.
**Verify:** `npx vitest run packages/core/src/cost/__tests__/accounting-lifecycle.test.ts packages/core/src/events/__tests__/execution-observers.test.ts packages/core/src/agent packages/core/src/models` → all pass, including duplicate snapshots, final usage after finish, failed hooks, two retries plus fallback, and parallel tenant isolation.
**Verify:** `npx tsc -p packages/core/tsconfig.json --noEmit --pretty false` → exit 0.

### Phase 3 — Build the catalog and charge calculator

Files: `cost/{calculator,catalog,pricing}.ts`, `cost/catalog-data/`, new exact-arithmetic helper, focused cost tests, core dependency manifest if needed.

1. Implement unit/block/band/fixed/adjustment rule variants and validation. Use exact arithmetic and one explicit rounding policy per applicable rule. Define request versus billing-group evaluation; do not apply a session minimum independently to each attempt.
2. Implement exact rule matching, scoped overrides, explicit aliases, effective dates, and required-context validation. Reject ambiguous matches.
3. Generate charges from measurements and the adapter's required-meter coverage. Make unknown rates/quantities visible. Include cache reads and writes in public examples.
4. Seed reviewed rules for the supported model/API combinations. Check current official provider contracts, including latest OpenAI modes and each major provider's cache rules. Support endpoints separately, including Decisions and cloud deployments. Do not call a model just to retrieve a price.
5. Preserve provider-reported costs with inclusion scope and provenance. Separate them from estimates and period adjustments.
6. Add catalog update validation and explicit version pinning. Remove fuzzy price matching and guessed cache discounts from the new engine.

Required fixtures: the `0.072` four-category example; missing write price yields `total: null` and `knownSubtotal: 0.047`; explicit zero tariff; snapshot `o3-mini` never resolves to `o3`; ambiguous alias; Fast requested but Standard returned; Pro without double usage; missing tier; context threshold at/below/above boundary; mixed cache TTL; modality/cache intersection unknown; fixed search fee; duration rounding; unit mismatch; overlapping modifiers; stale/historical rates; custom account override; multiple currencies kept separate.

**Verify:** `npx vitest run packages/core/src/cost/__tests__/calculator.test.ts packages/core/src/cost/__tests__/catalog.test.ts` → all pass with exact decimal string assertions.
**Verify:** `npx tsc -p packages/core/tsconfig.json --noEmit --pretty false` → exit 0.

### Phase 4 — Add durable accounting and budgets

Files: `cost/{store,budget,accounting,cost-tracker}.ts`, `cost/stores/`, scoped integration in Agent/run context and event definitions, focused storage/budget tests.

1. Implement in-memory observation/revision/assessment stores and distinct totals independent of the display-entry cache. Define periods and retention.
2. Implement SQLite and Postgres stores with versioned schema migrations, unique keys, paged queries, and selected-assessment projections. Match existing optional SDK loading conventions. Do not force database setup for local users.
3. Prove idempotent duplicate delivery, conflicts on reused IDs with different data, monotonic revisions, and replay after derivation failure. Implement billing-group membership and revision selection; verify the two-20-second-observations fixture, late observations, and exact non-duplicating allocation views.
4. Implement typed threshold budgets for all scopes. Pass tenant/session/user/root-run context. Honor warning mode and zero limits.
5. Implement optional atomic reservations, transactional assessment-selection/settlement, uncertainty reconciliation, and concurrent admission tests. Reject strict/shared mode on a store without the required capability or when usage and budget interfaces use independent backends. Inject a crash between each conceptual settlement update; all updates must commit together or none may commit.
6. Inject store failures before submission and after provider response. Demonstrate that only accounting is retried after a successful provider operation. Preserve original execution errors.
7. Add explicit reprice/query views. Old assessments remain accessible; reporting repricing never changes spend twice.

**Verify:** `npx vitest run packages/core/src/cost/__tests__/store.test.ts packages/core/src/cost/__tests__/budget.test.ts packages/core/src/cost/__tests__/accounting-lifecycle.test.ts` → all local tests pass, including >10,000 entries, zero/warn limits, replay, crash states, and uncertain usage.
**Verify:** a new `cost/__tests__/store.integration.test.ts` suite against disposable SQLite/Postgres stores must pass restart, migration, isolation, idempotency, and two-worker reservation races. Define an explicit test environment variable such as `AGENTIUM_COST_POSTGRES_TEST_URL` in the implementation; never run against a user's live database. This is a planned new harness, not an existing command guarantee.
**Verify:** `npx tsc -p packages/core/tsconfig.json --noEmit --pretty false` → exit 0.

### Phase 5 — Extend coverage beyond ordinary model calls

Files: usage-producing boundaries under `vector/embeddings`, `rerank`, `voice`, `vision`, `telephony`, `toolkits`, and the browser consumer. Cost rules remain under core cost modules.

1. Add optional accounting context/sink to embedding and reranking calls. Keep their normal vector/result return shapes. Capture provider usage before discarding other response data.
2. Preserve realtime response IDs, modality/cache detail, event semantics, and terminal status. Settle per response/interval. Integrate STT/TTS character, duration, and token meters with source labels.
3. Capture image-generation usage plus model, size, quality, count, and any billed token quantities. Request count is an estimate until provider billing rules establish what was charged.
4. Provide a public custom-operation recording API for paid tools, search, sandbox compute, storage intervals, and external adapters. A tool execution alone is not proof of a particular fee. Accept namespaced meters and registered normalizers/calculators.
5. Inventory every built-in paid toolkit. Mark each as supported, partially supported, explicit free, or unmetered. Add provider-specific mappings when billing evidence exists. Unknown tools remain visibly uncovered; do not estimate from arbitrary wall time or text length.
6. Integrate BrowserAgent and native Voice/Vision through core accounting. Use proper run/operation IDs and the same budget policy. Parent processes consume core events, never duplicate price math.
7. Distinguish cache resource creation/storage duration from per-call cache reads. Background resource costs can have a resource/period parent instead of a model-call parent.

**Verify:** `npx vitest run packages/core/src/cost/__tests__/operation-meters.test.ts packages/core/src/vector/embeddings packages/core/src/rerank packages/core/src/voice packages/core/src/vision packages/browser/src` → all applicable fixture suites pass with mocks/loopback fixtures and no live provider credentials.
**Verify:** `npm run build:core` followed by `npx tsc -p packages/browser/tsconfig.json --noEmit --pretty false` → exit 0. Build is a future implementation gate, not part of this review.

### Phase 6 — Migrate consumers, documentation, and release contracts

Files: core exports/README/compatibility facade, observability consumers/tests, relevant eval/admin consumers, docs pages below. No package extraction.

1. Publish exact API names/types, async lifecycle, scope defaults, error policy, and coverage matrix. Keep sync APIs sync and clearly limited. Pin major-release migration decisions before default cutover.
2. Add call/assessment events and retain the run-total legacy event contract. Prove equal run totals without counting both event streams. Track completeness and unpriced counts in observability.
3. Replace incorrect test expectations with provider-contract fixtures. Keep old supported complete-cost consumers compiling and document expected errors for ambiguous/incomplete legacy inputs.
4. Update docs and generated references together. Explain input/read/write/output with real formulas, actual service tier, Pro behavior, context/cache TTL/modality rates, retries, failures, storage, and budget limits.
5. Remove unsupported claims of universal accuracy, nonexistent budget events/errors, and universal cross-agent auto-stop. State named provider/API/version coverage and limitations.
6. Run final package/type/fixture gates, review the public diff, and update `plans/README.md`. No release command is part of this plan's execution without separate authorization.

Docs update set under `/Users/xerycks/Xhip/agentium-docs`:

```text
cost/overview.mdx
features/cost-autostop.mdx
examples/cost-observability.mdx
api-reference/core/{cost,models,storage}.mdx
storage/overview.mdx
observability/{overview,exporters}.mdx
performance.mdx
```

Follow the docs repo's generation/check workflow; do not hand-edit generated references without updating their source.

**Verify:** `npm run build` → all packages build.
**Verify:** `npm test` → all tests pass; any pre-existing failure must be identified separately.
**Verify:** `npm run test:package` → packed ESM/CommonJS/type consumers pass.
**Verify:** `npx biome ci .` → exit 0.
**Verify in docs repo:** `npm run check`, `npm run check:api`, `npm run check:examples`, `npm run check:imports`, and `npm run validate` → exit 0. These scripts exist in the reviewed docs manifest; their current baseline was not executed.

## 12. Adapter acceptance matrix

Every row needs non-stream, stream where supported, missing usage, cache behavior, identity, and failure coverage appropriate to its API. Shared code can share fixtures only when the billing contract actually matches.

| Paths | Required distinctions |
|---|---|
| OpenAI Chat, Responses, Decisions | Inclusive output/reasoning; read/write; actual mode/tier; endpoint rules; failed/incomplete usage. |
| Azure OpenAI, Foundry | Deployment/resource mapping, biller, region, API schema; never price by deployment substring. |
| Anthropic, AWS Claude | Exclusive input; cache read/write and TTL; initial stream usage; inclusive output; hosted-tool meters where exposed. |
| Bedrock Converse | Metadata-after-stop; actual identity/region; cache details. |
| Google, Vertex | Candidates/thoughts, reported totals, modalities, cache, tool-use detail, metadata-only events. |
| DeepSeek, xAI, Meta/custom compatible | Versioned provider-specific billing mappings; unknown gateway pricing explicit. |
| Mistral, Perplexity, Cohere | Native versus compatible schemas; billed units and extra fees; late usage and duplicate terminal events. |
| Ollama, JEV | Explicit free versus missing price; retained duration/usage; exact model identity. |
| Vercel v0 adapter | v0 API contract; do not substitute Vercel AI SDK semantics merely because of the name. |
| Custom adapter | Normalizer/meter/context registration, partial capabilities, conformance helper, opaque retries. |

Reference implementations to learn from, not copy blindly:

- [Vercel AI SDK usage shape](https://github.com/vercel/ai/blob/main/packages/provider/src/language-model/v3/language-model-v3-usage.ts): cache-read/write distinctions and raw evidence.
- [T3 Code pricing implementation](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/usage/usagePricing.ts): pure calculation and speed/category breakdown. Its documented approximations are unsuitable as silent default billing rules here.
- [Mastra pricing model](https://github.com/mastra-ai/mastra/blob/main/observability/mastra/src/metrics/pricing-model.ts) and [TokenCostControl](https://mastra.ai/reference/processors/token-cost-control): scoped policy and separation of pricing; async metric-based budgets have acknowledged lag.
- [OpenAI caching](https://developers.openai.com/api/docs/guides/prompt-caching), [Fast](https://developers.openai.com/api/docs/guides/fast-mode), [reasoning](https://developers.openai.com/api/docs/guides/reasoning), [Anthropic caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), and [Google usage metadata](https://ai.google.dev/api/generate-content#UsageMetadata): provider-specific normalization evidence. Refresh at implementation time.

## 13. Final acceptance criteria

All of these must be demonstrated before the canonical path becomes the default:

- [ ] The 19/16/9 OpenAI fixture produces 35 total tokens and one output charge.
- [ ] Every cache example includes separate read and write quantities/rates; TTL buckets never duplicate their total.
- [ ] Inclusive reasoning/audio/modality details cannot be charged twice.
- [ ] Missing usage/rates/context never become an apparently complete zero charge.
- [ ] Exact identity and explicit aliases replace substring guessing.
- [ ] Tier, context band, region, cache duration, API, effective time, and account overrides select reproducible rules.
- [ ] Every observable retry/fallback leaf has its own attempt; opaque retries are labelled.
- [ ] Failed hooks, tools, parsing, and cancellation retain completed/partial provider evidence.
- [ ] Repeated snapshots replace; unique deltas add; late usage and post-finish failure are handled.
- [ ] Auxiliary model calls and supported non-model operations appear in the operation tree.
- [ ] Parent totals equal their selected distinct charges or allocated shares, with matching completeness; group charges and their allocations are never both added.
- [ ] Session/account minimums and rounding occur once per billing group. Replay and late observations revise its selected assessment without duplicate spend.
- [ ] Durable replay and duplicate delivery do not duplicate charges or budget settlements.
- [ ] Eviction does not lower budget totals; durable restart preserves them; tenants remain isolated.
- [ ] Warning mode continues; zero limits are enforced; shared reservation races are atomic.
- [ ] Accounting failure after a successful provider call never triggers another provider call.
- [ ] Original assessments remain reproducible after a catalog update or repricing.
- [ ] Legacy events remain replacement run totals; canonical consumers do not double-read both streams.
- [ ] Public migration, capabilities, and docs match executed fixture results.
- [ ] No additional Agentium package or external accounting service was introduced.
- [ ] Phase commands and package checks have results recorded in the implementation review.

## 14. Stop conditions and maintenance

Stop and report a specific design conflict if:

- Current source differs enough that the identified lifecycle or public API no longer exists.
- A provider contract contradicts the planned inclusive/exclusive mapping and cannot be resolved from authoritative documentation/fixtures.
- A supported SDK hides attempts and offers neither retry control nor a usable transport hook. Expose opaque visibility; do not invent attempts.
- A storage backend cannot guarantee capabilities advertised by the chosen budget mode.
- A legacy consumer requires unknown cost to remain zero or depends on double-counted totals. Use the documented major migration boundary rather than hiding the change.
- An implementation step needs unrelated model/tool behavior changes or a new external service.
- A verification failure cannot be explained after two focused correction attempts; preserve evidence instead of weakening the test.

Reviewers should check normalization semantics before arithmetic, leaf identity before aggregates, and unknown coverage before totals. New provider features require a normalizer/capability update, pricing evidence, and fixtures. New billing units require an explicit meter and applicable rule, not another special case in the Agent loop.

The weakest remaining part of this plan is external billing evidence for opaque/custom adapters and account-level contracts. Improve it by adding real sanitized provider fixtures and documented billable-unit mappings. Keep those combinations partial/unpriced until that work is complete.
