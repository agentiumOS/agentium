# @agentium/eval

Evaluation framework for testing and scoring Agentium agent outputs.

## Install

```bash
npm install @agentium/eval
```

## Quick Start

```typescript
import { EvalSuite, contains, regexMatch } from "@agentium/eval";

const suite = new EvalSuite({
  name: "basic-tests",
  agent: myAgent,
  cases: [
    { name: "arithmetic", input: "What is 2+2?", expected: "4" },
    { name: "greeting", input: "Say hello", expected: "hello" },
  ],
  scorers: [contains("4")],
});

const results = await suite.run();
```

## Documentation

Full docs at [docs.agentium.in](https://docs.agentium.in)

## Community

Join the conversation on [Discord](https://discord.gg/T86SJshP).

## License

MIT

## Required reliability checks

Reliability cases pass only when every required assertion passes and the score meets the configured threshold. All expected tools must be called. A nonempty answer cannot compensate for a missing tool, stopped run or failed assertion. Timeouts and caller cancellation abort the Agent request and remain infrastructure failures, even when a case expects an Agent error.

## Evaluation lifecycle and result rules

Every case has one deadline covering Agent execution, model judging, synthetic conversation turns and scorers. `timeoutMs` (default 30 seconds), concurrency (default 1), and conversation turn limits must be positive finite integers; thresholds must be finite values from 0 to 1. A suite `signal` and a case `runOpts.signal` both cancel work. Built-in model calls receive that signal. Custom scorers can accept the optional fourth `{ signal, deadline }` argument, including through `custom()`.

Timeout/cancellation results preserve the case name and input and report `failureKind`. JavaScript callbacks cannot be forcibly terminated: `cleanupPending: true` means a callback ignored cancellation and has not settled. Explicit target session IDs remain reserved until their pending run settles; overlapping reuse fails with an infrastructure result. Other cases receive isolated generated session IDs. Callbacks must cooperate with cancellation and avoid shared mutable state.

Successful evaluation requires a completed run, every scorer's explicit `pass: true`, and the configured threshold. Scores must be finite numbers from 0 to 1; malformed results fail the case even at threshold zero. Judging accepts exact `PASS`/`FAIL`, a strict numeric result, or the JSON contract required by `llmJudge`. Conversation completion accepts only the exact `GOAL_COMPLETE` marker. Two failed comparison runs tie.

Reliability checks require successful tool results; denied/failed attempts do not count. `toolCallMatch` preserves attempted matching by default; choose `{ mode: "successful" }` to exclude failures/denials. Required performance limits are binary assertions; a missing required TTFT metric fails instead of disappearing. Heap delta remains informational.


## Structural targets and grading coverage

The existing `agent` configuration property accepts `EvalTarget`: any object with
`run(input: MessageContent, opts?: RunOpts): Promise<RunOutput>`. Ordinary `Agent`
instances remain compatible. Multimodal inputs and run options pass through.
Reservations use target object identity until the actual run settles; wrappers
sharing one backend must share a reservation owner or use the backend's session
locking. A timeout never starts another generation or judge retry.

`ScorerResult.status` normalizes legacy valid returns to `graded`. A valid
`score: 0, pass: false` remains a graded task failure. Thrown scorers, malformed
scores, and invalid model judge responses are `infrastructure_error`; the case
has `gradingStatus: "incomplete"`, fails, and reports `failureKind: "infrastructure"`.
Lifecycle timeout/cancellation keeps its own classification. Completed output is
retained if a later judge times out or cancels.

Legacy `passed`, `failed`, `total`, and `averageScore` remain available. `total`
is the scheduled execution denominator, including cancelled cases.
`gradedCases` counts cases with complete valid grading; `infrastructureFailures`
counts infrastructure-classified cases separately from timeout/cancellation.
`gradedAverageScore` averages valid scores in completely graded cases and is
`null` if none are available. Prefer these coverage fields when comparing task
quality; missing grading cannot become a pass or a task-quality zero.

The optional harness adapter comes from `@agentium/harness/testing`:

```typescript
import { EvalSuite, custom, toolCallMatch } from "@agentium/eval";
import { createHarnessEvalTarget } from "@agentium/harness/testing";

const target = createHarnessEvalTarget({
  config: applicationHarnessConfig, // host-owned model, tools, policies and budgets
  identity: verifiedIdentity,
});
const suite = new EvalSuite({
  name: "harness-verification",
  agent: target,
  cases: [{ name: "requires test evidence", input: "Complete the change" }],
  scorers: [
    toolCallMatch(["run_tests"], { mode: "successful" }),
    custom("trace-complete", async (_input, output) => {
      const pass = target.observation(output)?.toolCallCoverage === "complete"
        && output.status === "completed";
      return { score: pass ? 1 : 0, pass };
    }),
  ],
});
```

The adapter accepts `sessionId`, `signal`, and `runMode`, plus `userId`/`tenantId`
only when they match its captured verified identity. Other specified `RunOpts`
fail with `HarnessUnsupportedError`; configure authority, history, models and
services on the host harness. Explicit sessions continue canonical harness
history. Each run owns its observer; borrowed resource pools remain host-owned.

Tool observations retain only bounded IDs, names, errors and denials, with source
payloads omitted. Defaults are 128 tools and 65536 serialized metadata bytes.
`toolCallCoverage: "partial"` means overflow, observer error, or a failed/cancelled
run prevents establishing complete observation. A partial prefix cannot prove
that forbidden effects were absent. Successful settlement alone cannot establish
business success such as a process returning exit code zero. Validate host
execution records with a completion verifier for that requirement. Native failed
maps to `error`, legacy awaiting-input maps to `stopped`, and TTFT is absent when
not measured. Harness and core have no evaluation dependency.
