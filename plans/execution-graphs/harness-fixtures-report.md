# Execution graph harness fixtures

Date: 2026-10-13. Managed checkout: `/Users/xerycks/.codex/worktrees/core-harness-dependability/agentium`; branch `agent/execution-graphs`. This contribution owns only `packages/harness/src/__tests__/execution-graphs.test.ts`, `scripts/compare-execution-graphs.ts`, and this report. No production runtime, API, types, docs, packed tests, build, commit, live model call, external write, push, merge, publication, or deployment was performed by this contributor.

Applied guidance: Test Driven Development (including writing-good-tests), TypeScript, Agent Evaluations, Systematic Debugging, and Verification Before Completion from the original checkout's read-only `.agents/skills` files. No applicable `AGENTS.md` was found. Contracts read from `plans/execution-graphs/design.md`, `plan.md`, the SDK/evaluation inventory, and frozen core workflow types. Coordinator clarified encoded path segments, `metadata.workflowExecutionPath`, repeat paths such as `repair/0/episode/node/step`, and additive aggregate `workflow_iteration_limit` propagation through the existing driver/evaluation target.

## RED evidence

Executed before the coordinator's integration build:

```text
npx vitest run packages/harness/src/__tests__/execution-graphs.test.ts -t 'starts data-ready successors'
exit 1; 1 failed, 8 skipped (the fixture file then contained nine tests).
Expected started tasks ["A", "B"]; observed [].
```

This used the previously built `@agentium/core` baseline, as existing harness fixtures do. A direct built-core Workflow probe containing a single graph node confirmed the missing graph route:

```json
{"state":{},"stepResults":[{"stepName":"episode","status":"error","error":"step.run is not a function","durationMs":1}],"status":"failed","reason":{"code":"workflow_step_failed","message":"One or more Workflow steps failed"}}
```

The real harness driver maps that aggregate outcome to failed status without executing nodes. The focused test's failing admission assertion is therefore the intended missing graph behavior, not a provider/network/setup failure. All fixture providers are offline and task keyed.

## Fixture method and coverage

The ten source integration cases exercise real Workflow, workflowDriver, HarnessRuntime, ordinary Agent and ToolExecutor execution. Only provider responses and safe primitive fixture records are substituted. Each provider response is selected by the current task and tool phase, never a shared response index. Gates are explicitly released in cleanup. Agent instances are closed. Literal expected states/call counts are independently derived.

Covered contracts:

- Incremental readiness in A/B → C(A), D(A/B) → E(C/D), with maxConcurrency 2 and safe read tools. C starts while B is held; D starts while C is held; E waits for both. Data-only edges and transitive ancestor inputs are checked. All five tasks execute once.
- Concurrent global model admission admits at most two of three ready Agents and blocks a consumer requiring all three. Accepted independent states account for timing-dependent budget admission; the fixture does not promise a deterministic winner.
- Repeat graph episodes retain the same global model and tool ledgers, release reservations, and scope Agent sessions/metadata by iteration. Tool denial is measured from actual settlements; the deterministic provider may still answer after denial, so this test makes no false assertion that every denied tool forces an Agent failure.
- Cancellation after a controlled fixture effect applies drains the held callback, discards its late patch, admits no consumer, and yields exactly one cancelled terminal result.
- A controlled function applies then rejects acknowledgement under configured retryPolicy. It applies once, its consumer is blocked, and evaluation retains failed/partial observation and the error settlement. This fixture records the rejection; it does not claim a durable unknown-outcome receipt or safe replay.
- Node/user/tool instruction text stays in data messages. System host fragments, verified identity, plan mode, and scoped child metadata remain authoritative. Grant-shaped predecessor data cannot authorize an ungranted dependent function effect.
- Distinct encoded node IDs scope duplicate Agent step names and child history while the legacy `<step.name>_output` key remains intact; the ordered overwrite is dependency comparable.
- The unchanged createHarnessEvalTarget reports failed repeat exhaustion with `workflow_iteration_limit`, exactly two effects, truthful structured/text state and partial observation. Direct Agent.run and the existing Agent driver/evaluation caller remain working.

The primitive tools are isolated deterministic reads or writes to test-owned counters/keys with explicit prerequisites. Graph independence does not make arbitrary writes to shared host resources safe. These tests establish only the covered SDK contracts, not durability, exactly-once external effects, mid-episode recovery, live LLM quality, production latency, or release readiness.

## Offline comparison

`scripts/compare-execution-graphs.ts` is a reproducible structural comparison using the existing public Agent/Workflow harness adapters and evaluation target. Three paired cases cover chain, fan out, and the shared prerequisite DAG. Both conditions receive the same task manifest and run the same provider implementation, primitive tool, host grants, budgets (`16` model calls, `16` tool admissions, `128` tokens, zero revisions), output/roundtrip caps and isolated state. The old Agent loop may request all currently ready independent tools in one batch; the graph uses maxConcurrency 2.

Output includes exact normalized/raw outputs, statuses/reasons, task/effect/model request ledgers, duplicate/dependency errors, model/tool admissions, declared tokens, unknown usage, reservations, observation coverage, primitive overlap, local wall time and costs. Failed/infrastructure rows retain their denominator. Unknown production billing is null; offline provider charge is zero. There is one deterministic run per case/condition, no judge, and no stochastic variance claim. Local wall time has no simulated provider delay and measures fixture overhead only; it is not a speedup estimate. The gated integration case establishes incremental readiness separately.

## Integrated verification

The coordinator notified this contributor after core and harness builds completed with exit zero. The contributor then ran only the scoped fixture:

```text
npx vitest run packages/harness/src/__tests__/execution-graphs.test.ts
exit 1; 9 passed, 1 failed (10 tests), 294ms test duration.
```

Log: `harness-fixtures-green.log` in this report directory. The only failure is one controlled deterministic function effect being charged twice: callback applications = 1, actual observed tool settlements = 1, budget.toolCalls.used = 2 instead of 1. This is a preexisting harness policy accounting issue exposed by the new graph fixture. `HarnessRuntime` gives the root context a wrapper executionPolicy that delegates to the budget-owning policy, while `dispatchEffect` also gives that policy to ToolExecutor. ToolExecutor intentionally evaluates distinct context/local policies, so the same `admitTool()` executes twice. The fixture assertion has not been weakened.

A minimal legacy single-function Workflow probe with `maxToolCalls: 1` confirms the functional consequence: applications = 0, status = failed, used = 1, structured = {}. The single permitted effect is denied by the second evaluation. Evidence was sent to the coordinator, who owns production integration changes.

The coordinator independently reproduced this on both direct dispatch and function-effect dispatch, then corrected the harness executors to reuse the same lazy context policy identity. Core composition of distinct local policies was preserved. The contributor reran the original fixture after this source correction:

```text
npx vitest run packages/harness/src/__tests__/execution-graphs.test.ts
exit 0; 10 passed (10 tests).
```

Final log: `harness-fixtures-final-green.log`. This proves the ten covered integration contracts against the coordinator-built core and the corrected harness source. The initial failing integration log is retained. This is a targeted source fixture pass, not a full suite/build/packed-consumer claim. The source state is a dirty `agent/execution-graphs` integration based on `f5e4434723c33f2610416bee789c78bb32787315`, with frozen types, graph-runner, StepRunner/repeat, aggregate limit reason and harness executor policy correction; HEAD alone does not describe the tested state. The coordinator owns final builds, broader checks, packed verification, review, and final-state comparison rerun.

Changed-file Biome check for the fixture passed after formatting. `scripts/**/*.ts` is excluded by the repository Biome includes, so the script was checked/formatted through stdin with an included TypeScript file path and `--write`; byte comparison confirms formatting is stable. No config change was made.

Executed comparison after that build:

```text
npx tsx scripts/compare-execution-graphs.ts
exit 0; covered exact outcomes pass; 6 condition executions, 0 failed/infrastructure rows.
```

Raw report: `harness-comparison.json`; stderr log is empty. All six rows have zero dependency violations, duplicate effects, unknown usage, and remaining model/token reservations. Offline provider spend is $0; production cost is unknown. Expected final values are chain 2, fan out 5, and shared dependency 7.

| Case | Condition | Model calls | Tool admissions | Declared tokens | Primitive peak | Local diagnostic wall time (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Chain | loop | 4 | 3 | 12 | 1 | 29.129 |
| Chain | graph | 6 | 3 | 18 | 1 | 3.405 |
| Fan out | loop | 3 | 3 | 9 | 2 | 1.340 |
| Fan out | graph | 6 | 3 | 18 | 1 | 1.716 |
| Shared dependency | loop | 4 | 5 | 12 | 2 | 1.328 |
| Shared dependency | graph | 10 | 5 | 30 | 1 | 1.702 |

These single-run local times include startup/order effects, use no simulated provider/tool latency, and are unsuitable for a speedup conclusion. Very short graph primitives do not necessarily overlap in this workload; the independently gated harness case proves simultaneous real Agent tool work and incremental readiness. The existing loop already overlaps tool batches. The graph spends more model calls/tokens here because each task receives an ordinary bounded Agent loop. Only correctness and structural measurements are established.
