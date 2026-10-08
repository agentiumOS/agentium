# Cost tracking review

Reviewed on 2026-10-08 against Agentium `f192926` and docs `52af1a5`. All source paths below are relative to the Agentium repository unless labelled `agentium-docs`. Source code was not modified. No tests, builds, installs, or live model calls were run for this review.

## Conclusion

Keep the module in core. Replace the flat token-to-price path with an accounting flow that preserves provider evidence, normalizes usage, selects documented rates, and stores each assessment. The largest risk is losing or changing usage before the calculator receives it.

## Confirmed findings

Effort: S = hours, M = roughly a day, L = multiple days including fixtures and integration. Risk describes the implementation change. Confidence is high unless qualified.

| ID | Finding and impact | Evidence | Priority / effort / risk |
|---|---|---|---|
| F01 | OpenAI reasoning is included in output but added again to run totals and some costs. The generic formula does not fit Google's different breakdown. | `models/openai-api.ts:731`; `agent/llm-loop.ts:360,477,520,747`; `cost/cost-tracker.ts:257–258` under `packages/core/src/` | P1 / M after contract / high |
| F02 | Anthropic ordinary input excludes cache reads/writes. Agentium treats it as inclusive, subtracts reads again, and omits writes. AWS Claude omits cache categories. | `models/providers/anthropic.ts:438–444`; `models/providers/aws-claude.ts:370–374`; `cost/cost-tracker.ts:252–264` | P1 / M / medium |
| F03 | Cohere native v2 non-streaming reads the wrong nesting and reports zero. Streaming drops billed units. | `models/providers/cohere.ts:232–237,159–168`; installed `cohere-ai/api/types/Usage.d.ts:3` has separate `tokens` and `billedUnits` | P1 / M / medium |
| F04 | Stream consumers use first, latest, or summed finish usage. Anthropic drops cache fields at message start; Bedrock has finish before usage; Google/Vertex/Mistral can skip usage-only events. | `agent/llm-loop.ts:196,631`; `agent/agent.ts:1109`; `models/providers/anthropic.ts:270,292`; `aws-bedrock.ts:177–186`; `google.ts:192`; `vertex.ts:187`; `mistral.ts:125` | P1 / L / high |
| F05 | Prices use exact match then unrestricted substring/prefix matching. `o3-mini` snapshots can match `o3`. Unknown models return zero and missing cache rates get an invented 50% discount. | `cost/pricing.ts:19–21,92–102`; `cost/cost-tracker.ts:249–264` | P1 / M / medium |
| F06 | Core tracks a completed run aggregate at the configured model price. Router/fallback leaf identities and retry attempts are hidden. | `agent/agent.ts:833–843`; `agent/llm-loop.ts:162`; `models/fallback-provider.ts:23,52`; `models/model-router.ts:89,138`; `models/providers/openai.ts:63` | P1 / L / high |
| F07 | Successful usage can be lost if later hooks, tools, or revisions fail. Failed/incomplete Responses output throws before usage is retained. Cancelled runs can return zero. | `agent/llm-loop.ts:325`; `agent/agent.ts:963–968`; `models/openai-api.ts:643–650,895–896`; `models/providers/openai-decisions.ts:114` | P1 / L / high |
| F08 | Critique, compression, compaction, tool selection, and memory work can call models without entering the tracker. Team/workflow totals are incomplete. | `agent/reflection.ts:79`; `compression/compression-manager.ts:119`; `context/context-compactor.ts:97`; `tools/tool-router.ts:48`; `team/team.ts:95,119,124`; `workflow/workflow.ts:67` | P1 / L / medium |
| F09 | All tracker state is a capped in-memory array. Eviction/restart removes spend from budgets and totals. Tenant identity is absent. | `cost/cost-tracker.ts:38,57–58,68–99,105–156`; `cost/types.ts:22–32` | P1 / L / high |
| F10 | Mid-run checks omit run/session/user context; warning mode can stop the run; zero budget is treated as disabled. Checks are not atomic across concurrent calls. | `agent/agent.ts:261–263`; `cost/cost-tracker.ts:68–96,163–197`; `storage/driver.ts:1–7` | P1 / L / high |
| F11 | Existing observability treats `cost.tracked` as a replacement run total. Reusing it for independent call amounts would lose earlier costs. | `packages/observability/src/accounting.ts:199–208` | P1 / M / medium |
| F12 | Embeddings and images discard usage; realtime voice discards cache/modality detail. Voice/vision/browser track through different paths without equivalent budget checks. | `vector/embeddings/openai.ts:58–77`; `toolkits/image-generation.ts:72–85`; `voice/providers/openai-realtime.ts:253–259`; `voice/voice-agent.ts:601–611`; `vision/vision-agent.ts:264–274`; `packages/browser/src/browser-agent.ts:332–362` | P2 / L / medium |
| F13 | Existing tests require unknown prices to be zero and assume separate reasoning/audio charges. They do not prove provider billing semantics. | `cost/__tests__/cost-tracker.test.ts:35–44,147–173,196–225`; `packages/core/src/__tests__/cost-tracker-incremental.test.ts` | P1 / L / low |
| F14 | Docs contradict code and each other about budget events/errors, cross-agent auto-stop, and full token accuracy. | `agentium-docs/cost/overview.mdx:289,321,431,437,443`; `agentium-docs/features/cost-autostop.mdx:65–71` | P1 / M / low |

All unqualified `models/`, `agent/`, `cost/`, and related paths in this table start at `packages/core/src/`.

F04 establishes the parser behavior from source. Production frequency for Google/Vertex/Mistral metadata-only events still requires fixtures for each supported API/SDK version. F10 is an architectural concurrency limitation, not a measured production incident.

## Model adapter coverage

This table records current source behavior. Raw fields being preserved does not mean the tracker uses them correctly.

| Adapter / API | Current gap to cover in the build |
|---|---|
| OpenAI Chat Completions | Inclusive output/reasoning; audio overlap; actual tier/model; keep the already-correct usage-tail handling. |
| OpenAI Responses | Cache writes only in raw usage; tier/mode missing from billing context; preserve usage on incomplete/error output. |
| OpenAI Decisions | Cache writes validated but not normalized; endpoint-specific price identity must survive aggregation and validation failure. |
| Azure OpenAI / Azure Foundry | Preserve deployment, biller, region, returned model, and API schema separately. |
| DeepSeek / xAI | Shared OpenAI mapper does not establish provider-specific cache or extra-charge semantics. |
| Meta Llama / custom compatible APIs | Gateway identity and actual biller are independent of the OpenAI-compatible wire format. |
| Vercel adapter | Current `models/providers/vercel.ts` targets v0's API. It is not a Vercel AI SDK or AI Gateway adapter. |
| Anthropic Messages / AWS Claude | Exclusive ordinary input; cache reads, cache-write TTL buckets, inclusive output; retain initial streaming usage. |
| Bedrock Converse | Cache details and actual regional context; stop and usage metadata are separate events. |
| Google Gemini / Vertex | Candidates and thoughts have different inclusion rules from OpenAI; preserve reported total, tool-use fields, modality details, and late metadata. |
| Mistral native / compatible fallback | Preserve API schema identity and process choice-less usage events. |
| Perplexity native / compatible fallback | Preserve search/request charges and provider-reported amounts when present; deduplicate terminal events. |
| Cohere native / compatible fallback | Preserve actual model tokens and separate billed units; handle native v2 nesting. |
| Ollama | Preserve eval counts and durations. A missing API tariff does not prove zero hosting cost. Explicit free rules are allowed. |
| JEV / TypeSafe | Preserve resolved identity and raw usage. An explicit zero output rate is valid; do not confuse it with a missing rate. |

Adapter source is under `packages/core/src/models/providers/`, with shared OpenAI handling in `models/openai-api.ts` and JEV usage mapping in `models/jev-sdk.ts`.

## Storage and consumer constraints

- `StorageDriver` provides only `get`, `set`, `delete`, and whole-list reads. It has no atomic insert, compare-and-swap, transaction, or pagination contract.
- SQL drivers use a generic `kv_store` table. There is no existing cost-ledger migration to extend.
- `storage/dynamodb.ts:111–121` does not follow the query continuation key. `storage/redis.ts:62–68` can expire every item through its configured TTL. Neither behavior should be silently treated as complete permanent accounting.
- `CostTracker.track()` and `getSummary()` are public synchronous APIs. Durable APIs must have explicit asynchronous names and lifecycle rules.
- Parent run summaries are views of leaf charges. Handoffs already avoid charging merged delegated usage twice; preserve that behavior.
- `EventBus.emit()` deliberately isolates listener failures. Store writes and budget decisions must be direct calls with explicit failure handling; events report the result.
- Reranking paths in `rerank/providers/{cohere,jina,voyage}.ts` return ranked documents but discard other response metadata. Add a common measurement sink without changing their ordinary return values.

## External implementation lessons

Sources checked on 2026-10-08. These are design references, not guarantees of complete billing support.

| Project | Useful pattern | Limit to avoid copying |
|---|---|---|
| [Vercel AI SDK usage contract](https://github.com/vercel/ai/blob/main/packages/provider/src/language-model/v3/language-model-v3-usage.ts) | Separate ordinary input, cache read, cache write, total output, reasoning detail, and raw usage. | A usage schema alone is not a full tariff engine. |
| [T3 Code pricing](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/usage/usagePricing.ts) | Pure calculation apart from fetching; separate speed rates and four token categories; preserve cost source. | It documents incomplete long-context/batch/flex data and falls back to standard speed rates. Agentium should expose unknown pricing when required context is absent. |
| [Mastra pricing model](https://github.com/mastra-ai/mastra/blob/main/observability/mastra/src/metrics/pricing-model.ts) and [budget control](https://mastra.ai/reference/processors/token-cost-control) | Separate pricing data from enforcement; explicit scope and warning/block policies. | Its documented budget checks use asynchronously persisted metrics and are approximate. Agentium's stricter admission option requires an atomic accounting store. |

## Provider evidence that shapes the contract

- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching): cache-write input has its own category; it must not also receive ordinary-input billing.
- [OpenAI Fast mode](https://developers.openai.com/api/docs/guides/fast-mode): keep requested and actual tiers; select the billed tier from the returned evidence.
- [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning): Pro mode uses reported aggregated model work; do not invent another token multiplier. Separate Pro model IDs can have separate rates.
- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching): ordinary input, reads, and writes are separate; cache creation can contain TTL buckets.
- [Google usage metadata](https://ai.google.dev/api/generate-content#UsageMetadata): preserve reported counts and their provider-specific detail. The installed SDK and current public description differ on the total's explicit tool-use term; retain the original evidence and test the supported version rather than inventing one generic total formula.

The plan should recheck official rates and contracts when implemented. This review deliberately does not turn today's price table into permanent assumptions.

## What remains unverified

No new end-to-end execution was performed. Earlier conversational examples are useful regression scenarios, not fresh test results from this review. Live invoicing, private discounts, SDK-hidden retries, every hosted tool, and all subscription plans need separate evidence. Unknown usage and unsupported prices must be visible in the product until that evidence exists.
