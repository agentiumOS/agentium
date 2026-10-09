# Spec: live-input

## Objective
Pause a live runtime/Agent tool execution and resolve it once with a correlated
answer without rebuilding Agent state, history, replay data or budgets.

## Commands and structure
`npm run build`; `npm test`; `npm run lint`; `npm run test:package`.
Core execution ports live in packages/core/src/agent; runtime lifecycle in
packages/harness/src/runtime; fixtures and integration tests in adjacent __tests__.
Node 22/24, TypeScript, Zod, Vitest; no added dependencies.

## Contract and code style
`const answer = await services.requestInput({ question: "Which month?" });`
`await handle.reply(requestId, "September");`
Named exports, explicit public types, validated external input, optional core ports.
An exported requestInputTool lets built-in Agent users grant question access like
any other tool; custom tools may call the port directly.

## Success criteria and tests
Metadata → question → answer → same run and intact observations, exactly one
terminal event, no model polling. Unique run-scoped request IDs; stale, duplicate,
mismatched, oversized and finished-run replies fail with typed error codes.
Events input.requested, input.resolved and run.resumed correlate by request ID.
Cancel/deadline/input-timeout settle the pending promise and retain normal cleanup.
Absolute deadline includes all time; activeTimeoutMs excludes pending input;
inputTimeoutMs independently bounds each question. Waiting retains session lease.
Fake-clock tests cover cancellation races and timer cleanup.

## Boundaries
Always preserve budgets, run identity and opaque data. Ask first for unrelated
scope changes. Never persist live promises or retry tools for restart recovery.
Legacy terminal awaiting_input remains documented separately.
