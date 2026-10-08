# Core cost accounting implementation — 4.5.0

Date: 2026-10-08. Branch: `agent/core-cost-accounting`.

## Implementation status

All six source phases are implemented. Source was frozen after the final focused gates below. The release coordinator owns the final workspace, package, documentation, version, and publication gates; those results must be appended before release.

No live provider requests were made. All usage payloads are synthetic fixtures, SDK mocks, or loopback transport fixtures. All database tests use disposable local databases.

## Phase 1 — Usage contracts and adapters

- Canonical inclusive input is split into ordinary input, cache reads, and cache writes. Output includes reasoning; reasoning is not added again.
- Unknown counts are nullable. Runtime validation retains partition, total, subset, schema, unsupported-feature, and modality/cache ambiguity issues.
- Separate normalizers cover Chat Completions, Responses, Decisions, Anthropic, Google, Cohere billed units, Mistral, Bedrock/Claude, Azure, Vertex, Ollama, compatible APIs, and Perplexity. Cloud billers retain their own identity.
- Raw usage retention strips credentials and response content, bounds UTF-8 JSON bytes, and marks truncation.
- Adapter fixtures and `BUILTIN_USAGE_CAPABILITIES` describe exact supported mappings and limitations.

## Phase 2 — Attempt lifecycle

- Paid physical requests have stable operation, attempt, observation, and assessment identity. Start intent is retained before submission.
- Observable retries/fallbacks retain distinct attempts. Opaque SDK retries are labelled; the code does not invent hidden attempts.
- Stream snapshots replace and unique deltas add. Partial/canceled/failed execution keeps available evidence, including usage after finish.
- Reflection, compression, context compaction, tools, memory, Team, Workflow, handoff, and direct supported helpers use the same accounting boundary.
- Whole-run pending markers drain tools/hooks between model calls when an owned Agent/Team/Workflow closes.
- Failed accounting retries the immutable evidence write, never the provider call. Validation/conflict errors keep their public error class and code.
- Durable run lineage preserves empty intermediate workflows. Child queries resolve the root by key and use root indexes; unrelated tenant history is not scanned.

## Phase 3 — Catalog and calculation

- Exact rational arithmetic supports unit, fixed, marginal tier, minimum, block rounding, ordered adjustment, effective date, context, mode/tier, region, currency, and account rules.
- Exact model identity and explicit aliases replace substring guesses. Ambiguous catalog matches fail validation.
- Reviewed built-in snapshot: 306 rules for 17 exact models, with source URLs and verification dates. Unsupported model/account/region/tier combinations remain unpriced.
- The public calculator validates canonical usage and the catalog. Missing quantities/rates/context produce a null total and a priced subtotal.
- Billing groups apply rounding/minimum once. Immutable group assessments retain source attempt, observation, and measurement membership. Corrections/repricing retire prior selected group amounts.
- Provider-reported and invoice amounts have scoped evidence and separate selected views. Durable allocations do not add the group payable a second time. Group finalization requires explicit confirmation.

## Phase 4 — Storage and budgets

- In-memory, optional SQLite, and optional PostgreSQL stores retain immutable observations/revisions/assessments, selections, allocations, and indexed lineage.
- Selection, group updates, budget deltas, and reservation settlement commit atomically. Stale concurrent selections retry optimistically.
- Selected authoritative costs drive budget admission, including costs recorded before a policy was attached or by another tracker.
- Idempotent reservation IDs, unique scope checks, explicit periods/currencies, unknown-policy handling, threshold warnings/blocks, and conservative reservation bounds are supported.
- Real subprocess fixtures kill workers after evidence and after settlement, replay without duplicate spend, and race two independent reservation workers against SQLite and PostgreSQL.
- Canonical aggregation and a new budget retain 10,001 selected charges. Legacy display eviction cannot lower legacy budget spend.

## Phase 5 — Other operation types

- Embeddings, reranking, realtime voice, file STT/TTS, VoicePipeline, vision, image generation, and browser integration preserve supported usage evidence through core.
- Cache storage intervals and custom namespaced measurements use the same record API. Unsupported billing contracts remain explicit unknowns.
- `BUILTIN_ACCOUNTING_CAPABILITIES`, the core README coverage table, and provider capability exports inventory partial and unmetered paths.

## Phase 6 — Public API and consumers

- `cost: true` is opt-in and returns `result.costs`; terminal stream chunks have the same snapshot. Team and Workflow expose the same cost option and snapshot.
- `cost: { budget: { maxCostPerRun: 0.5 } }` provides a simple threshold path; advanced durable policies remain available. Legacy token limits are enforced.
- `ModelConfig.billingContext` configures non-secret account facts once; returned billing facts override defaults. Provider identity cannot be replaced by billing dimensions.
- Snapshot query failure preserves successful model output as `status: "unavailable"` with null totals.
- Owned trackers drain and close their own store. Borrowed trackers/stores are not closed by their consumers.
- Legacy synchronous reads reject ambiguous canonical projections. Canonical `cost.assessed` events and partial metrics do not double-count legacy replacement run totals.
- Core/observability README and public exports updated. External docs and dual CommonJS declaration packaging belong to the release coordinator.

## Executed checks

Final executor gates:

| Check | Result |
| --- | --- |
| Cost directory plus billing-context helper suite, PostgreSQL enabled | 15 files, 180 tests passed |
| `npx tsc -p packages/core/tsconfig.json --noEmit --pretty false` | Passed |
| `npx biome ci .` | Passed |
| Canonical 10,001-charge aggregate/new-budget regression | Passed |
| SQLite/PostgreSQL subprocess crash/replay and independent-worker reservation races | Passed, both backends |
| Nested empty Workflow lineage, sibling isolation, root-index query spy | Passed |
| Team/Workflow close through work between model calls | Passed |

Delegated source gates:

- Lifecycle/Agent DX/handoff final gate: 88 tests passed; core typecheck passed.
- Native billing-context Google/Cohere/Mistral SDK and Agent gate: 36 tests passed; core typecheck passed.
- Earlier observability focused gate: 99 passed, 2 optional conformance tests skipped at that agent; coordinator later owns enabled optional gates.
- Provider usage/reviewed pricing fixtures are included in final cost/provider focused checks.
- Earlier full all-package build passed before the last DX/lineage changes. A final rebuild is required and owned by the coordinator.

Raw final executor logs are in `/tmp/agentium-final-cost-tests3.txt`, `/tmp/agentium-final-core-tsc3.txt`, and `/tmp/agentium-final-global-biome.txt` on this host.

The direct-call search required by the plan was repeated. Remaining production matches are Team's own metered helper, Agent's metered LLMLoop/continuation streams, and the explicit external-agent boundary; test mocks are excluded from the production inventory.

## Intentional limits

- Accurate future provider tariffs cannot be inferred. Unknown rates or billing fields remain visible, never guessed as free.
- Direct external provider work needs an accounting context or the public custom recording API.
- Providers with internal SDK retries can be opaque. In-memory storage is local and not shared reservation storage.
- List-price estimates, provider-reported amounts, invoice amounts, and allocation views are separate; catalog repricing does not replace original budget spend.
- The user explicitly selected version 4.5.0. The release notes must explain changed legacy token/projection semantics despite that version choice.

## Final coordinator gates

Local coordinator gates passed: all ten builds/typechecks, 2,383 full-suite tests with Redis/MongoDB/PostgreSQL and all installed optional fixtures (one unchanged downloaded Transformers-model fixture skipped), three Node24 sandbox/OTel conformance tests, four release-lock/CJS declaration tests, both packed-consumer suites, and publint/attw for all ten packages. Docs generation, build, links, 307 complete examples, imports, adapters, recipes, harness/queue smoke, and downloadable archives passed. The documented four-charge example returns exactly 0.072. See the DX review for commands and scope. Remote CI, release commit/tag, npm publication, and live docs verification remain publication gates.

## Complete implementation source inventory

This inventory includes both delegated source streams. Coordinator-owned package manifests, release metadata, CLI packed-consumer regression, packaging scripts, and external docs are recorded separately by the coordinator. The executor also updated `.github/workflows/ci.yml` with the PostgreSQL integration service/environment.

```text
packages/browser/src/browser-agent.ts
packages/core/README.md
packages/core/src/agent/agent.ts
packages/core/src/agent/llm-loop.ts
packages/core/src/agent/reflection.ts
packages/core/src/agent/types.ts
packages/core/src/compression/compression-manager.ts
packages/core/src/context/context-compactor.ts
packages/core/src/cost/__tests__/accounting-lifecycle.test.ts
packages/core/src/cost/__tests__/agent-cost-dx.test.ts
packages/core/src/cost/__tests__/billing-groups.test.ts
packages/core/src/cost/__tests__/budget.test.ts
packages/core/src/cost/__tests__/calculator.test.ts
packages/core/src/cost/__tests__/catalog.test.ts
packages/core/src/cost/__tests__/cost-tracker.test.ts
packages/core/src/cost/__tests__/fixtures.ts
packages/core/src/cost/__tests__/fixtures/store-process-worker.ts
packages/core/src/cost/__tests__/operation-meters.test.ts
packages/core/src/cost/__tests__/orchestration-dx.test.ts
packages/core/src/cost/__tests__/reviewed-pricing.test.ts
packages/core/src/cost/__tests__/store-process.integration.test.ts
packages/core/src/cost/__tests__/store.integration.test.ts
packages/core/src/cost/__tests__/store.test.ts
packages/core/src/cost/__tests__/usage.test.ts
packages/core/src/cost/accounting-types.ts
packages/core/src/cost/accounting.ts
packages/core/src/cost/budget.ts
packages/core/src/cost/calculator.ts
packages/core/src/cost/catalog-data/reviewed.ts
packages/core/src/cost/catalog.ts
packages/core/src/cost/context.ts
packages/core/src/cost/cost-tracker.ts
packages/core/src/cost/coverage.ts
packages/core/src/cost/decimal.ts
packages/core/src/cost/ledger.ts
packages/core/src/cost/measurements.ts
packages/core/src/cost/operation-usage.ts
packages/core/src/cost/pricing.ts
packages/core/src/cost/store.ts
packages/core/src/cost/stores/base.ts
packages/core/src/cost/stores/in-memory.ts
packages/core/src/cost/stores/postgres.ts
packages/core/src/cost/stores/sql.ts
packages/core/src/cost/stores/sqlite.ts
packages/core/src/cost/types.ts
packages/core/src/cost/usage.ts
packages/core/src/events/types.ts
packages/core/src/graph/retriever.ts
packages/core/src/handoff/__tests__/agent-handoff.test.ts
packages/core/src/handoff/__tests__/streaming-handoff.test.ts
packages/core/src/index.ts
packages/core/src/memory/curator.ts
packages/core/src/memory/stores/entity-memory.ts
packages/core/src/memory/stores/graph-memory.ts
packages/core/src/memory/stores/learned-knowledge.ts
packages/core/src/memory/stores/procedure-memory.ts
packages/core/src/memory/stores/summaries.ts
packages/core/src/memory/stores/user-facts.ts
packages/core/src/memory/stores/user-profile.ts
packages/core/src/models/__tests__/billing-context-agent.test.ts
packages/core/src/models/__tests__/billing-context.test.ts
packages/core/src/models/__tests__/fixtures/usage-fixtures.ts
packages/core/src/models/__tests__/openai-decisions.test.ts
packages/core/src/models/__tests__/usage-conformance.test.ts
packages/core/src/models/billing-context.ts
packages/core/src/models/circuit-breaker.ts
packages/core/src/models/fallback-provider.ts
packages/core/src/models/jev-sdk.ts
packages/core/src/models/model-router.ts
packages/core/src/models/openai-api.ts
packages/core/src/models/provider.ts
packages/core/src/models/providers/anthropic.ts
packages/core/src/models/providers/aws-bedrock.ts
packages/core/src/models/providers/aws-claude.ts
packages/core/src/models/providers/azure-foundry.ts
packages/core/src/models/providers/azure-openai.ts
packages/core/src/models/providers/cohere.ts
packages/core/src/models/providers/google.ts
packages/core/src/models/providers/mistral.ts
packages/core/src/models/providers/ollama.ts
packages/core/src/models/providers/openai-compatible.ts
packages/core/src/models/providers/openai-decisions.ts
packages/core/src/models/providers/openai.ts
packages/core/src/models/providers/perplexity.ts
packages/core/src/models/providers/vertex.ts
packages/core/src/models/types.ts
packages/core/src/models/usage-capabilities.ts
packages/core/src/models/usage-normalizers.ts
packages/core/src/rerank/providers/cohere.ts
packages/core/src/rerank/providers/jina.ts
packages/core/src/rerank/providers/voyage.ts
packages/core/src/team/team.ts
packages/core/src/team/types.ts
packages/core/src/toolkits/image-generation.ts
packages/core/src/tools/tool-router.ts
packages/core/src/utils/retry.ts
packages/core/src/vector/embeddings/google.ts
packages/core/src/vector/embeddings/openai.ts
packages/core/src/vision/types.ts
packages/core/src/vision/vision-agent.ts
packages/core/src/voice/__tests__/native-conformance.test.ts
packages/core/src/voice/pipeline.ts
packages/core/src/voice/providers/elevenlabs-stt.ts
packages/core/src/voice/providers/elevenlabs-tts.ts
packages/core/src/voice/providers/google-live.ts
packages/core/src/voice/providers/openai-realtime.ts
packages/core/src/voice/providers/openai-stt.ts
packages/core/src/voice/providers/openai-transcription.ts
packages/core/src/voice/providers/sarvam-stt.ts
packages/core/src/voice/providers/sarvam-tts.ts
packages/core/src/voice/providers/speech-accounting.ts
packages/core/src/voice/providers/speech-socket.ts
packages/core/src/voice/types.ts
packages/core/src/voice/voice-agent.ts
packages/core/src/workflow/types.ts
packages/core/src/workflow/workflow.ts
packages/observability/README.md
packages/observability/src/__tests__/cost-assessments.test.ts
packages/observability/src/accounting.ts
packages/observability/src/safety.ts
packages/observability/src/structured-logger.ts
packages/observability/src/types.ts
```
