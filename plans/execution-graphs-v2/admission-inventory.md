# Root admission and expansion inventory

Read-only investigation for attachment c0b3a451-5aab-487f-a502-612a9edd4778, 2026-10-13. Inspected managed checkout HEAD `e9551e3690bdf274fc66f82222851fe9d06d8e97`. This report proposes contracts; it does not claim implementation or passing tests. No source edits, installs, builds, tests, paid calls or commits were performed.

## Observed current behavior

| Boundary | Current behavior | Exact integration point |
| --- | --- | --- |
| Workflow/StepRunner | Graph/Repeat/Condition/Parallel coordinate children. Agent steps pass the same ExecutionServices instance and signal, but have their own child run IDs. | `packages/core/src/workflow/step-runner.ts:165`, `:171`, `:240`, `:285`, `:311`; `workflow/workflow.ts:165` |
| Graph admission | Local maxConcurrency limits running graph nodes; nested graphs each have an independent running set. All episode nodes are validated before dispatch. | `packages/core/src/workflow/graph-runner.ts:225`, `:232`, `:267`, `:367` |
| Agent model work | Controlled Agent provider delegates model and streaming operations to supplied services, with child context. | `packages/core/src/agent/agent.ts:518`–`:538` |
| Agent tool work | Agent constructs a local ToolExecutor and invokes executeAll directly under runOwned. It does **not** call services.dispatch for each tool. Harness dispatch-only limits miss these batches. | `packages/core/src/agent/agent.ts:516`; `agent/llm-loop.ts:610`–`:611`, `:985`–`:986` |
| Tool concurrency | Each ToolExecutor chunks its own batch by independent concurrency. Multiple Agents and graphs multiply aggregate concurrency. | `packages/core/src/tools/tool-executor.ts:174`–`:181` |
| Actual tool effect | Arguments, policy, approval, hooks and cache decisions precede tool.execute or sandbox.execute; output transforms follow it. | `packages/core/src/tools/tool-executor.ts:249`–`:351`, `:354`–`:379` |
| Harness root accounting | One in-memory ledger per execute shares model calls, tool calls, tokens and protected finishing allowances; no semaphore or persisted hydration. | `packages/harness/src/runtime/driver.ts:451`; `runtime/budget.ts:81`–`:117` |
| Ordinary model | prepare may make control/summary model calls; provider dispatch follows prepare; usage settles in finally. | `packages/harness/src/runtime/driver.ts:880`–`:888`, `:1384`–`:1412` |
| Independent models | controlModel and finishModel call the same independentModel path, with explicit grants and shared token/call budget. | `packages/harness/src/runtime/driver.ts:1254`–`:1341`, `:1382`–`:1383` |
| Streaming models | Provider iterator remains active across yielded chunks and settles on finish/return/throw. | `packages/harness/src/runtime/driver.ts:1415`–`:1529` |
| Controlled functions | StepRunner wraps callbacks through dispatchEffect; the harness constructs a temporary ToolExecutor using the root policy identity. | `packages/core/src/workflow/step-runner.ts:203`–`:215`; `harness/src/runtime/driver.ts:1554`–`:1577` |
| ExecutionServices | Generic host-owned port has model/stream/dispatch/dispatchEffect/runOwned but no admission controller. | `packages/core/src/agent/execution-services.ts:19`–`:80` |
| Durable aggregate | Stable root identity, immutable root definition/budget, task lease/fence, retained attempts, monotonic conservative token/cost reservations, action ledger, JSON extensions. | `packages/core/src/durable/types.ts:32`–`:120`; `durable/store.ts:131`–`:223` |
| Existing durability | Supervisor converts orphan executing actions to unknown; renew/cancel uses fenced updates. Existing reserve only increases token/cost reservations. | `packages/core/src/durable/supervisor.ts:51`–`:81`, `:139`–`:180` |
| Persistent backend | MongoDB adapter advertises durable/atomic/CAS/fencing/outbox and uses majority+journal writes, server clock and revision/lease filters. | `packages/core/src/durable/mongodb.ts:15`–`:43`, `:83`–`:121` |

## Proposed exact units and limits

Keep concurrency and lifetime expansion separate. Define defaults and units in the public contract, not by an ambiguous “maxSteps.”

**Concurrent work:** one actively owned leaf dispatch, consisting of one model request (including its entire provider stream lifetime), one controlled tool invocation, or one controlled function/effect invocation. Model operations include planner, correction, control, finishing, recall/summary models and ordinary Agent models. Cache reuse or recovery reuse of confirmed results requires no dispatch slot. Graph, Repeat, Parallel, Condition, Agent orchestration and a planner awaiting its own child model call hold no slot.

Acquire a leaf slot immediately before actual controlled dispatch, after all preparation/schema/grant/approval decisions; release after the leaf operation settles. Admission and release must be paired with try/finally and idempotent release. For ToolExecutor, release before toModelOutput/result summarization, since those may make separate controlled model calls. For harness ordinary model calls, acquire **after prepare**, which may invoke control models. For streaming requests, retain the slot across yields until return/throw/provider completion, including an interrupted unfinished stream.

A root limit such as `maxConcurrentWork` is a positive safe integer; omitted preserves existing unlimited aggregate behavior. Local graph maxConcurrency and ToolExecutor concurrency still narrow local admission; neither can widen the root limit.

**Lifetime materialization:** `maxExpandedNodes` counts every committed logical node occurrence, including structural nodes, across all nested materialized episodes and repeat iterations. Reserve the whole known episode before its first effect. New plan revisions charge new or replaced pending node incarnations; unchanged nodes/recovered materializations do not charge again. Removed nodes remain in audit and do not refund expansion. A static graph declaration and its StepRunner execution must share one stable identity and must not be counted twice. Root serial/parallel/condition nodes also need stable occurrence identity if they can invoke graph work.

**Lifetime work attempts:** `maxWorkAttempts` counts each admitted leaf dispatch attempt, including retried requests and bounded planner correction calls. Queue waits, schema/grant rejection, completed-result reuse and reconciliation inspection do not create a new execution attempt. Charge once when dispatch admission becomes committed, rather than when initially enqueued. Attempts are monotonic and never reset after recovery.

**Lifetime revisions:** `maxPlanRevisions` counts accepted materialized plan/stream commit revisions, while invalid proposals consume ordinary model/token/work-attempt budgets. An optional separate invalid-proposal cap makes correction ownership explicit. A committed no-op revision should either be rejected or consume its revision allowance; it must not create unbounded audit.

These limits supplement existing model/tool/token/cost/deadline/repeat/local-node budgets. All finite limits should support zero where meaningful (no expansion/work attempts/revisions), but concurrency zero should reject configuration rather than create an unresolvable queue. No missing usage becomes known zero.

## Root propagation and deadlock prevention

Expose a borrowed root admission controller on RunContext or ExecutionServices, with optional per-run construction for standalone core use. Every child context, Workflow, Repeat iteration, nested graph, planner and Agent-local ToolExecutor must carry the same controller. A root identity must survive recovery; a fresh child run ID must not create another ledger.

The narrow effect interception point is ToolExecutor's actual execute boundary. This covers local Agent tools, root services.dispatch, workflow dispatchEffect and planner tool bindings without adding a second Agent scheduler. The harness root and control model paths handle provider slots. Standalone Agents must wrap their provider using the same controller if root limits are requested without ExecutionServices.

Do **not** acquire a global slot for the whole graph node, whole Agent run, complete tool batch, model preparation, parent runOwned, or root planner. A limit of one would deadlock each when it waits for children.

Trusted function/tool callbacks can themselves launch Agent/model/tool/Workflow work. Blind reentrant permits do not solve this: one parent permit could spawn a batch of ten children. A finite global controller must distinguish orchestration from leaf bindings. Recommended safe first contract:

- Graph/Repeat/Agent are orchestration bindings and hold no slot.
- Controlled function/tool bindings are leaf operations; nested controlled dispatch from a leaf is detected (for example with AsyncLocalStorage) and rejected before child effects.
- Hosts that need orchestration callbacks must express the children as supported structural nodes or use an explicit SDK orchestration binding that holds no parent slot.
- Arbitrary host code/network IO outside controlled ports cannot be bounded by an SDK semaphore and must never be described as covered.

This is a real supported-bindings constraint, not a reason to omit global limits. Document it and test explicit rejection instead of allowing a hang.

## Admission, cancellation and observability

Use a FIFO root queue for ready leaf operations; queue entries carry root/episode/node/logical operation/attempt/revision identity, kind and signal. Local graph eligibility is still checked before enqueueing. Queued operations require no permit and occupy no work-attempt counter.

When a waiter aborts, remove it and its abort listener, reject once with a stable code and make no outbound call. Root deadline/cancellation stops all admission and wakes every waiter. An admitted operation that fails or throws releases once; a started uncooperative operation cannot have its resource slot released early merely because local abort arrived. Its eventual outcome remains evidence. Limit exhaustion is terminal for new admissions but preserves prior results and accounting.

Emit bounded events for queued, admitted, released, rejected/cancelled and exhausted operations, including limit/unit and causal IDs. Snapshot exposes active permits, high-water mark, queued count, expanded nodes, work attempts, revisions and root deadline. Avoid raw credentials/arguments in ordinary telemetry. Event IDs must support diagnosed duplicate release without modifying counters twice.

## Durable accounting and fencing

Persist root configuration/hash, absolute deadline, cancellation state, expansion/revision records, lifetime attempt counters and permit records in the same bounded DurableTaskStore task aggregate as graph state/actions. Root graph identity cannot span multiple independent task aggregates under this store's documented single-task atomicity guarantee.

Use guarded store.update with the active DurableFence to atomically reserve expansion or acquire attempt+permit before effects. Counter increments and lifecycle/audit changes must commit together. CAS mutate callbacks are synchronous and may be reevaluated; they cannot call providers/connectors or emit uncommitted external events. Persist event evidence in the same mutation or emit after success with committed revision.

Record active permits by stable logical operation plus fresh attempt ID and owner fence. Reject stale-worker acquisition, release, node/output/plan commits. Lease/fence renewal is existing supervisor behavior. Definition/binding/input/version checks run before recovering admissions. Hydration must not replenish limits, attempts, reserved/unknown usage or reset deadlines. A caller cannot widen limits by supplying different resume configuration.

Existing harness model budgets are synchronous, and a root ledger is currently recreated. Durable integration must persist an admission before actual dispatch and restore counters/reservations from durable state, or bypass this in-memory ledger through a durable adapter with the same semantics. A mere on-terminal snapshot loses charges after crashes. Existing supervisor reserve(tokens,costMicros) is conservatively monotonic; it cannot by itself persist model/tool/concurrency/expansion limits.

**Lease expiry does not prove a remote operation stopped.** On recovery an orphan running permit becomes uncertain and retains evidence. Do not simply erase it and admit another effect while claiming a strict bound on physically concurrent remote work. Reconcile its effect with a destination guarantee: confirmed receipt, verified absent with no future application, or explicit unresolved state. Unknown charges remain charged. A model with no reconciliation may retain conservative unknown accounting and require an explicit host resolution policy. Define the implemented concurrency guarantee precisely as controlled SDK ownership/admission versus remote physical activity.

Known stopped local work can release a local permit when the new owner establishes the applicable terminal/recovery state; mutations remain fenced. Confirmed persisted action receipts reuse results and free the corresponding prior permit without dispatch. Explicitly unresolved operations stop unsafe repetition. Cancellation does not delete permit/action audit or imply rollback.

DurableActionLedger already binds action ID to connector version, destination, arguments, identity, policy revision and grant refs; identity reuse with different inputs rejects. Use its logical identity and input digest, not random call IDs or scope paths. Confirmed actions can be reused, unknown actions require reconciliation. The current supervisor rejects unknown actions before invoking its handler, so an adapter needs an explicit recovery/reconciliation entry path before normal handler execution rather than hiding reconciliation inside an unreachable callback.

## Meaningful acceptance tests

Write each new behavioral test failing before implementation. Suggested focused deterministic cases:

1. Outer parallel graphs each contain three functions; both local caps exceed root maxConcurrentWork=2. Hold callbacks with deferred promises, measure the **aggregate** active callback count and high-water mark, and assert max=2 throughout.
2. Two concurrent Agent nodes each return a three-tool batch. Their local executors have concurrency=5. Aggregate started tools never exceeds root=2; both Agents finish without deadlock.
3. Nested Graph → Repeat → Graph → Agent at root=1 completes. Structural and Agent nodes hold zero permits; observer sees only leaf operations.
4. Concurrent ordinary/planner/control/finishing model calls plus tool effects share the same global slot ceiling. A streaming model retains one slot while a tool waits until stream closes.
5. Model prepare causes a controlled summary call at root=1; tool toModelOutput causes a model call at root=1. Both complete, proving no parent permit spans preparation/transformation.
6. Leaf callback attempts nested controlled work at root=1. Reject before nested effect and release parent once, without hanging or creating a bypass.
7. Cancel two queued waiters while one callback is running; queued outbound count remains zero, queue empties, all listeners are removed, running slot settles exactly once.
8. Reject/throw and late cancellation paths cannot leak or double-release permits; subsequent permitted independent work can run.
9. Repeat factory produces individually valid graphs beneath local maxNodes but total expansion exceeds root cap. Last episode fails **before any of its effects**, and prior outputs/counters remain.
10. Streaming commit replaces a pending node, removes another and preserves a completed node. Charged expansion counts both incarnations, does not refund deletion, and unchanged completed node reuses its original identity/output.
11. A correction model request consumes attempts/calls/tokens; recovery lookup and confirmed-effect reuse consume none. Distinct actual retries consume new attempt allowance.
12. Cross-root isolation: two separate roots each have an independent ceiling, while siblings of one root cannot construct a new ledger.

Use the existing real Mongo crash-worker fixture for persistent-backend evidence, rather than presenting in-memory maps as process-crash durability. Existing tests launch fresh child processes and SIGKILL under `AGENTIUM_DURABLE_MONGO_TEST=1`, endpoint `AGENTIUM_DURABLE_MONGO_URI` or isolated localhost27319; inspect environment before running.

Persistent cases: crash after expansion admission; crash with two siblings running; crash after action receipt before node completion; kill a planner during a streamed commit; recover in a fresh worker. Assert unchanged root counters/deadline/configuration, completed reuse, orphan uncertainty, absence of unsafe duplicate dispatch, stale release/commit denial, retained permit/attempt evidence, and bounded aggregate slots through recovery. Compare full persisted state, not just terminal text. An unavailable Mongo environment is a named verification gap and prevents claiming tested persistent crash recovery.

## Coordinator decisions requiring implementation agreement

The units above are recommended, not frozen public API. Resolve the exact names, static-node identity rules, allowed nested leaf behavior, conservative orphan-permit policy and durable budget adapter ownership before separate implementers edit shared ports. Do not quietly replace aggregate limits with local graph bounds or omit Agent-local tools.
