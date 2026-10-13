# Durable execution graph inventory and protocol recommendation

Read-only investigation against `e9551e3` on `agent/execution-graphs`, in `/Users/xerycks/.codex/worktrees/core-harness-dependability/agentium`. Source was not edited and no build, test, installation, server startup or external effect was performed. This report is a proposed implementation contract, not verification of a new capability.

## Existing foundations and concrete integration points

| Foundation | Current behavior and source |
| --- | --- |
| Stable task/run identity | `packages/core/src/durable/types.ts:6–42` separates tenant, actor, session, run, root and parent run identity; immutable manifest/input/driver/policy/grant bindings are available. Definition digest normalizes default budgets and excludes mutable extensions (`durable/store.ts:58–76`). |
| Atomic fenced task state | `DurableTaskStore.update` has a pure synchronous mutation and optional worker fence (`durable/types.ts:105–120`). `store.ts:122–129` rejects expired or superseded owners; `store.ts:131–223` enforces immutable task fields and monotonic audit/counters/action transitions. |
| Persistent backend | `MongoDBDurableTaskStore` (`durable/mongodb.ts:18–25`) advertises durable, CAS, fencing and durable outbox. It uses majority+journal acknowledgements (`:39–43`), server time (`:51–55`), revision CAS plus an atomic lease-expiry condition (`:101–119`). One task is one bounded aggregate, default 2 MB. No cross-task transactions. |
| Local deterministic backend | `InMemoryDurableTaskStore` (`durable/store.ts:225–233`) is explicitly `durable:false`. It is useful for decision tests but cannot establish process-crash recovery. |
| Ownership/recovery | `DurableTaskSupervisor.claim` (`durable/supervisor.ts:51–81`) advances the root fence, appends worker attempts and converts interrupted `executing` actions to `unknown`. `run` polls cancellation and renews leases (`:124–154`), but refuses to enter its handler while unknown actions exist (`:155–157`). Reconciliation must therefore run under a claimed fence before invoking the graph, or the supervisor needs an explicit reconciliation hook. |
| Logical effect ledger | `DurableActionLedger.prepare` (`durable/actions.ts:54–104`) hashes connector version, destination, arguments, identity, policy revision and grants. A reused action ID with different inputs fails (`:69–74`). Its destination idempotency key is stable per logical action (`:80`). `execute` persists dispatch intent before dispatch (`:118–160`), returns saved confirmed receipts (`:114`), blocks executing/unknown actions (`:115`), marks exceptions after dispatch unknown (`:173–186`) and supports fenced reconciliation (`:190–215`). |
| Real idempotent destination | `MongoDBDurableDocumentConnector` (`durable/mongodb-connector.ts:13–60`) writes an append-only document with unique `_id`, checks prepared hashes and reads a receipt. Its reconciliation intentionally returns `unknown` for absence because an old request might still arrive. This is a supported document-effect binding, not generic email/payment/shell safety. |
| Run evidence and snapshots | `DurableRunRecords` (`durable/records.ts:78–127`) appends bounded sequenced events. Artifacts are immutable and digest checked; blob write precedes a fenced reference commit (`:139–227`), leaving only possible orphan blobs. `JournaledDurableTaskStore` (`:232–275`) records task lifecycle changes in the same CAS. Event retention is bounded and cannot be the authoritative source of graph recovery state. |
| Current graph lifecycle | `workflow/graph-runner.ts:223–265` materializes and validates an episode but keeps all phases/patches/results in memory. `:282–334` settles node outcomes; `:344–378` computes dependencies and node inputs before dispatch. These are the natural materialize/start/settle/block persistence hooks. |
| Step and episode scope | `workflow/step-runner.ts:90–143` creates graph/repeat execution paths and selects step implementations; `:157–200` runs Agent nodes; `:203–219` sends functions through `ExecutionServices.dispatchEffect`; graph and repeat methods are at `:285` and `:311`. Current paths give attribution, not durable effect identity. |
| Current checkpoints | `workflow/workflow.ts:271–320` only saves after completed top-level steps; input envelope validation is at `:15–46`. Keep these formats compatible; they do not supply unfinished-graph recovery. |
| Harness boundary | `ExecutionServices` (`agent/execution-services.ts:20–76`) supplies controlled model and stream calls, tools, policy and `dispatchEffect`. `HarnessRuntime` explicitly rejects durable drivers without a recovery adapter (`harness/src/runtime/driver.ts:310`). `workflowDriver` advertises `durable:false` (`harness/src/drivers.ts:19–24,111–155`). Merely setting a capability flag is unsupported. |
| Root budgets | `HarnessBudgetLedger` (`harness/src/runtime/budget.ts:82–207`) tracks calls/tools/tokens/protected finishing capacity and unknown usage, but has no restore API. Runtime constructs a fresh ledger (`runtime/driver.ts:451`). Supervisor task token/cost reservation (`durable/supervisor.ts:169–180`) is separate, monotonic and manual; it does not retain harness model/tool counts or deadline automatically. |
| Agent tool boundary | Agent merges its own configured/resolved tools with service tools (`agent/agent.ts:484–516`) and delegates models through services (`:518–537`). However LLMLoop executes its own ToolExecutor directly (`agent/llm-loop.ts:610–611,985–986`). Wrapping only `services.dispatch` does **not** intercept all Agent node effects. The actual authorized operation is `tools/tool-executor.ts:354–362`, after argument validation/policy/approval and argument-mutation checks (`:249–336`). |

## Smallest coherent durable protocol

Reuse the task aggregate and action ledger; add a reserved, validated versioned graph extension rather than a second store or bespoke scheduler. A durable workflow adapter must require `durable`, atomic updates, CAS and fencing capabilities, plus verified executable/effect bindings. The non-durable `Workflow`, `Agent` and checkpoint callers stay compatible.

### Bindings and admission

A host-owned immutable catalog maps explicit binding IDs and versions to functions, Agent configurations and tool connectors. Catalog descriptors contain input/output validators and effect-recovery mode. Serialize descriptors/references only; functions, clients, credentials and signals remain outside records. An admitted definition binds workflow version, catalog descriptor digest, driver version, root identity, original input digest, grants/policy revision, resource limits and absolute deadline.

Before any resumed effect, validate this envelope, the materialized proposal, every binding version and stored node input/output. Reconstruct runtime services from host-owned bindings and recheck current grants; a persisted grant reference is not proof that a revoked grant is still valid. Unknown operations, unversioned unsafe callbacks, arbitrary local Agent tools and unresolved schema references fail before admission. A “pure” binding is a host declaration with a real contract; it cannot make an effectful callback safe by naming convention.

Declare supported categories explicitly:

1. Pure JSON function nodes whose implementation version and validators are host bound; restarting after an interrupted computation has no external effect.
2. Controlled function nodes bound to a `DurableActionConnector`, with destination-enforced idempotency or reconciliation and a retained output/receipt resolver.
3. Agent nodes using recorded model decisions and only approved pure or durable tool bindings. Tool-free Agent nodes still need persisted model-budget accounting. Unsafe hooks, dynamic tool resolvers, remote handoff/subagents or callbacks that bypass the controlled port need a declared supported adapter or must be rejected.

This declaration covers both required node kinds while making unsafe operations visible. It is not acceptable to advertise general durable graphs with function-only interception.

### Authoritative record

Suggested extension fields: schema version, definition/catalog digests, root limits and counters, original absolute deadline, persisted cancellation, current scheduler revision, materialized episode records, bounded plan-revision history, repeat decisions/counters, node records, recorded model decisions, effect references and superseded/late evidence. Validate all restored JSON at runtime. Use the existing finite canonical JSON contract and reject corruption/version mismatch rather than casting stored data.

Each episode records a stable scope, entry input, materialized DAG, declaration/topological order, dependency decisions and merge mode. Each node records logical identity, binding/version, input and input digest, lifecycle, output patch, StepResults, plan revision and execution-attempt generation. Persist input/readiness and `running` atomically **before** effects. Persist owned output and terminal phase atomically before releasing successors. Rebuild merge ownership and readiness from the authoritative terminal records; do not trust a saved aggregate state without checking provenance.

A stable node identity is root run + graph/repeat scope + node ID + logical definition generation. A logical effect identity is that node identity + recorded operation position/call ID, bound to connector/version/destination/argument digest. Attempt UUID, worker ID or root fence must never replace logical effect identity. Repeated dispatch of the same ID with changed inputs is rejected by the existing ledger. Attempt IDs and fences remain separate audit/ownership fields.

### Interrupted Agent behavior

Use a documented restart-from-node-entry protocol under recorded-decision playback. Persist a complete provider-valid model response and its request/configuration digest before making any tools from that response eligible. On recovery, rerun the Agent loop using those saved complete responses and effect receipts; do not make new model calls or rerun confirmed effects for replayed positions. Subsequent unfinished model calls may be sampled again only after accounting for the interrupted call's retained reservation/unknown charge. This is recovery using recorded decisions, not arbitrary exact playback of all runtime behavior.

The ToolExecutor must expose a durable invocation boundary **after** validation, policy, approval and argument integrity checks, carrying ToolCall ID plus child RunContext. A durable service/catalog adapter can then intercept both service tools and Agent-local tools. The existing `services.dispatch(call)` lacks child context and is not the Agent loop's dispatch point. Keep delegated node scope in metadata or an explicit immutable context identity, and preserve binding/call/input checks even on receipt reuse.

Persist raw tool output/receipt before any potentially failing model-output conversion, observer, cancellation check or node finalization. The current ToolExecutor can lose successful raw output when later transformation or cancellation fails; its durable boundary must retain the evidence. JSON-only durable binding outputs avoid artifact/session pointers that cannot be resolved after process death. Provider `raw`, SDK objects, API keys and AbortSignals are not automatically durable JSON.

### Recovery rules

| Node state | Recovery action |
| --- | --- |
| Pending | Recompute readiness from recorded predecessor states, validate original materialized input binding, and admit under retained budgets. |
| Completed or skipped | Reuse saved output/result; never rerun its executable. Revalidate output and merge ownership. |
| Running, no dispatched effect | Advance node attempt generation and restart pure work or recorded Agent decisions within retained allowances. |
| Running with confirmed effects | Restore/replay their receipts and resume the recorded node operation; no remote redispatch. |
| Running with executing/unknown effect | Reconcile under current root fence before retry. If unresolved, preserve an explicit recovery-required outcome and evidence; do not convert it to ordinary step failure and quietly retry. |
| Failed | Preserve failure. Retry only an explicitly bounded host/node policy; never reuse a terminal task by silently resetting its state. |
| Cancelled/cancel requested | Keep cancellation persisted; stop new admissions, reconcile executing/unknown effects, and retain late evidence. A local abort is not remote rollback. |
| Superseded | Old attempt outputs cannot update current node state; retain action/late-result evidence. Existing effects remain historical facts. |

Root lease fencing protects worker commits; node generation/plan revision protects superseded attempts in the **same** root lease. Both checks must be in the settle CAS. A stale worker may still finish a remote request, so destination idempotency/reconciliation remains mandatory.

### Budgets, deadlines and repeated/streamed episodes

Persist the full harness accounting needed to restore ordinary and protected finishing capacity—not only a public remaining snapshot. Model/tool admissions and bounded token reservations must commit before dispatch; crash recovery retains outstanding reservations conservatively as unknown usage until authoritative settlement. Never initialize a new zero ledger with the original full allowance. Original absolute deadline and cancellation state are immutable across retries/recovery; use backend time for fenced admission where practical. Supervisor `maxAttempts` counts worker claims separately from graph node-attempt/plan-expansion limits.

Persist repeat guard decisions before dispatching another body, completed iteration count, and each materialized graph body. Do not reevaluate an already recorded historical predicate or factory after recovery. A new decision may read only settled recorded observations. Stable scope includes the iteration so repeating an intentional operation gets a different logical identity without resetting root limits.

For streamed planning, accept bounded framed **complete committed proposals/revisions**, not arbitrary token prefixes. Validate each revision's full executable graph, bindings, refs, cycles, sizes and limits before CAS commitment. Previously running/completed node definitions, inputs, dependencies and owned outputs are frozen. Pending definitions may change only under a new generation with transitive readiness/input recomputation and an audit link; unresolved references never execute. Preserve removed/superseded nodes and prior effect records. A planner stream crash resumes the last committed revision; an incomplete fragment has no executable authority. Retain causal observations and proposed/validated plans, with bounded revision/correction budgets. Planning model calls consume the same root allowance.

For root scheduling, avoid permits for graph/repeat/Agent containers while they wait on descendants. Limit real model/tool/function leaf operations; lifetime expansion and execution attempts are separate monotonic units. A function binding that launches controlled descendants cannot hold their shared permit throughout the wait: either classify it as a container, enforce a leaf-only callback contract, or explicitly suspend its permit. Persist durable counters and in-flight ownership; recover stale permits only through fenced attempt recovery, not by erasing evidence of unknown external work.

## Backend availability and real crash checks

Read-only local discovery found `/opt/homebrew/bin/mongod`, `/opt/homebrew/bin/mongosh`; `mongod --version` reports **8.0.1, aarch64**. No listener appeared on 27017 or 27319. This is evidence that a disposable local Mongo process is plausible, not that a database connection or durability contract was tested. Installed `mongodb`, `tsx`, and `better-sqlite3` peers are present in the worktree through links to the original checkout's dependencies. `sqlite3` is installed, but there is no existing SQLite `DurableTaskStore`; cost/storage SQLite adapters do not satisfy this graph recovery contract without new implementation. Mongo is the existing supported persistent task backend and should be preferred.

Existing tests `durable/__tests__/mongodb.integration.test.ts:30–69` fork fresh `tsx` workers with IPC barriers and SIGKILL, enabled by `AGENTIUM_DURABLE_MONGO_TEST=1`; default URI is `mongodb://127.0.0.1:27319/?directConnection=true`. They already cover competing ownership, stale worker fencing, CAS clients, prepared intent before dispatch, effect before receipt, and approval/cancellation restart (`:85–184`). Existing fixture is `durable/__tests__/fixtures/crash-worker.ts`; adapt this pattern to real Workflow + HarnessRuntime + durable adapter.

Use a task-owned temporary Mongo data directory, isolated port and generated fixture database; the existing tests delete only `agentium_durable_fixture_*`. The coordinator owns server startup/cleanup and whether test-local cleanup is within authorization. Never use an unknown user's production database or kill an unrelated server. A standalone journaling Mongo server proves local process crashes with persisted server state; it does not establish replica-set failover, backup recovery or power-loss guarantees.

Required fresh-worker additions, using IPC barriers at actual persisted/remote boundaries:

- Crash after validated graph/start intent but before effect dispatch: restart admits once.
- Crash after unique Mongo destination acceptance before action receipt: reconcile one document; no unsafe second operation.
- Crash after action receipt before node settle: restore recorded output and complete node without redispatch.
- Complete sibling A, interrupt B: retain A's output and effect, recover only B, preserve dependency ordering.
- Interrupt an Agent after recorded model tool request and confirmed tool receipt: new process replays recorded decisions/receipt and proceeds, with local Agent tools included.
- Interrupt a model request before recorded response: reserved calls/tokens remain counted and next call respects remaining budget/deadline.
- Expire/supersede worker and attempt a late settle: CAS rejects stale fence; destination receipt remains inspectable.
- Persist cancellation across death with an unknown effect: no new work, explicit unresolved until reconciliation.
- Crash after a repeat decision/body materialization: same iteration/episode reused and counters never reset.
- Crash after streamed revision commitment before admissions: same validated revision reloaded; incomplete later fragment ignored without erasing its diagnosis.
- Identity/catalog/version/input corruption on recovery fails before model/tool admission.
- Nested graphs/repeats and Agent batches obey root concurrency; crashed permits reclaimed via fenced ownership; unknown effects remain evidenced.

Acceptance must inspect actual destination counts, saved completed node records, effect/input digests, root counters/deadline, committed revision and stale commit rejection. In-memory simulations remain separate tests and cannot stand in for these process/backend checks.

## Material risks the implementation must resolve

- The existing supervisor blocks unknown actions before the graph handler. Automatic safe reconciliation needs a deliberate entry hook; otherwise report unresolved honestly.
- Ordinary StepRunner catches arbitrary errors and turns them into failed StepResults (`workflow/step-runner.ts:125–141`). Lease loss/recovery-required/budget/cancellation control errors must stay fatal control outcomes rather than being swallowed and persisted as ordinary failures.
- Existing stores trust extension mutation callbacks. Add schema validation, immutable terminal/effect audit rules and revision/attempt checks for the graph extension; a cast does not validate restored data.
- Existing record event retention is finite. Authoritative completed nodes, unacknowledged effects, counters and committed plans cannot be evicted with diagnostic events.
- Whole-task 2 MB bounds may exhaust before a large plan/history. Reject bounded expansion before unsafe admission, or use immutable blob references committed after successful writes. Do not silently drop recovery data.
- Raw callback/Agent hooks can execute captured external resources outside the SDK; the durable binding contract must reject unsupported unsafe operations and disclose trusted host responsibilities.
- Model/token reservation and concurrency permit ownership need persisted admission before remote work; restoring only a final snapshot leaves crash holes.
- Scope paths, fresh UUIDs, model tool-call IDs without recorded requests, and timestamps alone are not durable logical effect identities.
- Exactly-once external execution, arbitrary connector safety, power-loss recovery and paid/live model quality are not established by the proposed implementation or existing tests.
