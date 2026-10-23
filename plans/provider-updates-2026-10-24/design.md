# Current provider support after Agentium 4.10.0

Status: proposed design for implementation planning; no product changes authorized by this document.

Baseline: `80e0874fc12c70c774e769992c1536a970f8d247` / released `v4.10.0`.
Requested outcome: turn the [October 24 landscape report](../ai-landscape-2026-10-24.md) into a practical sequence of compatibility, accounting, and Decisions improvements.

## Intent and delivery order

Keep existing applications working with current providers, report costs using supported billing contracts, and expand the existing Decisions integration. Deliver three independently reviewable increments:

1. Gemini 4 Argon request compatibility and current-model migration guidance.
2. Current accounting corrections, starting with Decisions cache billing.
3. Decisions GA evidence and question support.

These are proposed engineering decisions, not preferences supplied by the user. Implement within the existing TypeScript SDK, Zod validation, Vitest tests, and provider adapters. Do not build a general model registry or replace the accounting architecture.

## What the code check changed

- `models/thinking-replay.ts` chooses level-based thinking only for Gemini 3; Argon currently takes the older token-budget branch. Its sampling cleanup also matches only Gemini 3.8+.
- `models/providers/google.ts` already supports cancellation, request ownership, function calls, and signed conversation parts. Preserve these paths.
- `cost/catalog-data/reviewed.ts` already contains GPT-6.1 Sol, Haiku 5.5, Sonnet 5.5 cache rates, and long-context bands. The older `cost/pricing.ts` is a separate compatibility API; missing modern entries there do not justify duplicating complex tariffs into it.
- The reviewed catalog lacks Sol Ultrafast and Argon entries. `usage-normalizers.ts` still rewrites Decisions measurements to inclusive input only, while the GA documentation now charges cache writes and discounts reads. Correcting that billing contract is substantive work.
- The installed OpenAI 7.30.0 Decisions declarations cover beta inputs only. GA support needs a verified SDK transport path, not a type assertion over beta declarations.
- MCP v2 and skill snapshots are already released. Their regression checks belong in verification; implementing them again is outside scope.

## Global constraints

- Runtime support stays `^22.18.0 || ^24.11.0`.
- Preserve existing provider constructors, question strings, answer shapes, cancellation, retry ownership, and stored ledger records.
- Preserve explicit caller token limits and timeouts; do not silently raise spending limits or change default models.
- Unknown billing facts or unsupported tariffs produce an incomplete/unpriced result, never a guessed zero cost.
- New price rules require a primary source URL, verification timestamp, exact model/API/billing dimensions, and a reviewed effective interval.
- No live model requests are required to write this plan; implementation tests use deterministic fixtures by default.
- Do not tag, publish, deploy documentation, or change package versions during implementation without a release instruction.
- No new production dependencies are planned. Any required optional SDK floor must be verified and documented for the affected feature rather than broadly breaking older supported providers.

## Increment 1: Gemini request compatibility

Use the existing GenerateContent adapter. Background Interactions and automatic long-decode continuation are separate future work.

For the exact known model family `gemini-4-argon` (including documented version suffixes):

- Map enabled reasoning to `thinkingConfig.thinkingLevel`: `low` -> `LOW`, absent/`medium` -> `MEDIUM`, and `high`/`xhigh`/`max` -> `HIGH`. Reject `none`/`minimal`, `reasoning.enabled: false`, and `budgetTokens` before network access because these do not describe Argon's three supported levels. Omitting reasoning leaves the provider default intact. Do not change Gemini 2.5/3 behavior.
- Remove `temperature` and `topP`, matching the provider's documented behavior. Do not expand this rule to unknown future Gemini families.
- Reject explicit `cachedContent` with an actionable explanation; implicit caching remains available.
- Keep explicit `maxTokens` unchanged. For this first increment, reject Argon values above 65,536 rather than activating SDK-owned continuation. If a response advertises continuation, surface an actionable unsupported-continuation failure with available usage retained; never report a partial answer as a completed response. This keeps additional physical requests and their budgets outside this change.
- Test both generate and stream through the installed SDK against local HTTP fixtures, as well as helper-level mapping tests. Maintain thought signatures and function-call/result pairing through the next turn.
- Record requested and returned model identities using existing billing context fields. Preserve real response identities; do not rewrite request model IDs as a migration shortcut.

Document Google's old-model reroutes and the retired research-agent name, with primary sources. User applications select replacement models explicitly. Do not add a research-agent API in this increment.

## Increment 2: accounting corrections

Keep `REVIEWED_PRICING_CATALOG`, `normalizeProviderUsage`, `calculateCharges`, and existing ledger/versioning mechanisms authoritative. Do not add modern complex contracts to `DEFAULT_PRICING` merely to make its legacy API accept them.

### Decisions

For the newly verified GA contract, derive payable ordinary input as `input_tokens - cached_tokens - cache_write_tokens`; price reads and writes separately; output remains nonpayable. Preserve inclusive display counts and raw usage. Missing or inconsistent partitions remain incomplete/invalid instead of assuming zero cached tokens. Bump the affected normalizer evidence version.

At standard global rates, 1,000 input tokens containing 800 reads and 100 writes have 100 ordinary tokens and cost `0.0000305` USD: input `0.1`, reads `0.01`, writes `0.125` per million; output is free. Apply long-context and supported regional factors once.

The change must not mutate stored assessments or imply that the GA contract applied at an undocumented historical instant. Keep existing persisted evidence interpretable. Give new rules a verified start timestamp; do not infer an effective timestamp from a date-only announcement. Explicit historical reprocessing is a separate, user-directed operation. Update the existing test that currently expects inclusive-input billing.

### Model prices and aliases

- Retain already-correct Sol, Haiku, and Sonnet rules; add only verified missing combinations. Sol Ultrafast uses the documented 6x Standard multiplier; current Sol docs also allow supported regional processing. Do not change Astra regional support based on Sol documentation.
- Add Argon Standard global paid text rates only for the first increment's GenerateContent path, including ordinary input, implicit cache reads, and output including reasoning. Introductory rates are `2 / 0.1 / 10` USD per million until the documented transition to `4 / 0.2 / 20` on December 1. Verify the provider's precise billing cutoff before encoding the boundary; absent a precise cutoff, expire the introductory rules conservatively and leave the uncertain interval unpriced. Do not invent a paid explicit-cache-write product or enable Interactions/Batch/Flex/Priority tariffs as part of this adapter change.
- Check 272,000/272,001 Sol input-token and 100,000/100,001 Haiku boundaries, cache-write TTLs, and requested versus actual service tiers.
- Check Google and DeepSeek requested/returned model identity through generate and stream. Add an alias only where official billing evidence establishes the exact provider, endpoint and destination tariff; otherwise keep an unpriced result. Do not assign an arbitrary retired name the latest model's historical rate.
- Preserve contract-specific pricing precedence, unknown-model failures, and catalog staleness behavior. Record source verification separately from the service's actual price-effective date. Do not refresh all old rules' timestamps or extend the whole catalog's validity without rechecking those rules.

## Increment 3: Decisions GA support

Extend the existing adapter, preserving `openaiDecisions()` and `DecisionQuestion[]` behavior. Continue rejecting tool definitions: analyzing prior tool calls does not execute actions.

### Public API decisions

Keep generic `ChatMessage` and `ContentPart` unchanged. Add an explicit native entry point to `OpenAIDecisionsProvider`:

```ts
evaluate(input: DecisionInputItem[], options?: OpenAIDecisionsEvaluateOptions): Promise<ModelResponse>
```

`generate(messages, options)` converts existing chat messages, then calls the same validated request path. `stream()` keeps its existing completed-JSON/finish behavior; it does not pretend the endpoint streams individual answers.

Define/export `DecisionJSONValue`, `DecisionInputPart`, `DecisionInstructionPart`, `DecisionInputItem`, and `OpenAIDecisionsEvaluateOptions` from core. Keep these types independent of an optional SDK's public types. Use the official wire field names. The native input union covers:

- user text, images, or `input_json` object/array evidence;
- text-only system/developer messages;
- assistant output text or refusals;
- function calls (`call_id`, `name`, JSON-encoded `arguments`) and custom calls (`call_id`, `name`, string `input`);
- their matching outputs, as text or text/image parts.

Question `instructions` becomes `string | DecisionInstructionPart[]`, with nonempty arrays of text/image parts. Existing string questions remain valid. Native JSON/custom-call evidence is available through `evaluate`; normal Agent calls retain text/image chat input and function-call history without a framework-wide JSON content type change.

`OpenAIDecisionsEvaluateOptions` contains optional `questions`, `signal`, `apiKey`, `promptCacheKey`, and `promptCacheOptions: { mode: 'explicit' }`. Questions and cache defaults can also be set on `OpenAIDecisionsConfig`; per-call supplied values replace constructor values. Explicit breakpoints are allowed on supported shared text/image parts only; default implicit caching needs no extra request setting. TTL customization, voice integration and organization administration are deferred.

### Validation and conversion

- Accept 1–400 questions, keep unique names and distinct choice values, and preserve refusal handling and fractional scores.
- Preserve real message roles instead of embedding role labels in user text. Maintain tool call order and `call_id` linkage across the combined history; reject orphan/duplicate outputs and invalid roles before sending. Do not import opaque foreign-provider replay as Decisions evidence.
- Accept supported inline images and HTTP(S) image URLs. Agentium does not fetch remote images itself. Reject other schemes, audio, files, references, and JSON in non-user roles.
- Validate finite, JSON-safe values; reject circular values and unsupported members instead of lossy stringification. Keys named `role` or `image_url` inside JSON remain data.
- Count the 128-image limit across input, tool outputs, and question instructions together; verify this limit against the create reference at implementation time and update fixtures if the documented limit changes.
- Validate answers and capture usage on both successful and unusable responses, preserving current `ModelUsageError` accounting and cancellation behavior.

### SDK compatibility decision

Prefer the current supported OpenAI SDK's GA declarations after inspecting a published version. If upgrading the Decisions-specific floor is needed, record and enforce that exact floor with an actionable error and keep generic OpenAI peers unchanged. If no published SDK exposes the GA shape, use the existing SDK's documented generic `post` method for `/decisions`, with Agentium-owned validated request/response types; retain `maxRetries: 0`, authentication/baseURL overrides and abort signals. Do not hand-roll a second HTTP/retry stack or cast a GA request to beta types. This conditional is a bounded transport implementation choice, not permission to omit GA inputs.

## Verification and delivery

Each increment includes a failing behavior test, minimal implementation, focused green run, and its own reviewable commit. Provider HTTP fixtures must exercise actual request serialization; helper mocks alone cannot establish SDK compatibility.

Before claiming the combined change complete: workspace build, source/test TypeScript checks after build, Biome, full Vitest suite with `VITEST_MAX_WORKERS=2`, release-script tests, and packed-consumer checks. Include existing MCP v2 and native-recovery suites; do not add duplicate tests for unchanged features.

Documentation: update `packages/core/README.md` with each increment. Update matching pages in `/Users/xerycks/Xhip/agentium-docs` after reading its `AGENTS.md`, in separate documentation commits; publication of that site is outside this request. The execution plans name those pages.

Optional credentialed smoke tests may substantiate real endpoint access during implementation. Record model ID, SDK version, request shape, finish status and usage, with secrets and prompt content excluded. If not run, explicitly distinguish fixture coverage from live-service verification. Do not run broad benchmarks or change model-routing defaults.

No version is assigned yet. Accounting/request fixes could qualify for a patch, but additive native Decisions support calls for a minor release under normal semver. Select the next available version when release work is authorized; do not alter the published 4.10.0.

## Separate future decisions

Background Interactions, long-decode continuation, managed agent APIs, GPT-Live integration, automatic routing/default changes, Mistral preview expansion, and DeepSeek Search/Fetch need their own use cases and execution contracts. Track Skills governance and preserve released interoperability; do not implement proposed standards before publication.

## Primary sources rechecked on October 24

- [Decisions GA guide](https://developers.openai.com/api/docs/guides/decisions): evidence, questions, caching and billing.
- [Decisions create reference](https://developers.openai.com/api/reference/resources/decisions/methods/create): wire schemas and limits.
- [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol): supported tiers, reasoning and pricing factors.
- [Argon migration](https://ai.google.dev/gemini-api/docs/latest-model): supported reasoning, cache and sampling behavior.
- [Argon model](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon): capabilities and token limits.
- [Google prices](https://ai.google.dev/gemini-api/docs/pricing): Argon rates and scheduled changes.
- [Google long decode](https://ai.google.dev/gemini-api/docs/generate-content/long-decode): multi-request semantics and SDK floors, excluded from the first increment.
- [Haiku 5.5](https://www.anthropic.com/claude-haiku-5-5): existing price-band check.
- [DeepSeek API](https://api-docs.deepseek.com/): currently served model and retired aliases.
