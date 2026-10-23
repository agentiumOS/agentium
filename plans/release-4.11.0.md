# Agentium 4.11.0 release plan

**Goal:** Publish the completed provider updates as 4.11.0 and reduce release waiting without weakening verification.

**Architecture:** Keep the existing GitHub Actions release pipeline and immutable tarball manifest. Replace npm metadata subprocesses with bounded requests to the registry's exact-version endpoint. Run independent read-only checks concurrently after the package build. Keep uploads ordered and verify served bytes before advancing.

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
- [ ] Prepare 4.11.0 docs and generated references/examples. Run SDK build, source/test type checks, full tests, packed consumers, and documentation checks.
- [ ] Commit the reviewed release source, push and tag 4.11.0. Follow the exact-revision Node 22/24 release run until all checks and package publications pass.
- [ ] Reconcile registry integrity and install the published packages. Upload docs recipe assets, mark docs released, validate and publish documentation.
- [ ] Record release URLs, source/artifact identity, test evidence, observed CI durations, and any remaining limits.

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
