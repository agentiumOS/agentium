# Core cost tracking build plan

Prepared on 2026-10-08. Agentium commit: `f192926b57ca6a287548d6d985af08e5658263bd`.
The local commit matched remote `main` and `HEAD` during this review. Docs commit: `52af1a5`.

Implementation was subsequently approved by the user, including checks, documentation updates, and release. The user selected **4.5.0**. Source and local acceptance gates are complete in the managed `agent/core-cost-accounting` worktree; remote release gates are next. See [implementation evidence](./cost-accounting-implementation.md) and [DX review](./dx-cost-accounting-review.md). The original review limits below describe the review date, not the implementation work.

## Decision

Keep usage accounting, price calculation, storage contracts, and budget control in `@agentium/core`. Do not create another package. Existing packages can consume core records and events.

## Read in this order

1. [Review](./cost-tracking-review.md): confirmed defects, coverage, and source references.
2. [Build plan](./001-core-cost-accounting.md): contracts, examples, ordered steps, migration, and acceptance gates. This is the self-contained implementation handoff.

## Execution status

| Phase | Result | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|
| 1 | Canonical usage contract and provider fixtures | P1 | L | — | DONE |
| 2 | Record each provider attempt and auxiliary call | P1 | L | 1 | DONE |
| 3 | Versioned pricing rules and exact charge calculation | P1 | L | 1 | DONE |
| 4 | Durable records, replay, and scoped budgets | P1 | L | 2, 3 | DONE |
| 5 | Voice, embeddings, images, reranking, and custom operations | P2 | L | 2, 3, 4 | DONE |
| 6 | Public API migration, events, docs, and release gates | P1 | M | 1–5 | IN PROGRESS |

Phases 2 and 3 can progress independently after phase 1. Phase 6 contract and documentation work should start early; publication follows all acceptance gates. Each phase can land in smaller reviewed changes. Do not switch the public default to incomplete accounting.

## Review limits

This was a source and documentation review. No implementation, test runs, builds, dependency installs, or new paid API calls were performed. Only files under `plans/` were added. Commands in the plan are future verification gates, not claims of passing results.

The audit covered all model adapter source paths, cost consumers, relevant storage drivers, budget wiring, auxiliary model calls, and representative non-model operations. It did not establish actual invoices, private provider contracts, live SDK retry behavior, or every external tool's billing rules. Those gaps are explicit implementation gates.

## Considered and rejected

- Extract `@agentium/cost`: rejected by the user. Keep the module in core.
- Patch only the reasoning addition: insufficient; cache semantics, call identity, streams, and pricing coverage also affect cost.
- Assume every OpenAI-compatible endpoint uses OpenAI billing: API shape does not identify the biller or its rules.
- Persist costs only through event listeners: EventBus is intentionally observation-only and isolates listener errors.
- Claim observer exceptions currently repeat provider work: rejected. `events/event-bus.ts:63–78` already isolates both synchronous and asynchronous failures.
- Claim current OpenAI Chat Completions ends before its usage-only tail: rejected. `models/openai-api.ts:749–758` already handles that tail. Other stream paths still conflict.
- Add a structured-output repair charge to existing runs: rejected. Current LLMLoop falls back to raw text on parse failure; it does not issue a repair request.
- Use a universal Fast/Pro multiplier or a default cache discount: unsupported combinations must remain unpriced.
- Claim every call can be matched exactly to an invoice: account commitments, taxes, credits, opaque retries, and missing provider usage require separate treatment.
- Add mandatory methods to every `StorageDriver`: avoid breaking custom drivers. Use optional accounting capabilities inside core.

## Status meanings

TODO, IN PROGRESS, DONE, or BLOCKED with a concrete reason. Update only after the phase's checks have been run. This plan does not authorize a release, push, or provider spend.
