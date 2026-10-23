# Provider update verification

All three approved increments are implemented locally. The checks below passed on Node 22.23.1 and npm 10.9.8 on macOS. The starting SDK revision was `c6d52c5673beba25c2dddafcbbb28de7aa9e28c9`; the starting documentation revision was `e1acf01b3351bc9db1d53710d1b2851e429afe8e`.

## Completed checks

| Check | Result | Local receipt |
| --- | --- | --- |
| `npm run build` | All ten workspaces built | `/tmp/agentium-provider-build.log` |
| `npx tsc -p packages/<package>/tsconfig.json --noEmit --pretty false` for all ten workspaces | Passed, including test source | `/tmp/agentium-provider-types.log` |
| `npx biome ci .` | Passed. One existing informational `useTemplate` notice remains in the unrelated harness execution-planning test | `/tmp/agentium-provider-lint.log` |
| `node plans/provider-updates-2026-10-24/verify.mjs` | 298 tests passed in 10 files | `/tmp/agentium-provider-focused.log` |
| `node plans/provider-updates-2026-10-24/verify.mjs --full` | 3,181 tests passed, 40 skipped. 272 files passed, 11 skipped | `/tmp/agentium-provider-full.log` |
| Focused runner after local commits | 298 tests passed again | `/tmp/agentium-provider-postcommit.log` |
| `npm run test:package` | Four tests passed in two files, including ESM, CommonJS, public types, and missing optional SDK behavior | `/tmp/agentium-provider-packages.log` |
| `node --test scripts/release-lock.test.mjs scripts/cjs-declarations.test.mjs scripts/release-artifacts.test.mjs` | 30 tests passed | `/tmp/agentium-provider-metadata.log` |
| Baseline tariff comparison | All 290 prior non-Decisions rule objects and the catalog expiry remained unchanged | `/tmp/agentium-unchanged-pricing.log` |
| Documentation `npm run check` | 389 MDX pages passed, plus generated-content checks | `/tmp/agentium-docs-check.log` |
| Documentation `npm run validate` and `npm run check:links` | Build validation passed and no broken links found | `/tmp/agentium-docs-validate.log`, `/tmp/agentium-docs-links.log` |
| Documentation `npm run check:imports` | 702 static SDK imports passed | `/tmp/agentium-docs-imports.log` |
| Documentation `npm run check:examples` | 320 complete examples type-checked against the final SDK build | `/tmp/agentium-docs-examples.log` |
| `git diff --check` in both repositories | Passed | Parent check |

`checked-files.sha256` records the checked implementation, test, and guide bytes. Temporary logs are local supporting receipts. The counts and commands in this record remain available in Git after those logs expire. Independent code and comment reviews are retained in `reviews/`.

The implementation commits are `9ce0e38` for Google, `ca782ff` for accounting, and `4e645b8` for Decisions. The separate documentation commit is `19abd80`. Comparing each implementation commit with its pre-commit hook backup found no byte changes in its owned files. The final hashes also passed after committing.

The full suite includes the existing MCP lifecycle/protocol tests and harness native-recovery tests. The skipped tests remain gated by external services, optional host SDK fixtures, or the separate packed-consumer flag. The packed-consumer tests passed in their explicit run. This is implementation verification, not the Linux Node 22/24 release matrix or a live-service integration run.

## Behavior proved

- Real installed SDKs serialize requests to controlled local HTTP servers. Google tests cover Argon option rejection, thinking levels, continuation failures, late usage, native call IDs, and complete signed replay across multiple stream chunks.
- Native Decisions input preserves roles, JSON evidence, tool history, image limits, cache controls, and constructor/per-call settings. Invalid input fails before transport. Invalid responses and post-response cancellation retain available usage.
- Decisions ordinary input, cache reads, and cache writes remain disjoint. The 1,000-token fixture with 800 reads and 100 writes costs exactly `0.0000305` USD at the reviewed standard rates.
- Saved assessments retain their original evidence. Unknown aliases, unsupported tariff dimensions, and stale catalogs remain unpriced.

## Review and scope decisions

Independent code review found one replay defect. A terminal Google stream chunk replaced earlier signed parts. Three failing regressions reproduced it through the real SDK. The final implementation accumulates parts and derives tool-call completion from the whole turn. The reviewer repeated the second serialized request and found no remaining actionable code or specification issues.

Argon capability checks accept `gemini-4-argon` and `models/gemini-4-argon`. The current model reference lists no concrete version suffix. The implementation does not infer one from the planning document's broader wording.

The native Decisions examples construct `OpenAIDecisionsProvider`. The registry factory retains its generic `ModelProvider` return type, so existing custom provider registrations remain valid.

The documentation site still targets 4.9.0. Companion guides clearly mark new behavior as unreleased after 4.10.0. Generated API reference, installation pins, and package versions remain unchanged. Regeneration against the next published version belongs to the later release operation.

The unavailable `deslop` skill was replaced by direct diff cleanup checks. The obsolete beta input converter, unused Google parameter, and stale billing comments were removed. The implementation reuses one Decisions validation/transport path and the existing accounting resolver. No new production dependency or provider framework was added.

No credentialed provider calls, live billing reconciliation, performance comparison, package publication, push, tag, or documentation deployment occurred. Long-decode orchestration, background Interactions, automatic routing, and broader model integrations remain deferred.

## Poteto principles applied

- Model the Domain led to typed native Decisions evidence instead of widening generic chat input.
- Boundary Discipline placed validation before SDK dispatch and kept one transport path.
- Subtract Before You Add removed the obsolete Decisions converter before adding native evidence.
- Laziness Protocol and Minimize Reader Load kept existing SDK clients and accounting structures instead of adding another abstraction layer.
- Experience First led to actionable preflight errors, preserved usage on failure, and runnable examples.
- Prove It Works required the second serialized tool request and packed consumers, beyond passing TypeScript.
- Build the Lever produced `verify.mjs` for repeatable focused and full checks.
- Sequence Work into Verifiable Units separates the three implementation increments and documentation into local reviewable commits.

The independent reviewers used generic inherited models. Their exact served models and model-family diversity are unverified. No cross-turn sticky hook was verified.

The final [decision-trail audit](reviews/decision-trail-audit.md) has no remaining flags. It independently checked the final receipts, all 25 file hashes, and the local implementation/documentation commits. The earlier pending gates and scope questions are resolved.
