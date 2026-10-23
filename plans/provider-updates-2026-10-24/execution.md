# Provider update execution

The user approved implementation on October 24, including safe cleanup and clearer developer-facing behavior. The starting revision is `c6d52c5`.

## Done condition

The approved Gemini, accounting and Decisions behavior works through actual SDK request serialization. Existing callers and stored cost assessments retain their contracts. The build, TypeScript checks, lint, full tests and packed consumers pass. No package release or documentation deployment occurs in this run.

## Workflow

- [x] Read the Principles section of the Poteto skill in full.
- [x] Phase A: Frame. Use the approved design, with three provider/accounting units and bounded cleanup.
- [x] Phase B: Design the workflow. Compare two independent implementation shapes and record the chosen boundaries.
- [x] Phase C: Run the loop. Each unit starts with failing behavior tests and finishes with focused green tests.
- [x] Phase D: Keep the audit trail. Record decisions and checks in `decisions.tsv` as work proceeds.
- [x] Phase E: Verify and hand back. Review actual diffs, run combined checks, and state any unverified live-service behavior.

## Throughput checkpoint

- [x] Blocking first steps. Baseline four focused files passed with 96 tests. Complete read-only design comparison before source edits.
- [x] Independent workstreams. Google request handling, canonical accounting, and Decisions input/transport have distinct source owners. Documentation and final integration belong to the parent.
- [x] Shared mutable state. No child may commit, edit shared documentation, or change another owner's source files. The parent owns integration, the decision log and package checks.
- [x] Smallest safe decomposition. Use one owner per coherent subsystem, with no nested workers. Reuse existing request, usage, validation and test mechanisms. Do not add a new provider framework.

## Data shapes

- Google options remain `ModelConfig`; exact Argon capability rules feed existing request helpers. Responses retain requested/served model identity and usage even when continuation cannot complete.
- Decisions evidence uses a discriminated union for messages, function calls and outputs. One validated request path owns the native `evaluate` call and adapted `generate` calls.
- Accounting uses `CanonicalTokens`, `Measurement`, `PriceRule`, and immutable `CostAssessment`. Correct the affected contract and preserve historical evidence.

## Evidence

Two independent designs and a third read-only judgment selected the existing adapters with one Decisions request-validation boundary. Generic OpenAI SDK transport avoids beta-type assertions and another client. Google keeps its request scopes. Accounting retains immutable assessments and the existing tariff resolver.

The judgment identified one tariff trap. The resolver needs a rule even for a zero quantity. Argon's separately billed cache-creation API does not justify a free cache-write tariff. Omit only its proven-zero payable write measurement, preserve canonical usage, and leave nonzero or unknown writes unpriced.

The current Decisions reference narrows native JSON to an object or array of objects, with 32 container levels, 10,000 values, and 256 KiB of compact UTF-8. It describes choosing the latest cache breakpoints rather than rejecting requests with more than four markers. Implementation follows those verified boundaries.

Independent implementation review found a split-chunk Google replay defect. The terminal chunk discarded earlier signed calls. Three failing HTTP/SSE cases drove a fix that accumulates all parts and classifies tool completion from the whole turn. The reviewer independently confirmed both calls and the original signature in the next serialized request.

Typed example checking caught the registry factory's intentionally generic `ModelProvider` return type. Native examples now construct `OpenAIDecisionsProvider`; the factory continues to support generic registry overrides. This avoids widening its declared contract or bypassing the registry.

The documentation repository still targets published 4.9.0. New behavior is marked unreleased in companion guides, while generated published API references and installation pins stay unchanged. Guide examples are checked against the new build. Regenerating the release reference belongs to the separately authorized release update.

Run `node plans/provider-updates-2026-10-24/verify.mjs` for the focused provider checks. Pass `--full` for the entire Vitest suite. Build, type checks, lint and package consumption remain separate required gates.

The baseline output is `/tmp/agentium-provider-baseline.log`. The decision log records subsequent results and paths. Independent profiles are unavailable through this runtime; delegates inherit the parent's model and effort. Their model-family diversity is unverified.

The final [verification record](verification.md) contains the combined results and retained limits. Local commits separate Gemini, accounting, Decisions, and the documentation repository. No push, tag, version change, package publication, or documentation deployment belongs to this run.

The installed bundle has no `deslop` skill. The parent applied its cleanup checks directly before committing: inspect the entire diff, remove stale comments and dead paths, reject unnecessary wrappers, preserve public contracts, and run lint and behavior checks. The separate comment reviewer found no further deletions to make.
