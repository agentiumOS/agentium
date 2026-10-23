# Current Provider Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring Gemini request handling, current billing contracts, and OpenAI Decisions support up to date after 4.10.0.

**Architecture:** Extend the existing Google and Decisions adapters and canonical accounting machinery. Execute three subsystem plans in order; each produces a working, independently reviewable increment. Shared accounting corrections precede the expanded Decisions feature.

**Tech Stack:** TypeScript, Zod, Vitest, optional Google/OpenAI SDKs, existing ledger and pricing catalog.

**Spec:** [Proposed design](design.md).

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

- A provider accepts an option locally but its SDK drops it: test the actual serialized HTTP request.
- A request succeeds but the answer is unusable: preserve billable usage and the original failure.
- An old model name resolves to a new model: retain both identities without guessing a tariff.
- A cached request is charged twice: assert disjoint payable input/read/write quantities.
- A valid old caller upgrades: preserve its constructors, string questions, response shapes and cancellation.

Each subsystem plan includes the owning tests for these conditions.

## Proposed order

| Order | Plan | Deliverable | Size |
| --- | --- | --- | --- |
| 1 | [Gemini compatibility](gemini.md) | Correct Argon request settings, bounded output behavior, retained replay and identity | Small to medium |
| 2 | [Accounting corrections](accounting.md) | Correct Decisions cache charges; verified missing tariffs and aliases | Medium |
| 3 | [Decisions GA](decisions.md) | Native JSON/history evidence, image questions, 400-question limit and cache controls | Medium to large |

All three increments are implemented locally. The third uses the accounting contract from the second. See [execution decisions](execution.md) and [verification results](verification.md) for the delivered scope and evidence.

## Execution and verification

- [x] Read the design and selected subsystem plan; confirm the checkout still matches the recorded baseline or reconcile newer changes. Reuse the current checkout if suitable. Preserve unrelated work.
- [x] Implement the subsystem with focused failing-then-passing tests and one commit per testable deliverable. The requested Poteto workflow used disjoint source owners and independent combined review. The parent owns integration and commits.
- [x] Update package documentation with each subsystem. In `/Users/xerycks/Xhip/agentium-docs`, read `AGENTS.md` first, then update `models/google.mdx`, `models/openai-decisions.mdx`, `models/deepseek.mdx`, and `cost/overview.mdx` only where behavior or guidance changes. Record separate repository commits; do not deploy the site.
- [x] Run `npm run build`, then TypeScript checks covering source and tests (`npx tsc -p packages/<package>/tsconfig.json --noEmit --pretty false`) for each of the ten workspaces. Never typecheck dependent workspaces while build is deleting their declarations.
- [x] Run `npx biome ci .` and the full Vitest suite with two workers. Record actual pass/skip counts. Existing MCP and native-recovery files remain included.
- [x] Run `node --test scripts/release-lock.test.mjs scripts/cjs-declarations.test.mjs scripts/release-artifacts.test.mjs` and `npm run test:package`. All tests passed. Public API ESM/CJS consumption checks cover the new Decisions exports in the existing packed fixture.
- [x] Review the complete diff against the design, capture source revision and evidence, and report any live-service limitations explicitly.
- [ ] If a release is subsequently requested, choose the next available semver version and follow the repository release gate: exact-revision Linux Node 22/24 matrix, integration services, retained package artifacts, then publication and registry reconciliation. The combined additive Decisions API normally warrants a minor release. Do not reuse `v4.10.0`.

## Deliberately deferred

No automatic model routing or model default changes. No background Interactions, long-decode loops, managed supervisors, voice Decisions integration, DeepSeek Search/Fetch or new Mistral preview support in these increments. Keep these as separate product decisions. Skills and MCP are already implemented; include existing regressions without rebuilding those features.

## Planning evidence

Sources and code findings are recorded in the design, including corrections to the initial report's broad pricing concern. Planning verification is document/source review only; it is not a claim that these unimplemented features pass tests.

The documents live under `plans/` because this repository deliberately ignores `docs/`; this follows its existing planning layout.
