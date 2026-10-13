# M1 core execution integrity implementation report

Implemented in `/Users/xerycks/.codex/worktrees/core-harness-dependability/agentium` only. No commits, installs, provider calls, publication, or edits to parent-owned barrels/README/harness/workflow. Other workers concurrently modified their owned areas. Agent was explicitly handed back to the parent after execution work; later lifecycle edits belong to the parent.

## Changed files and behavior

- `packages/core/src/session/incremental-session-manager.ts`: metadata initialization/recovery scans exact numeric loose keys and combines their high-water sequence with validated metadata and snapshot watermarks. Loose records surviving failed metadata/batch writes are preserved. Recomputes uncollapsed append count above the snapshot watermark, rejects unsafe/exhausted sequence allocation before writes, preserves Date hydration/legacy array snapshots, supports forced snapshot of orphan logs, and sorts numerically beyond the ten-digit padding. Existing instance-local locking remains; cross-manager one-writer ownership is host responsibility.
- `packages/core/src/session/__tests__/incremental-session.test.ts`: JSON-cloning fault storage; failure at each write of a three-message batch and metadata acknowledgement; missing/behind metadata; orphan forced snapshot; post-snapshot leftovers; invalid metadata/snapshot watermarks; exhausted loose sequence; ordering beyond padding. Existing colon-prefix isolation, cleanup failure, Date and legacy behavior coverage retained.
- `packages/core/src/agent/types.ts`: exact additive `providerFinishReason?: string`, `partial?: boolean`, `reason?: { code: string; message: string }`; status union retained. Documents cap zero as model-answer opportunity without tool effects.
- `packages/core/src/agent/llm-loop.ts`: validates nonnegative safe-integer caps; admits whole tool batches via shared controlled counter or invocation-local ordinary counter; preserves the inclusive final-answer request opportunity. Guards after model accounting, host hooks/observers, before publication/dispatch and final acceptance. Stream guards prevent accepting the next chunk after abort and close provider iteration cooperatively. Usage already reported is carried through cancellation even without a configured accounting tracker.
- Loop terminal behavior: length/content_filter preserve text and usage, return stopped + partial + provider finish reason + stable provider_length/provider_content_filter reason. Truncated commentary cannot automatically continue. Any stream without a finish frame, including empty/text-only/tool fragments, throws `ModelProtocolError` with `code: incomplete_stream`, text, known usage, partial, reason and an `output: RunOutput` with status error. Unfinished tool fragments never dispatch.
- `packages/core/src/agent/agent.ts` (execution changes only, handed back): post-hook/output-guard/accounting completion cancellation guards; final usage retained in cancelled output without a ledger; partial terminal metadata flows into Agent streaming output; missing-finish error carries complete Agent partial text/known usage and error event output. Reflection does not automatically invoke another model after stopped output. Parent now owns subsequent lifecycle edits.
- `packages/core/src/agent/__tests__/loop-boundary-parity.test.ts`: ordinary/controlled × run/stream cap zero/one and final opportunity; invalid cap rejection; length/filter partial metadata; empty/text/tool missing finish; hook/provider cancellation with and without accounting; streamed hook cancellation, iterator close, metadata aggregation and prior-round partial usage; truncated-commentary no-continuation.
- `packages/core/src/cost/cost-tracker.ts`: string checkBudget overload, checkInProgressBudget, isBudgetExceeded and estimateRemaining call one canonical-accounting guard before absent-budget/warn early returns. Canonical queries/object admission remain unchanged. Updated local method TSDoc to make legacy-only status explicit.
- `packages/core/src/cost/__tests__/cost-tracker.test.ts`: canonical measurement tests with and without legacy budget assert all four reads throw IncompleteCostError; observational usage remains available; legacy values/admission behavior stay unchanged.
- `packages/core/src/team/team.ts`: ordinary coordinator requests pass signal to meteredGenerateFor; controlled coordinator requests also pass the same signal. Post-generation and final completion guards prevent cancelled synthesis completion or later delegation while retaining metered usage.
- `packages/core/src/team/__tests__/team-cancellation.test.ts`: real Agent member fixture; cancellation during coordinator plan/synthesis; signal parity, no complete event/no subsequent delegation, known coordinator usage retained.

## Red/green evidence

Initial red command (before runtime corrections):

`npx vitest run packages/core/src/agent/__tests__/loop-boundary-parity.test.ts packages/core/src/session/__tests__/incremental-session.test.ts packages/core/src/cost/__tests__/cost-tracker.test.ts`

Completed exit 1: 3 files failed; 28 failed / 29 passed (57 total). Intended failures showed ordinary cap-zero tools executed, invalid caps accepted, length/filter lacked metadata/stopped, text/empty missing-finish streams completed, late provider/hook/guard abort completed, metadata acknowledgement failures overwrote loose A records, invalid watermarks were accepted, and canonical legacy budget reads returned allowance. Controlled cap coverage and existing cases provided passing characterization.

First green of same command: completed exit 0, 3 files / 57 tests passed.

Team-specific red command:

`npx vitest run packages/core/src/team/__tests__/team-cancellation.test.ts`

Completed exit 1: 2 tests failed. The plan call received undefined signal; late synthesis returned successful output after abort.

Expanded Agent/session/Team/cost regression command:

`npx vitest run packages/core/src/agent/__tests__ packages/core/src/session/__tests__ packages/core/src/team/__tests__ packages/core/src/cost/__tests__/cost-tracker.test.ts packages/core/src/__tests__/cost-tracker-incremental.test.ts`

Completed exit 0: 22 files / 229 tests passed. This ran before the final small sequence tests, truncated-commentary guards and TSDoc additions, and before parent lifecycle integration.

Final focused command after those changes:

`npx vitest run packages/core/src/agent/__tests__/loop-boundary-parity.test.ts packages/core/src/agent/__tests__/controlled-loop.test.ts packages/core/src/session/__tests__/incremental-session.test.ts packages/core/src/cost/__tests__/cost-tracker.test.ts packages/core/src/__tests__/cost-tracker-incremental.test.ts packages/core/src/team/__tests__/team-cancellation.test.ts`

Completed exit 0: 6 files / 86 tests passed.

Final owned-file lint:

`npx biome check packages/core/src/agent/llm-loop.ts packages/core/src/agent/types.ts packages/core/src/agent/__tests__/loop-boundary-parity.test.ts packages/core/src/session/incremental-session-manager.ts packages/core/src/session/__tests__/incremental-session.test.ts packages/core/src/cost/cost-tracker.ts packages/core/src/cost/__tests__/cost-tracker.test.ts packages/core/src/team/team.ts packages/core/src/team/__tests__/team-cancellation.test.ts`

Completed exit 0: 9 files checked; no fixes. Earlier execution Agent file also passed scoped Biome (before handoff).

`npx tsc -p packages/core/tsconfig.build.json --noEmit --pretty false`: completed exit 0 twice, most recently after final owned edits.

`git diff --check`: completed exit 0 after final owned edits (includes concurrent workers' tracked diff).

An earlier full core source-and-test `npx tsc -p packages/core/tsconfig.json --noEmit --pretty false` exited 2 while other workers were in red. My then-reported nonexistent public-message event comparison and test fake-store signature errors were repaired. Remaining output then included incomplete memory/workflow worker APIs and embedding test mock tuple errors. Do not interpret source-only tsc as a full source/test/monorepo build pass. Parent should rerun combined checks after all workers settle.

## Integration requirements and limits

- Parent root export candidate: `ModelProtocolError` from `agent/llm-loop.ts`. `LoopCancelledError` and `LoopStreamOutcome` are module exports consumed internally by Agent; no root export is needed for them.
- RunOutput types are ready and parent was notified before harness integration. Parent must preserve stopped/reason/partial/providerFinishReason through harness Agent adapter and terminal results; missing-finish Agent errors expose partial evidence in `.output`.
- Parent owns README/barrel changes, full build, package consumers, full monorepo source/test type checks and combined final verification. Parent owns Agent M3 lifecycle now; Agent was not touched after handoff.
- Standalone caps reset per invocation; controlled counts persist on the same loop across revisions. Existing commentary-only stop responses retain inclusive model-iteration behavior; a tool cap is an effect-batch limit, not a separate commentary request budget.
- Recovery scans repair failed local metadata acknowledgement; they do not serialize independent managers or add storage CAS/transactions. Numeric key filtering preserves colon-prefix sibling isolation. Host one-writer ownership is required across managers.
- Cancellation is cooperative. Already-applied effects/persisted exchanges are retained, no forced termination or rollback is claimed. A structural provider that ignores its signal can still keep waiting until it settles.
- Known usage means provider-reported display counts/settled canonical evidence; missing usage does not establish a zero bill. Existing canonical accounting retains unknown usage when adapters supply no complete evidence.
- No new legacy budget call sites were found in Agent/Team. Existing canonical model accounting owns asynchronous ledger admission/reservations; no observational read was replaced with a reserving call.

## Extended verification and settlement correction

Parent/M4 extended checks exposed a streaming-handoff regression at `handoff/__tests__/streaming-handoff.test.ts:490`. Red reproduction: 20 tests, 1 failed; target cancellation history contained only transfer, losing target-work. Root cause was the new abort guard before tool-result observation/journaling. The existing finally fallback only copied a transfer-containing batch, while a target's ordinary settled effect batch was equally required as canonical history evidence.

Corrected the two loop finally fallbacks: on cancellation, append every settled missing result directly without launching further host hooks, model work or effects; preserve existing transfer fallback otherwise. No Agent file change was required. Added owned run/stream regressions first: both failed with assistant-only transcript. After the correction, they retain the actual ToolExecutor terminal result (`[DENIED] Run cancelled`, its existing cooperative cancellation representation) and closed assistant/tool exchange. Existing streaming handoff now passes all 20 tests.

Also repaired Team cancellation fixture source/test typing with typed `vi.fn<ModelProvider["generate"]>` callbacks and explicit `TeamMode.Coordinate` (this had not been exercised by the source-only build tsconfig).

Latest expanded final check after settlement correction and parent lifecycle changes:

`npx vitest run packages/core/src/agent/__tests__ packages/core/src/handoff/__tests__ packages/core/src/session/__tests__ packages/core/src/team/__tests__ packages/core/src/cost/__tests__/cost-tracker.test.ts packages/core/src/__tests__/cost-tracker-incremental.test.ts`

Completed exit 0: 26 files / 302 tests passed.

Latest nine-owned-file Biome completed exit 0. A parent-added trailing empty line in types.ts was removed by its formatter. `git diff --check` completed exit 0. `npx tsc -p packages/core/tsconfig.build.json --noEmit --pretty false` completed exit 0 after the settlement correction.

Latest full core source/test tsc completed exit 2 with only vector/embeddings fixture/mock tuple typing errors; Team fixture and all other owned execution typing errors were absent. Those embedding fixtures are outside this worker's ownership and remain for parent disposition.
