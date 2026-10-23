# Bounded publication throughput

The 4.11.0 release remains bound to `6b5aad0` and its retained artifacts. Its first npm upload took about 112 seconds; removing registry lookup overhead does not remove that serial upload bottleneck. This follow-up changes future publication tooling only.

Use opt-in concurrency of three in the release workflow. Compute dependency-respecting batches from retained runtime and peer dependency metadata before any upload. Verify each batch completely before starting dependent packages. Keep the CLI default sequential for existing callers.

Serialize outcome-file writes. On any failure, wait for all admitted publications to settle and retain their individual outcomes, then stop before another batch. Preserve exact source/artifact checks, per-package upload limits, no blind retries, and reconciliation of already-published versions.

Tests must prove dependent packages wait for verified dependencies, independent uploads overlap within the limit, concurrent results survive persistence, and one failed upload prevents later work without abandoning in-flight reconciliation. Existing release regressions must still pass. Validate the workflow and run the full CI suite for the final follow-up commit.

## Verification

- Focused regressions reproduced missing concurrency before implementation; concurrency, dependency order, and draining passed afterward.
- All 40 release metadata/tooling tests pass, including existing artifact-integrity, timeout, partial-publication and resume tests.
- Biome, syntax checks, actionlint and diff whitespace checks pass.
- No files under `packages/` differ from the 4.11.0 tag. The final main-branch CI run will verify the follow-up on Node 22 and 24.
- The in-progress 4.11.0 workflow keeps its original sequential implementation. Future workflow runs opt in with `--publish-concurrency 3`; the CLI default remains one.
