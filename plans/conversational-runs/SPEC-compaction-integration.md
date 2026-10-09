# Spec: compaction-integration

## Objective and contract
Extend summaryContextPolicy with an explicit completed-tool-round grouping mode.
Keep default whole-turn grouping for compatibility. Retain host instructions,
original task, latest complete tool group and required replay data. Remove older
groups atomically; never split parallel calls/results or introduce fake turns.
Emit correlated compaction.started/completed/failed events only for actual work.
Use existing controlModel services and their aggregate model/token/cancel budgets.

## Commands, structure and style
`npm run build`; `npx vitest run packages/harness/src/__tests__/policies.test.ts packages/core/src/context packages/core/src/__tests__/context-compactor.test.ts`.
Reuse core conversation grouping/transform validation and harness policy.
Named exports; additive grouping option; no extra dependencies.

## Tests and success
A single long user task with multiple tool rounds can compact with no synthetic
user message supplied by the app. Preserve retained provider extras byte-for-byte.
Reject orphaned/duplicate results and unsafe transforms. Correlate success/failure
events, preserve canonical history, and prove budget/cancel enforcement.

## Boundaries
Always use the existing summary engine. Ask for scope outside these contracts.
Never assume an opaque continuation can be independently reconstructed.
