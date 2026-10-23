# Decisions GA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support current Decisions evidence and question formats through the existing adapter, with native JSON/custom-tool input available through a typed provider method.

**Architecture:** Own the validated input types in core, add `evaluate` to OpenAIDecisionsProvider, and route existing generate/stream methods through the same request path. Keep generic ChatMessage/ContentPart and the Agent run-options contract unchanged. Use the corrected accounting contract from the accounting plan.

**Tech Stack:** TypeScript, Zod, optional OpenAI SDK, Vitest and local Node HTTP fixtures.

**Spec:** [Design, Increment 3 and Global constraints](design.md).

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

- Keys named role/image_url inside JSON remain ordinary evidence; no remote image fetch or role conversion is triggered by them.
- Question images and tool-output images count toward one request-wide image limit.
- Tool history remains evidence: tool definitions still fail, and answers never invoke a tool.
- An invalid response or cancellation after a billed response retains normalized usage without retry.
- Existing text/image callers, string questions, refusals and completed-JSON stream results remain usable.

## File responsibilities

- Modify `packages/core/src/models/decisions.ts`: question instruction union, 400-question boundary, Agentium-owned native input types and Zod schemas.
- Create `packages/core/src/models/decision-input.ts`: role-aware chat conversion, native evidence validation and aggregate image/call linkage checks. Keep this provider-specific logic outside generic content handling.
- Modify `packages/core/src/models/providers/openai-decisions.ts`: public evaluate method, shared validated request path, documented SDK transport and cache controls.
- Modify `packages/core/src/index.ts`: new public type exports.
- Modify `packages/core/src/models/__tests__/openai-decisions.test.ts`: actual SDK HTTP serialization, Agent integration and compatibility tests.
- Create `packages/core/src/models/__tests__/decision-input.test.ts`: role, JSON, image, call linkage and question boundary behavior.
- Modify `packages/harness/src/__tests__/package-consumption.test.ts`: existing packed ESM/CJS fixture imports new types/method; do not add a second package-consumer harness.
- Modify `packages/core/README.md`; update docs-repository `models/openai-decisions.mdx` separately after reading its instructions.
- Touch package/lockfile SDK declarations only if the published GA SDK path requires a verified higher Decisions-specific floor; do not install a dependency just for planning.

### Task 1: Define and validate GA questions and native evidence

**Interfaces:** Produce the following core-owned types and internal helpers. `DecisionJSONValue` is recursive JSON with finite numbers; `input_json.data` accepts an object or array, not a top-level scalar. `DecisionInstructionPart` is text/image without cache breakpoints. `DecisionInputPart` includes text/image with optional explicit breakpoint and JSON. `DecisionInputItem` is the role/call/output union in the design.

```ts
parseDecisionQuestions(value: unknown): DecisionQuestion[] // existing, extended
buildDecisionInput(messages: ChatMessage[]): DecisionInputItem[]
validateDecisionInput(input: unknown, questions: DecisionQuestion[]): DecisionInputItem[]
```

The last helper validates the combined image budget across shared evidence and questions, role restrictions and call linkage. `buildDecisionInput` uses native roles, serializes validated function arguments to JSON strings, and never copies opaque providerExtras. Export public data types from index; helpers remain internal modules.

- [ ] Add failing tests named `accepts 400 questions and rejects 0 or 401`, `accepts image instructions without changing string questions`, `keeps nested JSON keys as data`, `rejects non-JSON and invalid-role evidence`, `validates one image budget across all evidence`, and `pairs ordered function and custom tool history`. Assert the exact limits 400 and 128; include 128 shared/question/output images accepted and 129 rejected. Reject circular values, undefined/function/bigint members, nonfinite numbers, invalid URL schemes, orphan/duplicate outputs, JSON in system/assistant/tool output, and unsupported audio/files/references. Preserve unique names, distinct choices, fractional scores and refusals.
- [ ] Run `npx vitest run packages/core/src/models/__tests__/decision-input.test.ts packages/core/src/models/__tests__/openai-decisions.test.ts`; confirm the intended missing-type/schema/conversion failures. Recheck numeric limits against the linked create reference before fixing fixtures.
- [ ] Implement the types, schemas and helpers. Keep all existing public constructors and answer formats. Use runtime validation of external/unknown values; do not suppress SDK type errors with assertions.
- [ ] Run the same tests; expect all pass. Add a short core README example of native JSON input versus existing Agent text/image input.
- [ ] Commit as `feat(core): validate Decisions GA evidence and questions`.

### Task 2: Expose evaluate and send GA requests through a supported SDK path

**Interfaces:** Produce `OpenAIDecisionsProvider.evaluate(input: DecisionInputItem[], options?: OpenAIDecisionsEvaluateOptions): Promise<ModelResponse>`. Evaluate options contain optional `questions`, `signal`, `apiKey`, `promptCacheKey`, and `promptCacheOptions?: { mode: 'explicit' }`; config also gains optional cache defaults. Existing generate accepts unchanged ModelConfig and delegates after conversion; existing stream delegates to generate and emits completed JSON/finish.

- [ ] Add failing HTTP tests named `serializes native JSON and question images through the installed SDK`, `preserves conversation roles and tool call IDs`, `sends explicit cache controls only when supplied`, and `preserves old Decisions entry points`. Assert `/v1/decisions`, HTTP(S) URLs forwarded unchanged, system/user/assistant roles, ordered calls/results, no synthetic role-label prefixes, request-wide image counting, constructor/per-call question/cache precedence, omitted unset cache fields, and correct signal/API-key/baseURL overrides. Explicit mode without breakpoints remains an explicit no-cache request, as documented by OpenAI.
- [ ] Run `npx vitest run packages/core/src/models/__tests__/openai-decisions.test.ts`; verify failures show the beta-only conversion/SDK schema boundary.
- [ ] Inspect a published current OpenAI SDK and its official declarations. Use the GA typed create path if available and document any exact feature floor. Otherwise use the SDK's documented generic `post` for `/decisions` with a validated core-owned body and unknown response parsed by existing validation. Keep SDK retries at zero and preserve the one existing authentication/transport stack. Reuse one request method for evaluate/generate/stream. Do not add generic JSON parts to every provider or change Agent run options.
- [ ] Run the focused tests and `npm run build:core`; expect all pass. Ensure generated declarations expose the native API without importing a mandatory optional SDK type into consumers. Document why JSON/custom history uses evaluate directly, while normal Agent calls use supported ChatMessage text/images/function history. If SDK metadata changes, sync the lockfile without unrelated upgrades and test the affected optional SDK floor.
- [ ] Commit as `feat(core): expose native Decisions GA evaluation`.

### Task 3: Verify failures, accounting and packed consumers

**Interfaces:** Consume Task 2's evaluate method and the accounting plan's GA usage normalization. Preserve existing `ModelUsageError`, answer/refusal semantics and stream completion contract.

- [ ] Add tests named `retains GA usage when answer validation fails`, `aborts evaluation with the caller reason`, `never executes historical tools`, and `preserves public Decisions behavior in packed consumers`. Assert malformed answers retain captured usage and cause no retry; all-refusal responses keep content_filter while mixed responses retain answers; correct cache partition cost is `0.0000305` for the design fixture; provider tool definitions remain rejected; direct evaluate returns no executable tool calls. Assert the stream emits completed JSON and one terminal chunk, rather than claiming per-answer streaming. Import the new types and evaluate method through packed ESM/CJS consumers.
- [ ] Run `npx vitest run packages/core/src/models/__tests__/openai-decisions.test.ts packages/core/src/cost/__tests__/reviewed-pricing.test.ts`; confirm any new behavioral regression fails before changing it. Do not force a failing test by breaking already-correct behavior.
- [ ] Fix only demonstrated integration gaps, preserving usage after unusable responses and caller cancellation. Update core README and the docs page with supported roles/formats, limits, native evaluate examples, billing, SDK requirements and deferred features.
- [ ] Run the same tests, `npm run build`, then `npm run test:package`; expect all pass. Complete the umbrella plan's typechecks, lint, full suite and review. Report separately whether any credentialed live-service check ran.
- [ ] Commit as `test(core): verify Decisions GA public integration`, with a separate docs repository commit if needed.

Follow the [umbrella plan](README.md) for final verification and any separately authorized release.
