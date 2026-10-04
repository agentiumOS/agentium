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

Timeout/cancellation results preserve the case name and input and report `failureKind`. JavaScript callbacks cannot be forcibly terminated: `cleanupPending: true` means a callback ignored cancellation and has not settled. Explicit Agent session IDs remain reserved until their pending run settles; overlapping reuse fails with an infrastructure result. Other cases receive isolated generated session IDs. Callbacks must cooperate with cancellation and avoid shared mutable state.

Successful evaluation requires a completed run, every scorer's explicit `pass: true`, and the configured threshold. Scores must be finite numbers from 0 to 1; malformed results fail the case even at threshold zero. Judging accepts exact `PASS`/`FAIL`, a strict numeric result, or the JSON contract required by `llmJudge`. Conversation completion accepts only the exact `GOAL_COMPLETE` marker. Two failed comparison runs tie.

Reliability checks require successful tool results; denied/failed attempts do not count. `toolCallMatch` preserves attempted matching by default; choose `{ mode: "successful" }` to exclude failures/denials. Required performance limits are binary assertions; a missing required TTFT metric fails instead of disappearing. Heap delta remains informational.
