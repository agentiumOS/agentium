# Gemini Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make existing Google generate/stream requests behave correctly for Gemini 4 Argon without introducing background or multi-request execution.

**Architecture:** Add exact-family validation next to the existing thinking and request helpers. Reuse GoogleProvider, request scopes, signed replay and canonical usage; exercise the real SDK serializer with local fixtures.

**Tech Stack:** TypeScript, `@google/genai`, Vitest, Node HTTP fixtures.

**Spec:** [Design, Increment 1 and Global constraints](design.md).

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

- Unsupported reasoning options fail before a physical request, including disabled reasoning outside the current helper guard.
- Explicit cache resources are rejected for Argon, while older Google models retain support.
- The installed SDK serializes level-based thinking and omits unwanted sampling fields.
- Function-call thought signatures survive a streamed tool turn into the following request.
- Continuation is never reported as a completed answer, and available usage survives the failure.

## File responsibilities

- Modify `packages/core/src/models/thinking-replay.ts`: exact Argon family detection, option validation and request transformations.
- Modify `packages/core/src/models/providers/google.ts`: validation before network access, continuation failure handling and identity evidence.
- Modify `packages/core/src/models/__tests__/openai-api.test.ts`: existing helper regression matrix.
- Create `packages/core/src/models/__tests__/google-argon.test.ts`: real-SDK local HTTP request/response fixtures for generate and stream.
- Modify `packages/core/src/models/__tests__/billing-context-agent.test.ts`: requested versus returned Google identity through Agent accounting.
- Modify `packages/core/README.md`: supported Argon path and limitations.

### Task 1: Validate and serialize Argon requests

**Interfaces:** Consume existing `ModelConfig` and helpers. Produce `validateGoogleArgonOptions(modelId: string, options?: ModelConfig): void`; preserve `applyGoogleThinkingConfig(...)` and `applyGoogleRequestExtras(...)` signatures.

- [ ] Add failing tests named `maps Argon reasoning levels without a thinking budget` and `rejects unsupported Argon options before HTTP`. Assert LOW/MEDIUM/HIGH mapping from the design, no `thinkingBudget`, no sampling fields, and zero fixture requests for none/minimal/disabled reasoning, token budgets, explicit `cachedContent`, or `maxTokens: 65537`. Assert `maxTokens: 65536` and explicit lower values are forwarded unchanged. Keep Gemini 2.5 and Gemini 3 expectations unchanged.
- [ ] Run `npx vitest run packages/core/src/models/__tests__/openai-api.test.ts packages/core/src/models/__tests__/google-argon.test.ts`; confirm failures identify the current budget branch/missing validation.
- [ ] Implement the validator and Argon branches; call validation in both Google methods before existing reasoning guards. Use exact known family matching; do not treat all future Gemini versions as Argon. Do not increase timeouts or output limits.
- [ ] Run the same tests and `npx vitest run packages/core/src/models/__tests__/google-ollama-controls.test.ts`; expect all pass, including deadline and retry-ownership regressions. Document the single-request limit and the explicit-cache error.
- [ ] Commit the focused change as `fix(core): align Gemini Argon request controls`.

### Task 2: Preserve turn state, completion status and accounting evidence

**Interfaces:** Consume Task 1 validation, existing `ModelUsageError` and `providerTokenUsage`; no new public method. Produce faithful `ModelResponse`/`StreamChunk` behavior and billing context.

- [ ] Add failing HTTP fixtures named `replays Argon signed function calls after streaming`, `retains requested and returned Google models`, and `fails continuation without reporting completion`. Assert thought signatures and matching tool IDs in the next request; requested and returned IDs remain distinct; `CONTINUATION` plus an opaque token produces an actionable error with usage, no successful terminal finish and no automatic second HTTP request. Cover a continuation with no text. Assert caller abort during stream retains its reason and closes the request.
- [ ] Run `npx vitest run packages/core/src/models/__tests__/google-argon.test.ts packages/core/src/models/__tests__/billing-context-agent.test.ts`; verify each intended failure or document an already-passing behavior without changing it.
- [ ] Correct only demonstrated gaps in Google response/stream handling. Capture usage before throwing on unsupported continuation; preserve existing replay formats, caller cancellation and SDK retry settings. Keep returned identities from actual response evidence rather than synthesizing them from aliases.
- [ ] Run those tests plus `google-ollama-controls.test.ts` and `usage-conformance.test.ts`; expect all pass. Update migration guidance in core README and the docs repository's `models/google.mdx` after reading that repository's instructions. Cite Google's rerouting/deprecation notices; do not automatically rewrite user model IDs.
- [ ] Commit as `fix(core): retain Argon completion and replay evidence`, with a separate documentation-repository commit where needed.

Complete the shared verification steps in the [umbrella plan](README.md) before claiming the combined work complete.
