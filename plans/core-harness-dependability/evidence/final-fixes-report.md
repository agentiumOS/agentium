# Final repair wave

Scope: isolated worktree `/Users/xerycks/.codex/worktrees/core-harness-dependability/agentium`, branch `agent/core-harness-dependability`, base `suppliedsnapshot531013327a0f7136b4eb8446ff1b302bf6f9ca51`. Source handed back for scoped review; no commit, push, workspace dependency installation, live provider call, or original-checkout edit was performed.

## Repairs

1. `packages/core/src/agent/llm-loop.ts`: check cancellation immediately before publishing the raw chunk, after the generator can suspend on public message events. The existing catch path still publishes `message.failed` for an unfinished message. Settled usage is carried through `LoopCancelledError`; output accounting logic is unchanged.
   - New direct exported-loop tests use `publicMessageEvents=true` and `maxToolRoundtrips=0` with a null tool executor.
   - Abort after the last delta: the next item is the cancelled failed-message event, followed by a cancellation error with zero unobserved usage; model error observation remains cancelled.
   - Abort after the last completed message: the next iteration rejects rather than yielding the raw finish, preserving the hand-derived settled usage `{promptTokens:2,completionTokens:1,totalTokens:3}`.
2. Published documentation: harness files include `DEPENDABILITY.md`; core files include exactly `src/storage/README.md` and `src/workflow/README.md` in addition to dist. The new optional sibling-package and source-fixture/test links use explicit `https://github.com/agentiumOS/agentium/blob/main/...` repository URLs. Included same-package guide links stay relative. Existing unrelated links and lifecycle cancellation prose are preserved.
   - Actual packed baseline/optional-eval fixtures now check harness README -> dependability guide and dependability guide links. All three fixture modes check core README -> included storage/workflow guides and its portable optional harness link.
   - The consumer assertions open included guides from installed package files, require local links to remain inside that package, and check repository-linked targets exist with nonempty content in the source tree. They do not claim an HTTP check of future published main-branch contents.
3. Existing cost DX lifecycle tests now expect `AgentLifecycleError` / `AGENT_BUSY` while admitted provider or hook work remains blocked. They verify no owned tracker close before gate release, retain late-hook metering, verify completed run totals `0.072` / `0.144`, and close exactly once afterward. Production `Agent.close()` was not changed.

## Evidence

All commands were run from the isolated worktree. Parent retains ownership of the rebuilt full-suite/package gates.

| Check | Observed result | Evidence |
| --- | --- | --- |
| New direct-loop regression before guard | 2 intended failures: raw text leaked after delta; raw finish resolved after completion | `final-loop-red.log` |
| Packed documentation assertions against original files allowlists | Exit 1, 2 intended failures: installed harness `DEPENDABILITY.md` absent; core storage README absent | `final-package-red.log` |
| `npx vitest run packages/core/src/agent/__tests__/publication-cancellation.test.ts packages/core/src/agent/__tests__/protocol-terminals.test.ts packages/core/src/cost/__tests__/agent-cost-dx.test.ts` | Exit 0, 3 files / 23 tests passed | `final-focused-green.log` |
| `AGENTIUM_TEST_PACKAGES=1 npx vitest run packages/harness/src/__tests__/package-consumption.test.ts -t 'eval=false|ordinary packed core'` | Exit 0, baseline + core-only passed, optional-eval deliberately filtered (1 skipped) | `final-package-green.log` |
| `npm pack ./packages/core --ignore-scripts --dry-run --json` and harness equivalent, parsed to assert exact new guide paths | Exit 0; core 956 entries contains both guides; harness 100 entries contains dependability guide | `final-pack-dryrun.log` |
| `npx biome check` on owned TS + manifests | Exit 0, 6 files checked, no fixes | `final-biome.log` |
| `npx tsc -p packages/core/tsconfig.json --noEmit --pretty false` | Exit 0, no diagnostics | `final-core-typecheck.log` |
| `npx tsc -p packages/harness/tsconfig.json --noEmit --pretty false` | Exit 0, no diagnostics | `final-harness-typecheck.log` |
| `git diff --check` | Exit 0, no whitespace errors | Executed after final source formatting |

The first loop-red logging command ended with `cat`, so its shell wrapper returned 0; the captured Vitest output explicitly reports both intended assertion failures. All subsequent verification wrappers propagate the checked command's exit status. Initial owned-file checks found formatting and optional-event-status typing in the new fixture; those were corrected, then core types, Biome and affected focused tests were rerun successfully.

Packed tests used only offline temporary fixture installations of locally packed existing dependencies with lifecycle scripts disabled; no workspace package install or lockfile edit was made. Packed runtime behavior consumed the prior successful build; parent must rebuild changed core before final package behavior claims. No full monorepo test/build gate was duplicated here.
