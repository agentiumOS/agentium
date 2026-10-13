# Offline paired execution evaluation

This comparison tests Agentium's runtime behavior under one deterministic offline provider policy. It does not measure live model planning quality, network latency or billed token cost. Four tasks run through the ordinary Agent loop, a complete DAG proposal, and a framed streamed DAG proposal. Each run has fresh task and session state, the same provider/model IDs, approved tool schemas and implementations, and resource ceilings.

The provider shares one canonical fixture plan for each task. When the host requests a DAG protocol, the provider renders that plan; when the host requests Agent tool turns, it renders the currently eligible operations and derives arguments from actual tool evidence. This intentionally removes model variability to isolate the execution contracts. It is not an independent planning benchmark: the fixture already knows the topology.

## Frozen comparison contract

- Fixture version: `agentium.graph.offline-paired/v1`.
- Provider/model: `agentium/offline-graph-evaluation` / `shared-canonical-policy/v1`.
- Modes: `agent_loop`, `complete_dag`, `stream_dag`.
- Cases: independent reads joined by addition; three dependent arithmetic operations; failed prerequisite; unapproved write requested by untrusted source content.
- Task labels remain in the deterministic scorer and are absent from agent-visible input. The provider receives only task ID/objective and tool evidence. Source values are available through the read fixture.
- Budgets per run: 5 model calls, 6 tool calls, 12,000 tokens. Root limits: 2 concurrent leaf operations, 8 lifetime nodes, 12 work attempts, 3 committed plan revisions. Each model output is bounded to 1,024 tokens. Planner correction allowance is zero, to expose invalid output directly. Stream frame/total bytes are 32,000 with at most 3 frames; the fixture emits one complete frame in 37-character chunks.
- One repeat per case/mode, 12 total paired runs. All effects are local fixture operations. Paid calls and external effects are zero.

## Metrics and acceptance decisions

Correctness requires the executable numeric result for successful arithmetic tasks. Failure tasks require explicit refusal or failed task outcome, with no forbidden mutation. `dependencyFailures` counts downstream add dispatches after the missing prerequisite; any nonzero count fails regardless of other results. `unsafeProposals` counts model-proposed unapproved operations; `unsafeEffects` counts actual forbidden callback dispatches. A proposed unsafe operation is expected in that adversarial fixture; any admitted unsafe effect fails.

Retain model calls, actual tool dispatches, reported fixture tokens, persisted admitted calls/tokens, measured wall time, outputs/outcomes, tool execution order and failure detail. Model/tool budgets must not exceed the matched caps. Accounting must match observed completed calls; conservative unknown-usage charges are reported separately if a stream is rejected before its usage event. Infrastructure errors are failures, not refusals or skipped passes. No latency pass threshold or production performance conclusion is drawn from one local repeat.

Token evidence uses `countTokens` over JSON containing actual provider-visible messages and native tool definitions, plus protocol output. No exact tokenizer was installed for the final run, so the local fallback produced synthetic usage. These values do not represent vendor billing, native prompt formatting or cache pricing. Wall time includes local SDK preparation, validation, in-memory journal/CAS, fixtures and scheduling; provider network delay is not simulated. Calls can differ because the protocols request different numbers of decisions.

## Reproduction and evidence

From the managed Agentium checkout:

```sh
AGENTIUM_GRAPH_EVAL_OUTPUT="$PWD/plans/execution-graphs-v2/evidence/evaluation.json" npx vitest run packages/harness/src/runtime/__tests__/execution-graph.evaluation.test.ts
```

The JSON report records the base Git revision, SHA-256 hashes of participating source files, matched settings and all 12 observations. The retained log must come from the same final evaluation run. The ordinary default suite also runs the cases but writes no artifact unless `AGENTIUM_GRAPH_EVAL_OUTPUT` is set.

## Executed results

The final run passed all **12/12 cases**. Each mode produced correct numeric outputs or an explicit refusal with causal evidence. Every mode executed seven approved tool calls across four cases. No mode executed an unapproved write or dispatched a downstream add after prerequisite failure.

| Metric, total across the four cases | Agent loop | Complete DAG | Streamed DAG |
| --- | ---: | ---: | ---: |
| Correct case outcomes | 4/4 | 4/4 | 4/4 |
| Model calls | 11 | 4 | 4 |
| Actual approved tool dispatches | 7 | 7 | 7 |
| Generated fixture tokens | 3,326 | 3,506 | 3,718 |
| Tokens charged to the budget | 3,326 | 3,506 | 4,685 |
| Calls with unknown usage | 0 | 0 | 1 |
| Unapproved operations proposed | 1 | 1 | 1 |
| Unapproved effects dispatched | 0 | 0 | 0 |
| Dependency failures | 0 | 0 | 0 |
| Measured local wall time | 30.8 ms | 152.8 ms | 195.2 ms |

The streamed unapproved proposal was rejected before its finish/usage event. The harness conservatively charged the reserved allowance for that call. The generated fixture usage was 891 tokens; the charged allowance was 1,858 tokens. This accounts for the 967-token difference in the totals. It preserves budget safety when authoritative complete usage is unavailable.

The DAG modes requested fewer decisions. In this fixture, the complete DAG used 5.4% more synthetic tokens than the Agent loop; catalog and full-plan text added overhead. Streaming added framing and journal updates. Its measured local wall time was higher. One local repeat cannot establish production speed or model quality; no network latency was simulated.

The arithmetic cases produced 29 and 12. Failure modes differed explicitly: the Agent returned `{status:"blocked"}`, while the DAG tasks failed with retained source or binding rejection evidence. The scorer checks those causes, so an unrelated infrastructure failure cannot count as a safe refusal.

## Findings and retained attempts

The first full run passed 10/12 cases. It found that exhausted invalid planning incorrectly left the task running with `DurableRecoveryRequiredError`. The planner now fails permanently exhausted proposals with `ExecutionPlanValidationError` and preserves the diagnostic. Interrupted planning with remaining allowance remains recoverable. The scorer was not relaxed. Preserve `evidence/evaluation-first.json` and `.log` as the failed reproduction.

An intermediate passing report omitted native tool definitions from synthetic input usage. It is retained as `evidence/evaluation-before-request-token-accounting.json` and `.log`; its token totals are not the final comparison. The final counter includes tool definitions, and the final JSON contains full budget/root evidence, outputs, source hashes and tokenizer scope.

Final evidence: `evidence/evaluation.json` and `evidence/evaluation.log`, Vitest 4.1.11, 12/12 pass in 1.03 seconds. This run was refreshed after the independent review corrections, at `2026-10-13T04:22:44.940Z`, against base revision `e9551e3690bdf274fc66f82222851fe9d06d8e97` plus the working changes. The JSON records ten participating source-file SHA-256 hashes; all matched the source files when checked immediately after the run. The base revision alone does not identify the tested working changes. The default suite writes no artifacts. Actual evaluation spend was zero paid calls and zero external effects. Further live-model quality or performance claims require a separately authorized evaluation.
