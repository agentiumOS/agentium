# Agentium 4.9.0 release preparation

The candidate integrates core/harness dependability, context continuity, Workflow dependency graphs, and opt-in recoverable execution graphs with upstream 4.8.3. All ten public workspaces and their internal peer ranges target 4.9.0. The [changelog](../../CHANGELOG.md) records behavior, compatibility changes, and recovery limits.

## Verification and publication

The release pipeline must resolve the requested semantic-version tag to one immutable commit, verify matching workspace and lockfile metadata, and run the complete Node 22/24 Linux matrix. That matrix includes source and fixture types, lint, default tests, disposable MongoDB/Redis/PostgreSQL integration tests, packed consumers, and the pinned Node 24 sandbox/OpenTelemetry fixtures.

Only the Node 24 job retains distribution tarballs. Existing ESM, CommonJS, TypeScript, optional-peer absence, CLI scaffold, and graph behavior consumers test those exact tarballs. A subsequent verification job binds the manifest hash to the completed matrix. The privileged publish job downloads the same run's artifacts, verifies source identity and every tarball, and publishes without rebuilding.

`scripts/release-artifacts.mjs` provides `preflight`, `pack`, `verify`, and `publish` commands. Store artifacts outside the source checkout. A manifest records source/lockfile fingerprints, toolchain, package versions and metadata, file inventories, byte counts, SHA-256, SHA-1 and npm integrity. Verification is distinct from publication authorization.

The CI workflow can also be dispatched with an immutable candidate commit and artifact retention enabled. This runs the same checks and retains the tested packages without a release tag or publication. Tag publication still runs its own full matrix and uses that run's retained bytes.

## Recover a partial publication

Before uploading any package, reconcile all requested registry versions. A version is missing only after a registry 404. Skip an existing version only when its registry evidence and served bytes match the retained artifact. Stop on differing bytes or unknown network outcomes. After an upload succeeds, fails or times out, reconcile the registry again before proceeding. Retain per-package outcomes; do not create a replacement version to hide an uncertain upload.

An accepted upload can precede registry visibility. Publication tooling waits up to three minutes on a monotonic deadline after the single upload, polling only missing registry reads. Metadata and tarball reads use the remaining deadline. Mismatches and unknown registry responses stop immediately; visibility expiry retains the unresolved outcome. This wait never repeats an upload.

An operator can select a longer bounded visibility window with `--reconciliation-timeout-ms`, for example `600000` for ten minutes. The CLI accepts only positive integer milliseconds up to `600000`; without this option, the three-minute default remains. Select this deadline when registry evidence shows accepted uploads becoming visible after the default window. The override changes only how long missing registry reads are polled. It preserves the immutable release source, retained package bytes, single upload attempt, and immediate stop on unknown or mismatched registry evidence.

Manual recovery can execute the trusted workflow revision's publication tooling against a separate checkout of the immutable release tag. The full verification matrix and retained artifacts still identify that release source, and the tooling tests run before publication. This permits a publication-tool correction without moving an existing tag or rebuilding already verified package bytes.

Publication and channel/release creation are separate steps. A manual workflow retry must use the same release identity. The current candidate has no production launch or live-model quality claim. The application still owns destination reconciliation, authenticated scope, host executable versions, persistent-store operation and cooperative cancellation.

For a failed publication, rerun the full workflow so the verification jobs retain artifacts for the new run attempt. Retrying only the failed publish job cannot use an earlier attempt's artifact and stops without uploading. If rebuilding produces different bytes for any already published package, registry reconciliation stops the release; investigate the mismatch instead of bypassing it.

## Documentation promotion

The documentation repository targets 4.9.0 with an explicit preparation status. Its generated reference, runnable graph recipe, continuity guide and migration guide use the matching SDK. Pin its verification source to the prepared release commit. After actual registry/package validation, update preparation notices and the documentation source reference before promoting the site. Do not infer npm availability from version strings or a local build.

Local verification evidence and artifact manifests are retained with the release workspace. Remote CI results must identify the exact candidate commit; an earlier successful branch run or a moving main reference is insufficient.
