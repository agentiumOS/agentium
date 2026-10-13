# Host-controlled execution

## Capability map and build order

| Module | Owner and responsibility | Depends on |
| --- | --- | --- |
| request-control | Core adapters: retries, cancellation, request and logical-call deadlines | — |
| resource-budget | Harness: logical-call/token admission, reservations, finishing allowance | request-control |
| resident-history | Core replay validation; harness residency and host archive boundary | resource-budget |
| input-validation | Harness: public stateless validation and limit metadata | — |
| endpoint-capabilities | Core adapters: endpoint/fallback policy; host-supplied capability facts | request-control |

Build in this order, as requested. The user explicitly authorized specification followed by implementation without routine approval gates.

## Verified findings

* `core/models/providers/{openai,anthropic}.ts` have private, narrow constructor configs and fixed two-retry loops with uncancellable waits. `models/registry.ts` narrows factories too. Both SDK constructors omit retry/timeout options. Installed OpenAI 7.30.0 and Anthropic 0.131.0 expose `maxRetries`, `timeout`, and request signals; SDK source defaults to two retries and ten-minute timeouts. SDK retries are opaque to Agentium accounting.
* Agentium retries only SDK request establishment, not stream iteration. However `streamOpenAIStyle` currently allows Responses fallback after iteration begins but before a normalized chunk appears. A metadata-only stream can therefore be replayed. Both generate and stream fallback can force reasoning effort to `none`.
* Harness `prepare` increments logical modelCalls before projection/admission and reserves output only. `controlModel` also reserves output only. Failure without usage releases everything, falsely suggesting no possible consumption. No finishing reserve or public resource snapshot exists. Monetary accounting already has separate store-backed reservations; this change does not duplicate that currency contract.
* Context projection preserves canonical runtime history. Core session retention already retains whole recent turns but has no host archive contract. Harness stores duplicate canonical/root conversation data and session snapshots are not active-run recovery checkpoints.
* `runtime/input.ts` validates strict message content and normalized JSON UTF-8 bytes, but root exports omit `validateRunInput`. Initial `start` input does not use the validator.
* `get_skill_reference` reads a whole UTF-8 file. Paging is deferred.

## Commands, structure, and conventions

Sources and colocated Vitest tests: `packages/core/src/models`, `packages/harness/src/runtime`, core execution boundary where needed. Public exports: package root barrels and factory signatures. Guide: `packages/harness/README.md` and `packages/core/README.md`.

Validation: `npx vitest run <changed suites>`; `npm run build`; `npm run test:package`; `npx biome check <changed files>`. Follow existing named exports, explicit `.js` imports, classes for existing public runtime APIs, `import type`, and safe public boundary validation. Example: `new OpenAIProvider("model", { maxRetries: 0, sdkMaxRetries: 0, timeoutMs: 30000 })`.

Always preserve tool exchanges, grants and completion validation; test before delivery. Ask only for unresolved material product choices. Never add storage infrastructure, hardcoded model registry, live-run recovery, or skill paging.

## Acceptance matrix

See module specifications for contracts. Tests must exercise actual adapter/runtime boundaries: cancellation during backoff; deadline across retries; failures before establishment and after raw stream consumption; SDK config forwarding for all key paths; logical versus physical accounting; concurrent reservation admission, reconciliation, failure/early stream closure and repeated denials; finishing role grants and completion rejection; archival acknowledgement before eviction, retrieval validation, intact replay and unsupported provider rejection; root imports and input byte boundaries; strict and compatible endpoint policies and capability rejection before transport.
