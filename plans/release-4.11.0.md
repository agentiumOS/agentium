# Agentium 4.11.0 release plan

**Goal:** Publish the completed provider updates as 4.11.0 and reduce release waiting without weakening verification.

**Architecture:** Keep the existing GitHub Actions release pipeline and immutable tarball manifest. Replace npm metadata subprocesses with bounded requests to the registry's exact-version endpoint. Run independent read-only checks concurrently after the package build. Use dependency-ordered publication batches and verify served bytes before advancing.

**Scope:** User-approved provider changes, release notes, native Decisions CommonJS type coverage, aligned package versions, published documentation and downloadable examples. No new model features, automatic continuations, or broad cleanup.

## Constraints

- Preserve Node 22 and 24, database integrations, optional SDK fixtures, lint, type checks, all tests, and packed consumers.
- Retain source identity, manifest hashes, exact served bytes, failure classification, one upload per attempt, and resumable outcomes.
- Registry HTTP 404 alone proves absence. Authentication, transport, malformed metadata, and mismatched bytes block publication.
- No unverified claim of speedup. Compare recorded workflow durations and distinguish local lookup measurements from total release performance.
- Reuse the clean current checkout and existing branch. No additional worktree is needed.
- Move documentation to released status only after all ten packages are verified. Upload generated recipe archives to the matching release before advertising those links.

## Tasks

- [x] Add and run failing registry transport regressions for exact-version lookup, timeout propagation, absence, and failed metadata.
- [x] Implement direct bounded registry reads and concurrent preflight. Preserve ordered uploads and durable outcomes. Add per-package timing output.
- [x] Run all release artifact tests, including timeout, mismatch, partial-publication and retry regressions.
- [x] Add a CI runner that overlaps existing independent checks after build and waits for every result. Validate workflow syntax and failure propagation.
- [x] Add native Decisions types to the CommonJS consumer, release notes and upgrade guidance. Bump all coordinated package metadata to 4.11.0 with the existing lock synchronizer.
- [x] Prepare 4.11.0 docs and generated references/examples. Run SDK build, source/test type checks, full tests, packed consumers, and documentation checks.
- [x] Commit the reviewed release source, push and tag 4.11.0. Follow the exact-revision Node 22/24 release run until all checks and package publications pass.
- [x] Reconcile registry integrity and install the published packages. Upload docs recipe assets, mark docs released, validate and publish documentation.
- [x] Record release URLs, source/artifact identity, test evidence, observed CI durations, and any remaining limits.

## Baseline evidence

GitHub release run `40022875425` for v4.10.0 completed in 24 minutes. Its publication step took 1,009 seconds. Node 22/24 test steps took 124/109 seconds. Their builds took 24/18 seconds, type checks 27/20 seconds, and release metadata checks 12/10 seconds. The Node 24 dependency install took 106 seconds. Raw step data is in `/tmp/agentium-release-410-jobs.json`.

A local read-only sample on the existing and absent versions took 1,430/1,854 ms through `npm view`, versus 534/358 ms through direct exact-version requests. This only measures lookup overhead; it does not predict npm publication or registry propagation time.

## Sources

- [npm registry exact-version endpoint](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md)
- [GitHub reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
- [GitHub dependency caching](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)

## Local verification

- SDK build completed for all ten workspaces.
- Ten source/test TypeScript projects passed. Packed ESM and CommonJS consumer/CLI fixtures: 4 passed.
- Release artifact tests: 30 passed, including concurrent preflight and ordered uploads, exact-version HTTP metadata, response-body deadlines, unknown/error handling, served-byte mismatch, and partial-publication reconciliation. CI runner tests verify concurrent admission and waiting for all results after failure.
- Workflow syntax passed actionlint. Biome passed with one existing informational suggestion in an unrelated graph fixture.
- Documentation is prepared locally; publication status remains `preparation` until registry verification. Generated references now classify native journaling and application recovery APIs introduced in 4.10.


## Publication follow-ups

The original release source remains `6b5aad0600962e0988c1b86951e14d52639fdb77` (`v4.11.0`). The retained manifest is `13d1bd35a633036ab8a5576840994537477a7e0857e195047fa58e356a4d273e`. Rebuilt verification artifacts were byte-identical to the retained set.

- `a55b9db`: bounded dependency-aware publication batches, with 40 release-tooling checks and Node 22/24 CI passing.
- `77d6dbf`: explicit original-run artifact selection for safe failed-job recovery, still bound to the new full-matrix manifest hash. Node 22/24 CI passed.
- `1ec9532`: bounded read-only retries when accepted version metadata precedes tarball availability. All 42 release-tooling checks passed locally; [Node 22/24 CI](https://github.com/agentiumOS/agentium/actions/runs/40035005142) passed.

The recovery run accepted the final three uploads concurrently. Registry confirmation completed for admin and edge after about 57 seconds; CLI metadata became visible before its tarball. Package uploads took 1.7–3.9 seconds in the first attempt; registry confirmations took 57–99 seconds. These observations do not establish an end-to-end speedup, because publication encountered registry propagation failures.


## Published package verification

[Release recovery attempt 2](https://github.com/agentiumOS/agentium/actions/runs/40033766535/attempts/2) passed. All ten final outcomes are `verified_published` / `already_present`; no accepted upload was retried. Independent registry reads verified all ten exact versions, latest tags, SRI values and byte-identical tarballs. A fresh consumer installed all ten exact versions with normal peer resolution, imported every package through ESM and CommonJS, and reported CLI version 4.11.0.

The [4.11.0 GitHub release](https://github.com/agentiumOS/agentium/releases/tag/v4.11.0) contains the eight recipe ZIPs, immutable manifest and registry verification record. All ten public release assets were downloaded without authentication and matched local bytes. Documentation commit `b3924de49a5eb51afb57c6c3589b7a704aa346bf` promotes released status, updates guides and generated references, and passed final local build, link, synchronization and package-availability checks.

Mintlify deployed documentation commit `b3924de49a5eb51afb57c6c3589b7a704aa346bf`. Public HTTP checks verified 4.11 content on the upgrade guide, release overview and installation guide, plus the matching recipe download link.

## Observed timing and limits

The current dependency graph needs four fresh-publication batches at concurrency three: core; harness/transport/queue; browser/eval/observability; admin/edge/CLI. The earlier sequential workflow needed ten stages. This reduces avoidable serialized waiting but cannot remove registry propagation time.

The final recovery's already-present package reconciliation took nine seconds, within a 46-second publish job. This is a recovery measurement, not a clean-release benchmark. The follow-up CI jobs took 272 seconds on Node 22 and 384 seconds on Node 24. Build, type, lint, database, package-consumer, sandbox and OpenTelemetry gates remain enabled. No end-to-end speedup is claimed from these differently scoped runs.


## Final delivery gate

The [documentation workflow](https://github.com/agentiumOS/agentium-docs/actions/runs/40035598290) passed both `docs` and `sdk-examples` for `b3924de49a5eb51afb57c6c3589b7a704aa346bf`. Mintlify's deployment check also passed. Hosted checks include generated API/harness drift, public imports, complete examples, adapter coverage, credential-free recipes, harness fixtures and disposable Redis queue fixtures.

The release, follow-up Node 22/24 CI, documentation CI, public documentation pages and all ten downloadable assets are verified. No user input remains necessary. Future clean release timings must still be measured independently; this release's npm propagation delay is preserved in the evidence rather than presented as a successful speed benchmark.
