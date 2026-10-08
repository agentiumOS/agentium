# Catalog verification, 2026-10-08

These facts were checked against official pages during implementation. Values are USD per million tokens unless specified. Verification time is not a historical effective date. Rules must still check endpoint, tier, region, context, and supported combinations.

## OpenAI

[GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol): ordinary input 2; read 0.10; write 2.50; output 10. Above 272,000 inclusive input tokens, input/cache rates double and output becomes 15 for the whole request. Fast doubles Standard; Batch/Flex halve Standard. Regional processing adds 10% where supported. EU Fast is unsupported.

[Current pricing](https://developers.openai.com/api/docs/pricing?latest-pricing=ultrafast): GPT-6 Astra Standard input/read/write/output = 10/1/12.5/50. Ultrafast = 60/6/75/300; long-context Ultrafast = 120/12/150/450. GPT-6 Luna Standard = 0.10/0.01/0.125/0.50. GPT-Live-1 sessions cost 0.05 per minute, billed per second; model/tools are separate. Search costs 10 per thousand calls plus applicable tokens. Do not apply speed multipliers to tool fees. Cloud platforms bill independently.

[Responses service tier](https://developers.openai.com/api/reference/typescript/resources/responses): an omitted tier means auto and can inherit project configuration. Thus absent actual tier is not proof of Standard. Fast requests may return priority. Use actual returned tier, preserving the requested value separately.

[Reasoning](https://developers.openai.com/api/docs/guides/reasoning?trk=article-ssr-frontend-pulse_little-text-block): Pro mode returns aggregate model work billed at the selected model's standard token rates. Do not add a generic Pro multiplier. Existing separate Pro model IDs retain their own pricing.

## Anthropic

[Pricing](https://platform.claude.com/docs/en/about-claude/pricing): ordinary/read/5m-write/1h-write/output rates:

| Model | Ordinary | Read | Write 5m | Write 1h | Output |
|---|---:|---:|---:|---:|---:|
| Claude Sonnet 5.5 | 2 | 0.10 | 2.50 | 4 | 10 |
| Claude Opus 5.5 | 4 | 0.20 | 5 | 8 | 20 |
| Claude Fable 5.1 | 10 | 0.25 | 12.50 | 20 | 50 |
| Claude Sonnet 4.6 | 3 | 0.30 | 3.75 | 6 | 15 |
| Claude Opus 4.6 | 5 | 0.50 | 6.25 | 10 | 25 |
| Claude Haiku 4.5 | 1 | 0.10 | 1.25 | 2 | 5 |

Haiku 5.5 has a 100,000-input threshold. Current Claude 4.6+ models otherwise use standard rates across the full context window. First-party US-only inference adds 10%; global is the documented default. Fast on Opus 5.5 is 8 input/40 output, with its cache multipliers. Fast and Batch cannot combine. Partner-operated platforms have separate rules. Verify exact API model IDs before seeding aliases.

## Google

[Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing): Gemini 2.5 Flash Standard ordinary input 0.30 for text/image/video, 1 for audio; cache reads 0.03 and 0.10 respectively; output including thinking 2.50. Cache storage is 1 per million token-hours. Gemini 2.5 Pro at up to 200,000 input: input1.25/read0.125/output10; above that: input2.50/read0.25/output15. Cache storage is4.50 per million token-hours. Gemini 3.5 Flash input1.50/read0.15/output9, storage1 per million token-hours. Grounding has account-level free allowances and per-query/prompt rules; request tokens alone cannot establish final account charges. Do not infer cache-by-modality intersections from unrelated totals.

## Additional release verification

- [Claude model IDs](https://platform.claude.com/docs/en/models/overview): `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-fable-5-1`, and `claude-haiku-5-5` are explicit first-party IDs. Partner IDs do not establish partner tariffs.
- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna): USD per million ordinary/read/write/output is 0.10/0.01/0.125/0.50. Above 272,000 input tokens, whole-request input/cache rates double and output rises by 1.5. Fast is 2x; Batch/Flex is 0.5x; eligible regional processing is 1.1x.
- [Decisions pricing](https://developers.openai.com/api/docs/guides/decisions#pricing-and-availability): Luna Decisions costs 0.10 per million input tokens, with no cache-read, cache-write, or output charges. Regional and long-context input multipliers apply.
- [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing): `gemini-3.8-flash` paid Standard input/read/output is 0.75/0.075/3.75 through December 31, 2026; 1.50/0.15/7.50 from January 1, 2027. Cache storage is separately priced. A paid-tier rate is not evidence that a free-tier account was charged.

## Additional provider contracts and rate boundaries

- [GPT-6 Astra model page](https://developers.openai.com/api/docs/models/gpt-6-astra) confirms the 272,000-input threshold, 2x input/cache and 1.5x output above it, Fast 2x, and Batch/Flex 0.5x. Ultrafast uses the separately reviewed pricing table.
- [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing): Haiku 5.5 ordinary/read/5m-write/1h-write/output is 0.10/0.01/0.125/0.20/0.50 through 100,000 inclusive input tokens; above that it is 0.50/0.05/0.625/1/2.50. Opus 5.5 Fast is 8/0.4/10/16/40. The first-party US premium applies to 4.6+ models; no Haiku 4.5 US rule is seeded.
- [xAI pricing](https://docs.x.ai/developers/pricing): exact `grok-4.6` standard ordinary/read/output is 2/0.50/6 below 200,000 inclusive input tokens and 4/1/12 at or above 200,000. No separate cache write charge is defined for this contract. [Chat usage example](https://docs.x.ai/developers/rest-api-reference/inference/chat-completions) reports 32 prompt + 9 visible completion + 94 reasoning = 135 total; [Responses](https://docs.x.ai/developers/rest-api-reference/inference/responses) output is already inclusive. These schemas must not share an output-token formula.
- [Mistral Small 4 model](https://docs.mistral.ai/getting-started/models/compare?models=mistral-small-4-0-26-03) uses exact API ID `mistral-small-2603`, input 0.15 and output 0.60. [Caching](https://docs.mistral.ai/studio/conversations/advanced/prompt-caching) bills cached input at 10% of ordinary input (0.015), with cached tokens included in prompt tokens. An omitted cached-token counter means no cache hit. The billing example has input, cached input, and output only.
- [Cohere Command A](https://docs.cohere.com/docs/command-a) uses `command-a-03-2025`, billed input 2.50 and output 10. The normalizer uses `billed_units`, not statistical token counts.
- Google, Mistral, and Cohere paid tariff rules require explicit `pricePlan: "paid"` context, because the existence of a public paid tariff does not establish whether an account is charged. Google text tariffs also require text-modality evidence. Gemini 3.8's temporary rate ends at `2027-01-01T00:00:00.000Z`; the catalog's earlier freshness deadline still applies.
