# Dependency scheduler implementation evidence

Date: 2026-10-13. Worktree: `/Users/xerycks/.codex/worktrees/core-harness-dependability/agentium`. Branch: `agent/execution-graphs`. Baseline HEAD: `f5e4434723c33f2610416bee789c78bb32787315`; verification was against the dirty worktree containing the new scheduler/test files and coordinator-owned frozen types/errors. No commits, publication, pushes, merges, deployments, paid model calls, or external effects were performed by this implementer.

Owned implementation files:

- `packages/core/src/workflow/graph-runner.ts`
- `packages/core/src/workflow/__tests__/graph-runner.test.ts`

The scheduler exports internal `executeWorkflowGraph` and, at the coordinator's request, `validateWorkflowSteps<T>(steps: StepDef<T>[]): void`. The latter validates static bodies without executing predicates/factories/functions/Agents, allowing repeat validation before body effects. No public barrels or shared types were edited.

## RED

Command from worktree root:

```sh
npx vitest run packages/core/src/workflow/__tests__/graph-runner.test.ts
```

At 07:51:17, Vitest 4.1.11 ran against a signature-only placeholder returning `{ patch: {}, results: [] }` and a no-op validator. Exit status 1: **42 tests failed**. The first behavior failures were empty joined patches instead of `{ value: "sibling" }`, no ready node admissions instead of `A/B`, and missing validation rejection before effects. Thus the RED exercised the actual scheduler seam rather than failing to import a nonexistent module. The placeholder also caused one expected callback-entry wait to time out and six secondary rejection-assertion errors when early assertions stopped those tests; these were RED artifacts, not final GREEN warnings.

## GREEN

Same focused command at 07:52:50: exit 0, **42/42 tests passed**, 198 ms reported total duration.

After capturing validated scheduler limits before callbacks and adding characterization checks for default concurrency, pre-aborted entry, the default node bound and accepted static depth64, the same command at 07:53:56: exit 0, **45/45 tests passed**, 192 ms reported total duration. No skipped tests or unhandled rejection warnings in GREEN.

Behavioral coverage includes:

- Inverted branch completion with stable topological patch/result joins and flat callback results.
- Incremental readiness for `A/B; C <- A; D <- A,B; E <- C,D`, explicit concurrency bounds, and default concurrency 5.
- Transitive `inputsFrom` ancestry only; control ancestors and completed siblings do not leak into input. Nested base/input mutation and later retained patch mutation cannot overwrite captured scheduler state.
- Copied, frozen dependency arrays, captured episode options, same-value owned writes, declaration-order joins, strict incomparable writer conflicts before downstream admission, and comparable control-descendant rewrites.
- Skipped condition control release versus skipped data blocking; failed and blocked transitive gates; ordinary callback rejection recorded once without retry; nested child errors discard their node patch while retaining flat evidence.
- Cancellation/definition/merge fatal errors and signal abort stop admissions, drain all started callbacks, and discard late successful patches.
- Factory clone isolation, single materialization, node bounds, propagated factory throws, malformed factory output, deferred nested factories, uncloneable entry state, and fatal uncloneable successful patches with sibling draining.
- Invalid IDs, dependency arrays/duplicates/references, mixed-edge cycles, invalid positive safe integer limits/merge, malformed runtime execution kinds, malformed static nested graphs, recursive definitions and excessive nesting rejected before node effects. A predecessor in both dependency lists remains valid.

Synthesized blocked results have `workflow_dependency_blocked`, skipped status, duration 0, and a relative encoded `node.id/node.step.name` execution path. Ordinary synthesized callback rejection has `workflow_node_failed` and the same relative path form. The coordinator must prefix those two synthesized result cases; executed callback results already carry their caller-owned scoped paths.

## Limits and integration responsibility

Only the focused scheduler test command was run. Full workflow/harness tests, TypeScript checks, builds, packed consumers, broad suites and final Biome formatting remain coordinator-owned. These 45 tests establish scheduler behavior with controlled callbacks; they do not establish full StepRunner/Workflow integration or supported CI platform coverage.

The scheduler validates static nesting through depth64 and defers nested factory materialization until entry. The coordinator owns the runtime depth cap across dynamically generated nested factories, root GraphStep results, root failure policy, execution paths/events, repeat loops, callback execution/retry ownership and checkpoint boundaries.

Cancellation is cooperative: an uncooperative started callback delays rejection until it settles. Draining does not undo remote effects. There is no mid-episode durability, graph-level retry, streamed replanning, benchmark claim or recovery/idempotency guarantee.
