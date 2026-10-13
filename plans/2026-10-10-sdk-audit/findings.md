# Agentium SDK audit — findings

Audit started **2026-10-10**; completed **2026-10-11**, Asia/Kolkata. Repository: `c5f9b5249d299f5d2d39b74c87b83f0da7c15570`; all ten packages **4.8.2**. Source was read-only. See [assessment](README.md) for package maps and adopter journeys and [research](research.md) for comparisons.

## Evidence and priority

**Executed** means a local test, consumer type check, CLI invocation, or fake-only reproducer ran during this audit. **Source-inspected** means implementation/contracts were read; it does not establish live integration behavior. **Hypothetical** identifies proposed APIs and untested operational implications. Findings distinguish defects from intentional tradeoffs. No paid model, embedding, speech, browser-provider, database, carrier, or external service calls were made.

S1 means incorrect behavior, data/cost loss, or a demonstrated security issue; S2 means a blocked common journey or substantial integration/escape cost; S3 means meaningful friction or maintenance burden; S4 means polish. Effort S/M/L is comparative implementation effort, including contract tests, not a calendar estimate. Architectural cost measures how much machinery the recommendation adds. Migration measures adopter work. Ordering weighs reach, trigger frequency, confidence, harm, and repair leverage: deprecated accounting and conditional graph authority rank below broadly encountered loop/state defects, despite sharing S1.

| Rank | Finding | Severity; confidence | Reach / trigger frequency | Category | Architectural cost / effort / migration |
|---|---|---|---|---|---|
| 1 | F01 Loop boundaries differ across execution paths | S1; high | Agent tool users; cancellation/retry/cap incidents | simplify | low / M / low |
| 2 | F02 Storage identity encoding is ambiguous | S1; high for local collision | scoped/shared stores; delimiter-bearing IDs/keys | redesign | low / M–L / high for persistent keys |
| 3 | F03 Sessions cannot safely append across owners or partial writes | S1; high | shared sessions; overlapping writers/failure window | redesign | medium / L / low–medium |
| 4 | F04 Parallel Workflow overwrites independent updates | S1; high | parallel workflows; initialized state | simplify | low–medium / M / low |
| 5 | F05 Replay-generated checkpoints repeat completed steps | S1; high | replay/fork; repeated replay | redesign | low–medium / M / medium for old records |
| 6 | F06 Harness acknowledges async persistence prematurely | S2; high | custom remote session stores; every async commit | simplify | low / M / low |
| 7 | F07 Webhook forwarding loses work and escapes rejection isolation | S1; high | webhook users; delivery failure | simplify | low / M / low |
| 8 | F08 Legacy budget reads disagree with canonical accounting | S1; high | deprecated/manual budget consumers; canonical usage | simplify | low / S–M / low–medium |
| 9 | F09 Graph retrieval dispatches generated write authority | S1 conditional; high on dispatch | GraphRAG with write-capable principal; invalid/adversarial generation | redesign | low–medium / M–L / medium |
| 10 | F10 Team handoff no longer matches native Agent | S2; high | Team handoff; normal native use | remove/simplify | medium / M or L / medium |
| 11 | F11 Background memory has incomplete drain ownership | S2; high on drain; loss unverified | summaries/extraction; shutdown/freshness | simplify | low / M / low–medium |
| 12 | F12 Knowledge keyword index does not survive wrapper recreation | S2; high | persistent keyword/hybrid retrieval; restart/new worker | redesign | medium / M–L / low–medium |
| 13 | F13 Native provider customization requires a custom adapter | S2; high on shape, medium on frequency | production networking/provider features | add | medium / L / low if additive |
| 14 | F14 Eval unnecessarily requires the Agent class | S2; high | custom loops/application wrappers; evaluation adoption | simplify | low / S–M / low |
| 15 | F15 Construction implicitly publishes into global registries | S2; high | multiple hosts/tests/ephemeral instances; common | redesign | medium / M / medium for default change |

## F01 — Share cancellation, retry, and tool-cap invariants

**Defect; executed and source-inspected.** A fake provider aborted its signal on attempt one, threw a retryable 429, and returned an answer on attempt two. Agent made **two requests, one after abort**, and returned `status:"completed"`. Generic retry checks neither signal nor abortable backoff (`packages/core/src/utils/retry.ts:34`, `:38`, `:46`); LLMLoop invokes it without a cancellation boundary (`packages/core/src/agent/llm-loop.ts:209`). The nonstream final-answer branch has no post-call abort check (`:419`), whereas Agent streaming checks before completion (`packages/core/src/agent/agent.ts:1357`). A custom provider remains responsible for stopping an already running external operation, but the framework owns preventing another dispatch after known cancellation.

A second fake probe configured `maxToolRoundtrips:0`: plain Agent executed **one tool**, then stopped. Both loops use `roundtrip <= maxToolRoundtrips` (`llm-loop.ts:339`, `:637`); the actual pre-tool claim exists only for controlled execution (`:267`). A final answer call after N tool batches is useful; another effect batch is not. The controlled-loop tests cover zero and one, leaving plain-path parity unpinned (`packages/core/src/agent/__tests__/controlled-loop.test.ts:53`). A fake streamed 429 with `retry.maxRetries:2` was invoked once: stream uses `streamObserved` directly (`llm-loop.ts:684`), unlike generate.

**Impact:** cancellation can be reported as success and configured effect limits can be exceeded. Real billing after abort was not tested. Built-in adapters often forward/check cancellation, which reduces exposure but does not repair the structural-provider escape path.

**Recommendation:** implement common pre-dispatch, post-response, and pre-tool-batch checks; abortable retry waits; validate nonnegative integer limits. Allow the final model answer while rejecting excess tools. Choose one retry owner and state physical-attempt limits. Provider-private retries and SDK retries currently add layers (`packages/core/src/models/providers/openai.ts:31`, `packages/core/src/models/providers/anthropic.ts:61`); their multiplied request counts are **source-inspected hypotheses**, not measured here. OpenAI Decisions explicitly disables SDK retries (`packages/core/src/models/providers/openai-decisions.ts:84`). Stream retry should apply only before public commitment; fallback already refuses swapping after a public chunk (`packages/core/src/models/fallback-provider.ts:97`).

**Strongest retention case:** cooperative cancellation and separate run/stream implementations keep adapters flexible; inclusive iteration enables a final answer. Preserve those benefits while centralizing the invariants. This is a targeted repair, not grounds to rewrite Agent into an execution graph. **Migration:** mostly corrective behavior; code relying on N+1 batches or successful post-abort output changes. Add ordinary/controlled/run/stream matrix tests, abort during backoff and final response, and physical-attempt assertions with fake adapters.

## F02 — Encode storage tuples without collisions

**Defect; executed and source-inspected.** Distinct scopes `{tenantId:"a",userId:"b"}` and `{tenantId:"a:user:b"}` mapped to the same namespace; the second read the first fixture. Scope strings are unrestricted, while `ScopedStorage` concatenates components with `:` (`packages/core/src/storage/scoped.ts:24`). InMemoryStorage separately flattens `(namespace,key)` the same way (`packages/core/src/storage/in-memory.ts:6`): `set("parent:child","key",value)` is readable through `get("parent","child:key")`; `list("parent")` includes the child namespace (`:24`). Redis uses the same raw key format and raw SCAN pattern (`packages/core/src/storage/redis.ts:44`); Redis effects were not executed. TenantScopedStorage repeats raw tenant namespacing (`packages/core/src/tenant/tenant-storage.ts:13`).

**Impact:** cross-scope read/overwrite and namespace enumeration contamination are demonstrated at the public storage layer. Exposure through an authenticated HTTP endpoint was not tested. Tenancy helpers are not authorization, but that does not excuse their isolation codec being non-injective.

**Recommendation:** use a versioned, injective tuple codec, preserving absent versus empty components; store namespaces separately in memory; encode literal Redis prefixes/globs. Harness already uses `JSON.stringify([tenantId,userId,sessionId])` for its key (`packages/harness/src/runtime/session-bindings.ts:29`), a useful local precedent. Test delimiters, Unicode, empty IDs, glob metacharacters, and exact namespace listing. Add ownership-aware scope wrappers: `ScopedStorage.close()` currently closes the shared inner driver (`scoped.ts:52`).

**Strongest retention case:** common UUIDs/slugs avoid collisions, readable keys help operations, and persistent migration is expensive. These public types permit arbitrary strings and the fix adds little machinery; readability can live in metadata. **Migration:** never silently fall back to ambiguous old keys. Persistent adapters need an explicit migration using trusted tenant/key mappings, collision detection, and a cutoff. Some old key tuples cannot be reconstructed uniquely. Keep this release concern separate from host authentication. No recommendation to add mandatory accounting transactions to generic StorageDriver.

## F03 — Define atomic session mutation and recovery capabilities

**Defect; executed and source-inspected.** Two SessionManager instances sharing JSON-cloning InMemoryStorage appended A and B concurrently. Both calls succeeded; history contained only B. Locks belong to each manager (`packages/core/src/session/session-manager.ts:20`, `:29`); append is read/modify/write (`:73`). Generic StorageDriver has no atomic append/CAS (`packages/core/src/storage/driver.ts:1`). This occurs in one process with two managers, not only distributed deployments.

An IncrementalSessionManager fake persisted a message, then failed its metadata write. That message was readable. Recreating the manager and appending replaced it with the new message. Sequence reconstruction consults metadata/snapshot rather than the loose log (`packages/core/src/session/incremental-session-manager.ts:82`); loose entries precede metadata writes (`:150`). Existing incremental tests cover snapshot cleanup failure, a different boundary (`packages/core/src/session/__tests__/incremental-session.test.ts:18`).

**Impact:** accepted conversation data can disappear; storage persistence alone does not provide session mutation safety. Hosts can enforce one owner externally, but the current interface cannot express or verify that guarantee.

**Recommendation:** repair loose-log high-water recovery immediately; then add an optional SessionStore capability for atomic append, expected revision, and idempotent message IDs. Preserve generic KV for features that need only KV. Explicitly advertise process-local versus distributed single-writer guarantees and reject requested guarantees the store cannot supply. High-water recovery alone does not solve concurrent writers.

**Before — current contract:**

```ts
const left = new SessionManager(store);
const right = new SessionManager(store);
await Promise.all([
  left.appendMessage("s", { role: "user", content: "A" }),
  right.appendMessage("s", { role: "user", content: "B" }),
]); // both fulfill; one accepted message remains in the probe
```

**After — hypothetical optional contract:**

```ts
await sessions.append({
  scope: { tenantId, userId, sessionId: "s" },
  expectedRevision,
  messages: [{ id: applicationMessageId, role: "user", content: "A" }],
}); // acknowledged atomic revision, or a typed conflict
```

**Strongest retention case:** tiny KV adapters and per-instance locks make simple usage cheap; mandatory database transactions would raise every integration’s cost. Optional domain capabilities retain that benefit. **Migration:** opt-in adapter adoption is additive; requiring stronger defaults later needs a major release. Define session codec/version recovery and test two independent managers, ambiguous retries, and failure after every write. Session durability remains distinct from durable execution.

## F04 — Merge Workflow branch writes, not copied input

**Defect; executed and source-inspected.** Starting at `{a:0,b:0}`, parallel branches returning `{a:1}` and `{b:2}` produced **`{a:0,b:2}`** with all steps marked done. Each branch receives copied full state (`packages/core/src/workflow/step-runner.ts:218`); entire branch states are merged (`:225`), so B’s untouched `a:0` erases A’s update. Existing parallel tests start with empty state and assert statuses rather than merged values (`packages/core/src/workflow/__tests__/workflow.test.ts:247`, `:254`). Nested input references are also shared by the shallow copies; mutation isolation is source-inspected, not exercised by this probe.

**Impact:** a common typed-state workflow silently loses results. Declaration order makes the loss deterministic, not valid.

**Before — current application code:**

```ts
new Workflow({
  name: "both", register: false, initialState: { a: 0, b: 0 },
  steps: [{ name: "updates", parallel: [
    { name: "a", run: async () => ({ a: 1 }) },
    { name: "b", run: async () => ({ b: 2 }) },
  ] }],
});
```

**After — hypothetical explicit merge policy:**

```ts
parallel({ steps: [updateA, updateB], merge: "disjoint" });
// merge only produced patches; competing writes require a reducer
```

**Recommendation:** first fix internals while preserving existing step APIs: carry branch patches separately from branch state. Define collision policy, default to rejecting ambiguous writes or require a reducer; clone/freeze inputs if immutability is promised. Avoid a new graph DSL just to repair this merge.

**Strongest retention case:** whole-state results make nested sequential steps convenient and permit declaration-order overwrite. Keep whole state for serial execution; unchanged copied fields are not deliberate competing writes. **Migration:** disjoint updates become correct without application changes; define compatibility behavior for intentional conflicts. Test initialized state, nested branches, conflicting keys, rejected branches, and mutation. A successful build cannot validate this semantic contract.

## F05 — Preserve checkpoint cursor identity across replay

**Defect; executed and source-inspected.** A workflow incrementing by 1, 10, 100 ended at 111. First replay also ended at 111, but its generated checkpoints stored B at index 0 and C at index 1. Replaying the B checkpoint yielded **121**, repeating B. Replay slices remaining steps (`packages/core/src/workflow/workflow.ts:252`), restarts indices at zero (`:183`, `:195`), then interprets them against the original definition (`:221`). Tests cover one replay (`packages/core/src/workflow/__tests__/checkpoints.test.ts:48`).

**Impact:** incorrect state is demonstrated; repeated emails/payments/tool effects are a **hypothetical consequence** if application steps contain such effects. Checkpoints do not make those effects reversible or exactly once.

**Recommendation:** persist absolute step positions or stable definition-bound step IDs and validate workflow/definition version on load. `workflowName` is saved but not validated by replay (`workflow.ts:194`, `:219`). Preserve identity, cancellation, policy, and relevant request options through checkpoint APIs: `runWithCheckpoints` accepts only session/user (`:139`) and replay constructs a minimal new context (`:247`). Document snapshots as debugging/re-execution, with later effects rerun. Use the durable subsystem or an external engine when recovery rather than exploratory replay is required.

**Strongest retention case:** inexpensive snapshots/forks are useful and should not acquire a service dependency or durable execution semantics. The recommendation keeps them while repairing their own cursor contract. **Migration:** new checkpoints are straightforward; old checkpoints created during replay have ambiguous original position and need validation/rejection or a trusted definition-specific mapping. Do not infer position merely from nonunique names. Test replay-of-replay, forks, changed definitions, wrong workflows, and context propagation. No rewrite is justified by this defect.

## F06 — Await harness session commit and release

**Defect at an extension boundary; executed and source-inspected.** A fake custom store advertised durable/distributed ownership and delayed `lease.commit`. Harness returned completed success with **`persisted:false, released:true`**; persistence happened later. The public lease declares `commit`/`release` returning void (`packages/harness/src/runtime/session-bindings.ts:14`), while the store advertises durable/CAS/distributed guarantees (`:25`). TypeScript permits an async function where a void callback is expected. Runtime commits without await and sets `committed=true` (`packages/harness/src/runtime/driver.ts:1037`), and likewise ignores completion during partial commit/release (`:1064`, `:1083`).

**Impact:** remote persistence acknowledgment is not part of terminal success or writer ownership. Remote failure/data loss and a second writer entering too early are **hypothetical**; premature acknowledgment/release is executed. Synchronous in-memory store behavior is unaffected.

**Recommendation:** make commit/release `void | Promise<void>`, await them in every path, and order terminal success after write acknowledgment. Surface failed partial persistence and release diagnostics while preserving the original execution error. Test held/rejected commits, asynchronous release, cancellation during commit, and cleanup precedence.

**Strongest retention case:** the runtime deliberately supports live in-process continuation and a simple store; making all operations remote increases burden. Awaiting optional promises retains synchronous adapters. Durable conversation data is distinct from reviving a suspended driver; this fix does not require durable harness execution. **Migration:** additive types and stronger acknowledgment timing; implementations currently returning rejected promises will finally surface failures. Check latency expectations and close semantics rather than requiring a new storage product.

## F07 — Own webhook forwarding work and retain unsent events

**Defect; executed and source-inspected.** With a fake failed delivery and `onError:"throw"`, the probe observed an **unhandled rejection** and zero EventBus observer failures. The listener starts forwarding without returning its promise (`packages/core/src/webhooks/webhook-manager.ts:53`). With two batch records and the first failing, only the first was attempted; another flush had no records. Flush clears the full batch before delivery (`:96`) and exits on the first thrown failure (`:104`). A detach/awaited-flush timer rearm race is source-inspected (`:82`), not reproduced.

**Impact:** destination incidents can lose never-attempted events and escape process rejection handling. This is the webhook adapter’s work ownership defect. EventBus correctly isolates returned observer promises; the prior observation-only decision remains sound.

**Recommendation:** explicitly own/observe forwarding promises, preserve unacknowledged records, serialize flush/stop, and expose delivery/drain diagnostics. Return the promise to EventBus when appropriate, or catch/report it in the adapter. A bounded best-effort queue is sufficient for observation; add a durable outbox only for applications explicitly requiring delivery guarantees.

**Strongest retention case:** analytics/webhooks should not block model execution; durable delivery machinery would be disproportionate. The targeted repair maintains observation-only semantics while preventing avoidable rejection and loss. **Migration:** low, but specify retry duplication and shutdown timeout behavior. Test throw mode, partial batches, enqueue during flush, stop during delivery, and noncooperative sinks. Existing webhook tests cover successful/filter/retry/batch/manual-flush paths (`packages/core/src/webhooks/__tests__/webhook-manager.test.ts:19`, `:97`), not these failure boundaries.

## F08 — Reject incompatible synchronous budget reads

**Defect in compatibility methods; executed and source-inspected.** A canonical fixture record totaling `"0.072"` with `maxCostPerRun:0.05` produced: `queryCosts.total="0.072"`, async scoped `checkBudget` blocked, yet `estimateRemaining("run-1")` returned **0.05 remaining**, `isBudgetExceeded` returned false, and string `checkBudget("run-1")` did not block. Those synchronous methods read only legacy totals (`packages/core/src/cost/cost-tracker.ts:230`, `:375`, `:405`). Canonical usage is separately recorded. `getEntries` already rejects this incompatible state (`:418`).

**Impact:** adopters maintaining old dashboards/manual preflight enforcement can misreport headroom or miss an exceeded budget. This does **not** demonstrate failure of normal Agent canonical admission: the scoped decision correctly blocked in the same probe, and 105 selected accounting tests passed.

**Recommendation:** apply the documented canonical/legacy incompatibility guard to every synchronous total/budget method; add async scoped remaining/status queries backed by the ledger. Deprecation alone is insufficient when results silently look valid. Keep compatibility methods for purely legacy local data if needed.

**Strongest retention case:** signatures were preserved to ease v4.5 migration, and old manual tracking can still work. Refusing incomplete answers matches the existing release decision better than inventing zero spend. **Migration:** some old code will newly throw; provide a migration example and typed error pointing to async scoped APIs. Test all legacy reads after `recordUsage`, including mixed histories.

**Prior decision explicitly examined:** retain accounting in core. Attempts, admission, usage normalization, finalization and nested scopes touch execution invariants (`packages/core/src/cost/accounting.ts:117`, `packages/core/src/cost/context.ts:26`). A separate mandatory cost package would create more bypass opportunities; optional pricing/catalog/store adapters or subpaths are enough. Threshold budgets intentionally may overshoot on an admitted call; reservation mode requires a defensible bound (`packages/core/src/cost/budget.ts:75`, `packages/core/README.md:232`). That tradeoff is documented, not a new defect. Unknown cost remains null rather than zero; snapshots are not provider invoices.

## F09 — Retrieval must not inherit arbitrary write authority

**Defect conditional on database permissions; executed dispatch, source-inspected backend.** A fake model generated `MATCH (n) WITH n LIMIT 1 DETACH DELETE n`. GraphRAGRetriever handed it **unchanged** to the fake store. The prompt says “prefer” MATCH over write (`packages/core/src/graph/retriever.ts:22`); a LIMIT regex is the only local transformation (`:37`); generated text directly reaches `runCypher` (`:76`, `:85`). Neo4jCypherStore opens a normal session and executes it with the caller’s principal (`packages/core/src/graph/cypher-store.ts:75`). No database mutation or external exploit was executed.

**Impact:** retrieval is exposed to destructive/provider-generated queries when the principal can write. A preexisting LIMIT also bypasses the configured bound; a comment/string/earlier LIMIT is not an output cap. The `graph` subsystem is a knowledge graph, not an execution graph (`packages/core/src/graph/cypher-store.ts:5`, `packages/core/src/graph/types.ts:1`).

**Recommendation:** separate trusted raw Cypher operations from a retrieval-only authority. Require a read-only database principal; offer parameterized supported read operations or a rigorously parsed query policy restricting writes, procedures/admin commands and multiple statements. Enforce output/time limits outside generated text. Parser checks supplement actual permissions; READ access mode is routing and not a security guarantee, as the [Neo4j JavaScript manual](https://neo4j.com/docs/javascript-manual/current/transactions/) explains.

**Strongest retention case:** arbitrary schema queries are the feature and hosts already own credentials; fully constraining Cypher reduces usefulness. Keep raw CypherStore for trusted application code and an explicit advanced escape, but do not silently give a Retriever that authority. **Migration:** provide read-adapter/permission verification guidance and deprecate permissive defaults. Test generated deletes, unsafe procedures, misleading LIMITs, oversized results and permission errors. The observed dispatch warrants S1 conditional on a write-capable store; actual destructive database behavior remains unverified.

## F10 — Give handoff one lifecycle owner

**Defect; executed and source-inspected.** A real Agent using exported `createHandoffTool`, a real specialist with fake model, and `TeamMode.Handoff` failed with **`Handoff requested without configured targets`**, specialist calls zero. Team expects `member.run()` to reject with HandoffSignal (`packages/core/src/team/team.ts:321`). ToolExecutor now catches it as out-of-band settled control (`packages/core/src/tools/tool-executor.ts:364`); Agent consumes that control and requires its own configured targets (`packages/core/src/agent/agent.ts:901`). Team’s test mocks an obsolete thrown `run()` protocol (`packages/core/src/team/__tests__/team.test.ts:417`).

**Impact:** the advertised native Team handoff journey is blocked. Supplying Agent targets moves delegation into Agent, so Team’s transfer chain/limits cease to be its owner.

**Recommendation:** deprecate TeamMode.Handoff and favor Agent handoff or a harness driver owning routing. Retain it only if a shared explicit transfer outcome gives one owner transcript, identity, policy, settlement and limits. Do not restore thrown early transfers that abandon sibling effect settlement. Narrow Team to distinct, tested prompt orchestration recipes rather than promise every coordination style.

**Strongest retention case:** a team router conveniently coordinates independently configured members. It deserves a public abstraction if its semantics differ usefully from Agent delegation; the current protocol does not meet that threshold. **Migration:** medium; explain moving targets/limits and write a real Agent+tool+Team integration test before deprecation. Direct Agent handoff can remain.

**Related Team drift, separately characterized:** `memory` promises shared member memory (`packages/core/src/team/types.ts:30`), but Team consumes neither memory nor storage; TeamFactory even scopes then passes unused memory (`packages/core/src/agent/factory.ts:68`). That is source-inspected S2, not an executed tenant leak. Remove/deprecate unused settings before implicitly mutating borrowed Agents. Collaboration exhaustion passes empty member responses to synthesis (`team.ts:282`), executed with a fake coordinator. Buffered `Team.stream` awaits run (`:126`); coordinator generation drops run options (`:378`) and member options omit some accepted fields (`:367`). These need recipe-specific tests and accurately narrowed contracts; they do not justify a general graph rewrite.

## F11 — Drain all owned memory work before closing its store

**Lifecycle defect; executed drain symptom, source-inspected shutdown.** Holding the fake overflow-summary model open, `awaitExtractions()` returned with zero summaries; releasing the model later persisted one. Overflow summary is untracked (`packages/core/src/memory/memory-manager.ts:169`), while afterRun extraction has pending-operation tracking (`:362`) and drain watches only that set (`:428`). Agent starts background extraction (`packages/core/src/agent/agent.ts:973`) but closes storage without first draining it (`:560`). The API advertises graceful-shutdown use of drain (`memory-manager.ts:419`).

**Impact:** the application lacks a dependable completion boundary for its own asynchronous persistence. Immediate process exit or store shutdown may lose work; that loss was **not executed**. Best-effort extraction and fast run responses are valid choices.

**Recommendation:** one operation owner for summaries/extraction; bounded drain with diagnostics; Agent.close drains owned work before closing owned storage. Specify borrowed storage behavior and freshness opt-in. Keep normal run latency independent of extraction and keep observers informational. Noncooperative callbacks require timeout/cancel diagnostics, not indefinite shutdown waits.

**Strongest retention case:** extraction is explicitly best effort and mandatory synchronous extraction would make every request slower or close hang. A bounded explicit lifecycle preserves low latency. **Migration:** close may wait longer; document limits and provide host-owned storage/drain options. Test held/rejected summaries and extraction, close during work, and borrowed shared drivers. A separate queue-backed MemoryWriter can be optional; do not build durable orchestration into MemoryManager by default.

## F12 — Give lexical retrieval a corpus lifecycle

**Defect/contract gap; executed and source-inspected.** Using the same surviving fake vector collection, keyword search returned one document before KnowledgeBase recreation and zero after; vector search still returned one. Each object allocates a fresh BM25 (`packages/core/src/knowledge/knowledge-base.ts:78`); initialize initializes only the vector store (`:81`); only that object’s additions populate BM25 (`:87`). VectorStore lacks a hydration/enumeration contract (`packages/core/src/vector/types.ts:1`). Hybrid ranking consequently loses its lexical component silently.

**Impact:** restarting a worker or constructing another wrapper changes retrieval semantics despite persistent documents. Default vector retrieval still works; this is not evidence that all knowledge ingestion or retrieval fails.

**Recommendation:** an optional lexical search port, native hybrid backend, or persisted document journal with explicit rebuild/readiness. If dependency-free BM25 stays, label it local/ephemeral and expose completeness. Do not add mandatory enumeration to every vector backend or re-embed persistent documents merely to rebuild lexical state.

**Strongest retention case:** local BM25 is cheap and useful for short-lived corpora, and it avoids a search service dependency. Keep that mode explicitly; persistent search must see a corpus independent of one object’s write history. **Migration:** vector-only consumers unaffected; persistent hybrid consumers choose a lexical backend/rebuild strategy. Test restart, shared wrappers, out-of-band ingestion, deletion, and score-quality consistency; similarity/throughput benchmarks alone miss corpus lifecycle.

## F13 — Add typed provider-owned native escape hatches

**Architectural tradeoff; source-inspected; integration burden is judgment.** ModelProvider is a small structural contract (`packages/core/src/models/provider.ts:4`), but shared ProviderOptions is a flat catalog of OpenAI/Anthropic/Gemini knobs (`packages/core/src/models/types.ts:161`). Built-in OpenAI accepts only key/baseURL and constructs its SDK (`packages/core/src/models/providers/openai.ts:10`, `:31`); Anthropic similarly creates its own client (`packages/core/src/models/providers/anthropic.ts:22`). An adopter needing custom transport, SDK middleware, headers or an unmodeled native feature must provide a custom adapter and own normalization for the additional native behavior. Existing adapters can be composed/delegated; a complete source fork is not necessary in every case. Public custom model factory configuration is `any` (`packages/core/src/models/registry.ts:29`). Telephony’s injected fetch/auth/timeout is a better existing integration precedent (`packages/core/src/telephony/types.ts:98`).

**Before — supported shared knobs:**

```ts
new Agent({ name: "bot", model: openai(modelId),
  providerOptions: { serviceTier: "priority" } });
// a missing native knob/client option requires a custom ModelProvider today
```

**After — hypothetical additive adapter API:**

```ts
const model = openai(modelId, {
  client: applicationOwnedClient,
  nativeOptions: { /* adapter-specific, SDK-typed request settings */ },
});
```

**Recommendation:** keep portable messages/tools/basic options and normalized usage; add typed provider-scoped options and owned/borrowed client/transport injection. Prevent overriding framework-owned tools/model/signal, validate capability support, and meter the same adapter invocation. Provider-native calls made elsewhere remain host accounting responsibility. Use a provider conformance suite rather than claiming all native features are portable.

**Strongest retention case:** normalization makes swapping easy and limits surprising provider behavior. The bounded native extension makes that portability boundary more honest. **Migration:** additive initially; gradually deprecate flat provider-only fields with adapter-specific replacements, preserve returned billing facts and opaque replay envelopes.

**Jev/Decisions verified:** these are question/decision providers (`packages/core/src/models/providers/jev.ts:28`, `packages/core/src/models/registry.ts:175`), not ordinary chat models. Their questions/decisions appear in general ModelConfig/RunOpts/RunOutput (`models/types.ts:234`, `agent/types.ts:241`, `:252`). OpenAI Decisions rejects tools and chat knobs (`models/providers/openai-decisions.ts:95`). Add explicit decision capability/operation; do not force incompatible accounting systems or pretend tools are supported.

## F14 — Evaluate an application target without adopting Agent

**Integration defect; executed public type check and source-inspected.** A real source Agent with fake model passed one deterministic EvalSuite case. A structural application `{run(input,opts):Promise<RunOutput>}` was rejected by public declarations with TS2740: it lacks Agent internals and many unrelated members. `EvalSuiteConfig.agent` requires Agent (`packages/eval/src/types.ts:50`); CaseLifecycle calls only `.run` for execution (`packages/eval/src/case-lifecycle.ts:103`). Its own integrity tests cast fake Agents (`packages/eval/src/__tests__/result-integrity.test.ts:23`).

**Impact:** custom loops, harness applications and composition wrappers need a cast or concrete Agent wrapper just to evaluate application behavior. This weakens a useful standalone package. The current rich RunOutput/scorer contract can remain Agentium-specific.

**Before:**

```ts
new EvalSuite({ name: "app", agent, cases, scorers });
// `agent` must be the concrete Agent type
```

**After — hypothetical minimal compatible extension:**

```ts
interface EvalTarget {
  run(input: MessageContent, opts?: RunOpts): Promise<RunOutput>;
}
const target: EvalTarget = { run: applicationRun };
new EvalSuite({ name: "app", agent: target, cases, scorers });
```

**Recommendation:** accept a structural target (or `Pick<Agent,"run">`) first. A generic task callback with arbitrary outputs can be considered later; it is not necessary to unblock common composition. Retain per-case deadlines, session reservation until noncooperative callbacks settle, invalid-score rejection, and infrastructure/execution distinctions. These are unusually valuable tested guarantees (`result-integrity.test.ts:123`).

**Strongest retention case:** Agent provides session/tool/usage-aware evaluation semantics and cancellation metadata. Keeping RunOpts/RunOutput preserves those without requiring the class. **Migration:** additive and small; update WeakMap typing and strengthen consumer type tests. Do not require users to rebuild an eval framework or introduce another agent factory to make a fake.

## F15 — Make publication an explicit host operation

**Architectural tradeoff; source-inspected.** Agent/Team/Workflow constructors register by default (`packages/core/src/agent/agent.ts:470`, `packages/core/src/team/team.ts:40`, `packages/core/src/workflow/workflow.ts:35`). The global registry exposes maps and silently replaces same-name entities (`packages/core/src/serve.ts:71`); Agent.close does not unregister (`agent.ts:560`). Transport can inject a registry or disable it (`packages/transport/src/express/router-factory.ts:147`, `packages/transport/src/socketio/gateway.ts:34`), while admin EntityFactory hardcodes global entity/model registries (`packages/admin/src/entity-factory.ts:2`, `:59`, `:110`).

**Impact:** construction changes routing/discovery outside the object, same-name instances change ownership, and closed/ephemeral instances can remain discoverable. Actual endpoint exposure through a particular application was not tested. `register:false` already provides a useful local escape, but integrations use it inconsistently.

**Before:**

```ts
const agent = new Agent({ name: "bot", model }); // global publication
```

**After — hypothetical host API:**

```ts
const agent = new Agent({ name: "bot", model, register: false });
const registration = host.register(agent); // explicit collision policy
await registration.close(); // removes only this owned registration
```

**Recommendation:** add injected registries to factories/admin, ownership-aware handles, and explicit replacement policy. Offer concise `host.serve(agent)` for discovery; change the constructor default only in a major release. Keep model factory registration separate from publishing runnable instances. Document module-level built-in model registrations (`packages/core/src/models/registry.ts:51`) and the default shared SSE log (`packages/transport/src/sse-event-log.ts:103`).

**Strongest retention case:** automatic discovery materially improves the first hour and allows one-line servers. Explicit host publication retains that convenience with local lifetime control. **Migration:** additive host API first, deprecation warnings/docs next, default change later. Tests must cover duplicate names, two hosts, replacement ownership, close, and construction without publication. Do not replace this with a universal global plugin registry.

## Additional findings and architectural tradeoffs

These were investigated but do not merit fifteen additional full redesigns. Metadata is included so an engineer can prioritize them independently.

| ID | Issue and evidence | Assessment / recommendation | Confidence; reach/frequency; architectural cost; effort; migration; category |
|---|---|---|---|
| A01 | MemoryManager with only storage: `remember("retain",{userId:"u"})` fulfills; recall is empty. Executed. Optional targets absent at `packages/core/src/memory/memory-manager.ts:440`. | S3: disabled long-term memory is a good default; return `{stored:false,reason}` or require an explicit target instead of claiming a successful write. | high; new memory adopters/every disabled call; low; S; low–medium if throw; simplify |
| A02 | Workflow failure becomes StepResult.error and execution continues (`packages/core/src/workflow/step-runner.ts:35`, `:283`); fake dependent send step ran after failure. Existing tests intentionally pin this. | S2 intentional best-effort tradeoff: add `failurePolicy:"stop"\|"continue"` and aggregate outcome, preserve legacy policy explicitly before changing default. Common dependency chains should not require scanning every result manually. | high; workflows/every failed dependency; low; M; medium for default; add |
| A03 | Workflow storage option unused (`packages/core/src/workflow/types.ts:35`); factory scope ignored (`packages/core/src/agent/factory.ts:81`). | S3: deprecate inactive configuration or connect an explicit checkpoint/session owner. Do not infer durable execution from accepted storage. | high; configured workflows/every call; low; S; low; remove |
| A04 | Throwing tool probe emitted tool.call but no tool.result; rejection-to-result path `packages/core/src/tools/tool-executor.ts:181`, success `:416`. External native stream bypasses wrapper lifecycle (`packages/core/src/agent/external-agent.ts:97`); run ID ignores caller at `:77`. | S3: one terminal observation per started call; consistent assigned identity and explicit external-stream event ownership. EventBus isolation is already correct. | high; failure/custom runtime/every affected call; low; M; low; simplify |
| A05 | ToolExecutor concurrency option exists (`packages/core/src/tools/tool-executor.ts:44`), Agent executor configuration lacks it (`packages/core/src/agent/agent.ts:208`). | S3: expose one bounded concurrency option or strategy port; application idempotency still required. | high; serialized-effects adopters/common need; low; S; low; add |
| A06 | Structured output is unknown (`packages/core/src/agent/types.ts:260`); parse failure falls back to text (`packages/core/src/agent/llm-loop.ts:452`). | S3: typed structured success/validation result or explicit failure policy. Prior decision has no automatic repair call; no recommendation to silently add paid retries. | high; structured-output users/invalid generation; medium; M; medium for stricter default; simplify |
| A07 | Stream model finish precedes output guards/persistence (`packages/core/src/agent/llm-loop.ts:693`, `packages/core/src/agent/agent.ts:1388`); cost wrapper timing differs (`:1108`). | S3: distinguish step finish from terminal run result; await iterator exhaustion today. Transport UI finish-step mapping is a useful precedent. | high; stream consumers/every multistep run; low; M; low–medium; simplify |
| A08 | Core root exposes 740 named symbols; public browser helpers include parsing heuristics (`packages/core/src/index.ts:41`, `packages/browser/src/index.ts:1`). Toolkit wildcard expands every built file (`packages/core/package.json:48`, `tsdown.config.ts:12`). | S3 architectural judgment: define stable vs advanced/internal surfaces, add intentional subpaths before removing root aliases. Optional peers mean this is compatibility/cognitive cost, not demonstrated installation bloat. See README map. | high counts, judgment on cost; all adopters/ongoing; medium; L; low additive/medium removal; simplify |
| A09 | Local CLI invalid-input probes exit 1 with useful first message then raw stack (`packages/cli/src/bin.ts:64`). `dev` uses npx tsx (`packages/cli/src/commands/dev.ts:8`). | S3: concise domain errors, stacks under debug, exitCode; resolve installed executable so absent tools do not silently invite download. Download behavior source-inspected, not executed. Add JSON only if automation is supported. | high; CLI errors/common; low; S; low; simplify |
| A10 | Exact Edge README snippet fails TS2305/2345/2339 (`packages/edge/README.md:23`, `:25`, `:30`). Runtime accepts unused agent/sheddableToolkits and counts restart callbacks rather than restarting (`packages/edge/src/runtime/edge-runtime.ts:11`, `:19`, `:157`). | S2 narrow boundary: fix executable recipe/current preset; describe a health observer and host-owned restart/shedding or remove unused promises. Do not build a supervisor merely to match prose. | high; Edge adopters/first use; low; S docs/M contracts; low; simplify/remove |
| A11 | SessionManager Date fields are returned directly from JSON storage (`packages/core/src/session/session-manager.ts:53`); incremental manager rehydrates (`packages/core/src/session/incremental-session-manager.ts:90`). | S3: one versioned session codec with runtime date normalization. Date methods can fail; source-inspected only. | high; direct session consumers/JSON drivers; low; S–M; low; simplify |
| A12 | DynamoDBStorage list returns one Query page (`packages/core/src/storage/dynamodb.ts:111`). | S2 conditional: implement pagination; never treat current list as a complete corpus/ledger. No DynamoDB call executed. | high source; DynamoDB readers/large partition; low; M; low; simplify |
| A13 | Budget-fitting memory content returns without scope wrappers, unlike unbudgeted/overbudget output (`packages/core/src/memory/memory-manager.ts:280`, `:298`, `:346`). | S3: preserve trust/source markers in every assembly path and include wrapper cost in sizing. No prompt exploit executed. | high source; memory prompt users/budget-fitting content; low; S; low; simplify |
| A14 | Admin stores Workflow descriptive metadata and counts it at hydrate without constructing a runnable (`packages/admin/src/admin-router.ts:270`, `:449`; limitation admitted `packages/admin/src/types.ts:45`). | S3: separate blueprint storage from runnable hydration status; optional injectable control plane. JSON config cannot represent arbitrary callbacks/client ownership. | high source; admin workflow users/every hydrate; low; M; low; simplify |

## Verification coverage and limits

**Executed:** 26 selected existing test files, **446 tests passed**, plus three report-recipe typechecks/local fake executions (driver input, eval, memory/knowledge): 105 accounting tests, 152 Agent/tools/providers/Team/Workflow tests, 189 harness/eval/session/memory/knowledge/graph tests. Tests were inspected for effects first. There was no full-suite/build/production-integration claim. Some package tests resolve existing workspace dist, while dedicated probes import current source. All 50 current typed export paths were compared source-to-built and loaded in ESM and CJS; NodeNext `.ts`/`.cts` consumer checks passed with installed peers and `skipLibCheck`. No isolated packed consumer, publint, attw, absent-peer matrix, browser bundle, or tree-shaking measurement ran.

**Local commands:** actual local CLI help/version/subcommand help, unknown/no-argument/invalid input, piped help, all four temporary scaffolds/typechecks, overwrite refusal, valid/missing local skill. tsx CLI hit sandbox IPC EPERM; Node loader or unchanged temporary `.mjs` avoided it. Voice template configuration-only startup succeeded; basic without OPENAI_MODEL produced an actionable error. No provider-backed template ran.

**Fake-only probes:** cancellation/retry, zero tool cap, failed tool events, Workflow merge/failure/repeated replay, Team options/collaboration/handoff, canonical legacy budget divergence, independent session writers and partial metadata failure, keyword reconstruction, remember no-op, summary drain, generated Cypher dispatch, async harness commit/release, scoped identity collisions, webhook rejection/partial-batch loss, one deterministic real-Agent eval. Findings include the essential fixtures/outputs so they do not depend on retaining temporary scripts.

**Exact selected test groups:**

```sh
# All use installed tooling. These commands were inspected, then executed locally.
node node_modules/vitest/vitest.mjs run \
  packages/core/src/cost/__tests__/{accounting-lifecycle,agent-cost-dx,budget,calculator,usage,orchestration-dx,store}.test.ts

node node_modules/vitest/vitest.mjs run \
  packages/core/src/workflow/__tests__/{workflow,checkpoints}.test.ts \
  packages/core/src/agent/__tests__/{agent,controlled-loop,execution-boundaries}.test.ts \
  packages/core/src/tools/__tests__/tool-executor.test.ts \
  packages/core/src/team/__tests__/team.test.ts \
  packages/core/src/models/__tests__/{providers,fallback-provider,cancellation-forwarding}.test.ts --cache=false

./node_modules/.bin/vitest run \
  packages/harness/src/__tests__/conversational-runs.test.ts \
  packages/harness/src/runtime/__tests__/{execution-drivers,control-model}.test.ts \
  packages/eval/src/__tests__/result-integrity.test.ts \
  packages/core/src/session/__tests__/{session-manager,incremental-session}.test.ts \
  packages/core/src/memory/__tests__/memory-manager.test.ts \
  packages/core/src/knowledge/__tests__/knowledge.test.ts \
  packages/core/src/graph/__tests__/graph-rag.test.ts
```

These brace-expanded listings name the exact selected files; they are not a claim of one combined run. Source probes ran with `node --import ./node_modules/tsx/dist/loader.mjs /private/tmp/<probe>.mts`; type probes used installed TypeScript `--noEmit --module NodeNext --moduleResolution NodeNext --target ES2022 --skipLibCheck`.

**Source-inspected, not integration-executed:** external storage/accounting adapters, embedders, live provider native/reasoning paths, graph authorization, transport/queue/admin, sandbox/OS isolation, A2A/MCP interoperability, realtime/voice/telephony, durable Mongo crash/fence behavior, hardware/Edge, observability export, tenancy authentication, actual npm publication. Their tests/examples were sampled or inventoried, not exhaustively read/run.

**Unresolved questions:** supported semver tiers for root helpers; target guarantee for distributed ordinary sessions; intended Team handoff owner; lexical corpus source of truth; required async harness store semantics; client-injection retry ownership; whether any application relies on legacy best-effort Workflow continuation; how old ambiguous scoped keys/checkpoints can be migrated safely. Performance at large ledgers/corpora and deployment-specific exploitability require further controlled validation. The audit found no basis to claim invoice equivalence, arbitrary exactly-once effects, or recoverable live harness closures.
