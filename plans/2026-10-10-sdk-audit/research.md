# Research: useful alternatives, scoped to problems

Research accessed **2026-10-10–2026-10-11**, Asia/Kolkata. Agentium baseline: **4.8.2**, commit `c5f9b5249d299f5d2d39b74c87b83f0da7c15570`. This is a primary-source design comparison, not a performance contest or procurement recommendation. External implementations were **source-inspected** (official documentation and sampled repository source), not installed or executed. Example fragments below are **hypothetical application recipes** illustrating source-inspected API shapes with application-owned identifiers; they are not independently typechecked against those packages. Recommendations are engineering judgments, marked as lessons rather than claims that an alternative is correct.

## Version and evidence snapshot

Versions are what the linked source/release returned during research, **not assertions of the latest npm release**. Main-branch manifests and unversioned docs can differ, some web results are cached, and Mastra/Evalite include prerelease material. Preserve this caveat when implementing an adapter; pin a release and verify its actual contract.

| System | Version / snapshot observed | Primary version source | Comparison depth |
|---|---|---|---|
| Vercel AI SDK | `ai` 7.0.137, main manifest | [package manifest](https://raw.githubusercontent.com/vercel/ai/main/packages/ai/package.json) | Loop control and OpenAI customization docs; not complete source audit. |
| OpenAI Agents JS | `@openai/agents` 0.20.0, main manifest | [package manifest](https://raw.githubusercontent.com/openai/openai-agents-js/main/packages/agents/package.json) | Official running/models/sessions and SDK guide. |
| Claude Agent SDK TS | v0.3.291 release observed | [official releases](https://github.com/anthropics/claude-agent-sdk-typescript/releases) | SDK overview/runtime ownership; no binary run. |
| Mastra | `@mastra/core` 1.76.0-alpha.6, main | [manifest](https://raw.githubusercontent.com/mastra-ai/mastra/main/packages/core/package.json) | Workflow suspend/resume recipe, not all runtime behavior. |
| LangGraph.js | core 1.4.21, main | [core manifest](https://raw.githubusercontent.com/langchain-ai/langgraphjs/main/libs/langgraph-core/package.json) | Persistence, state/control, fault-tolerance docs. Wrapper package version differs. |
| Temporal TS | workflow 1.24.0, main | [manifest](https://raw.githubusercontent.com/temporalio/sdk-typescript/main/packages/workflow/package.json) | Event-history/replay and TS workflow ownership docs. |
| Inngest JS | 4.22.0, main | [manifest](https://raw.githubusercontent.com/inngest/inngest-js/main/packages/inngest/package.json) | Durable step IDs/results/retry best practices. |
| Mem0 TS | 3.3.1, main | [manifest](https://raw.githubusercontent.com/mem0ai/mem0/main/mem0-ts/package.json) | OSS Node add/search/provider lifecycle recipe. |
| Letta Node | 1.12.1, main | [manifest](https://raw.githubusercontent.com/letta-ai/letta-node/main/package.json) | Independently managed memory blocks and attachment. |
| Graphiti / Zep | Graphiti 0.31.0; Zep docs v3 index | [Graphiti project](https://raw.githubusercontent.com/getzep/graphiti/main/pyproject.toml), [v3 index](https://help.getzep.com/v3/llms.txt) | Temporal graph/corpus/provenance design; Python/service boundary. |
| Evalite | main 0.19.0; v1 beta docs separately | [manifest](https://raw.githubusercontent.com/mattpocock/evalite/main/packages/evalite/package.json), [beta quickstart](https://v1.evalite.dev/guides/quickstart/) | Task/data/scorer pattern; no claim the two versions are identical. |
| promptfoo | 0.124.1, main | [manifest](https://raw.githubusercontent.com/promptfoo/promptfoo/main/package.json) | Custom JavaScript provider contract. |
| Braintrust | 3.17.0 returned manifest; cached snapshot | [SDK manifest](https://raw.githubusercontent.com/braintrustdata/braintrust-sdk/main/js/package.json) | Task/output/scorer/dataset contract docs; latest released version unverified. |
| Inspect AI | unpinned official docs/main; version dynamically derived | [project metadata](https://raw.githubusercontent.com/UKGovernmentBEIS/inspect_ai/main/pyproject.toml), [agent docs](https://inspect.aisi.org.uk/agents.html) | Python agent/eval boundary, not TS replacement. |
| Standard Schema / Commander | current official spec; Agentium installed Commander range ^12.0.0 | [spec repository](https://github.com/standard-schema/standard-schema), [Commander docs](https://github.com/tj/commander.js) | Narrow validation/CLI lessons, not package replacement proposal. |

No external service account, release download, dependency installation or provider request was used. Published documentation describes guarantees; it does not prove adversarial recovery, performance or actual deployment compatibility. Specific source snapshots were sampled, not exhaustively reviewed.

## Owning a model call and a loop

### Vercel AI SDK: call primitives first, bounded loop as an option

The documented loop can stop through predicates, change each step through preparation, pause when a tool lacks execute, or be implemented manually over generateText/streamText. This is a useful selection ladder: adopt model calls independently, then a loop, then application orchestration. It does not require declaring a workflow graph. [Loop control](https://ai-sdk.dev/docs/agents/loop-control).

Illustrative application contrast:

```ts
// Agentium 4.8.2
const result = await new Agent({ name: "reader", model, tools: [lookup],
  register: false, maxToolRoundtrips: 3 }).run(question);

// AI SDK API shape: explicit loop policy over a tool map
const result = await generateText({ model, prompt: question,
  tools: { lookup }, stopWhen: stepCountIs(3) });
```

These limits do not necessarily count the same thing: compare model steps, effect batches and final-answer opportunity before migrating. Agentium’s controlled and plain caps already differ (F01). **Lesson:** name and test the counting boundary; keep a manual call/loop escape. **Poor fit:** replacing Agentium’s qualified accounting, approvals and execution services with a text-call convenience would drop important semantics; adopting every AI SDK UI/provider abstraction also changes scope.

OpenAI adapter configuration exposes custom fetch and provider-native settings, demonstrating that normalized calls and native transport customization can coexist. [OpenAI provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai). **Lesson:** add an application-owned client/fetch and provider-scoped native options to Agentium while protecting model/tools/signal and usage normalization. It is not necessary to copy its entire provider matrix or invent universal capability equivalence.

### OpenAI Agents JS: separate configuration, runner and session

Runner makes loop ownership explicit, with turn limits, streaming, run state, context, cancellation and tool-error behavior. Sessions separately manage history; MemorySession is local, and application session implementations are possible. Provider conversation IDs and local history are different strategies. [Running agents](https://openai.github.io/openai-agents-js/guides/running-agents/), [sessions](https://openai.github.io/openai-agents-js/guides/sessions/).

```ts
// Illustrative ownership difference
const result = await runner.run(agentDefinition, input, { session, signal });
// Agentium: agent.run(input, { sessionId, signal }); backing owner lives on Agent
```

**Lesson:** document execution owner and history owner separately; a reusable runner is useful when configuration should outlive run state. Agentium already constructs run-local loops, so separation can be achieved through contracts/docs without replacing its class. State persistence and resumable tool pauses require explicit records and boundaries, not just saving a conversation.

Custom models/providers are documented escape hatches. [Models](https://openai.github.io/openai-agents-js/guides/models/). The official SDK guide states that the application hosts its tools/state/approval flow. [SDK deployment responsibility](https://developers.openai.com/api/docs/guides/agents/sdk#build-with-the-sdk). **Poor fit:** OpenAI-centric tool/Responses/handoff conventions are not a universal model protocol. Agentium should retain normalized minimum fields and preserve native opaque continuations rather than force those conventions onto Jev, Decisions, realtime or every chat provider.

### Claude Agent SDK: a specialized runtime boundary

The SDK runs the Claude Code runtime process with built-in tools, permissions, hooks and session behavior; its plugin system packages Claude-specific skills/agents/hooks/MCP configuration. That is substantially more than a model adapter and is not a drop-in replacement for an in-process neutral Agent loop. [Official overview](https://code.claude.com/docs/en/agent-sdk/overview).

**Lesson:** represent runtime capability/authority honestly. Wrapping this through a structural runnable or explicit harness driver is more coherent than pretending its tools are locally intercepted Agentium effects. **Poor fit:** adopting its automatic workspace/plugin conventions and process permissions as the default for every Agentium application. Agentium’s pure definitions, explicit host grants and separate filesystem ownership are strengths; retain them.

## Procedural orchestration, graph state and durable recovery

### Plain TypeScript remains a serious competitor

For serial business logic, `await draft(); await review();` gives clear exception propagation, application-owned state and no framework migration. This is an engineering judgment, not an external feature claim. Agentium Workflow earns its abstraction only when step metadata, branching, state operations or checkpoint browsing pay for it. Team earns its abstraction only when a model-selected coordination recipe is preferable to deterministic code.

### Mastra: typed dataflow and explicit suspend/resume

The workflow recipe supplies step input/output/resume schemas, explicit suspend, stored run snapshots and resume targeting a step. The typed resume payload teaches more than a generic callback returning unknown state. [Suspend and resume](https://mastra.ai/docs/workflows/suspend-and-resume).

**Lesson:** make paused input and resumption a contract, not a convention. Agentium live harness questions already have correlated IDs and lifecycle tests; preserve that. **Poor fit:** importing an entire workflow/storage/application framework just to fix Workflow’s parallel patch loss. Documented snapshot persistence does not by itself establish per-effect exactly-once behavior; this research did not run Mastra recovery.

### LangGraph.js: state update algebra and persistence are part of execution

Checkpointers store thread execution state; stores support cross-thread data. Memory implementations remain process-local. That distinction prevents “I have a store” from implying recoverable execution. [Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence). Fault-tolerance documentation describes retry, timeout and error-handler sequencing, including version requirements. [Fault tolerance](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance).

```ts
// Illustrative API boundary: thread checkpoint owner is explicit
const graph = builder.compile({ checkpointer, store });
await graph.invoke(input, { configurable: { thread_id: applicationThreadId } });
```

**Lesson:** explicit state merge/reducer semantics, definition identity and persistence ownership. A copied full branch state is not a valid patch merge (F04). Execution retry must have a clear relation to effects and error handling. **Poor fit:** requiring a node/edge/state DSL for an ordinary tool loop or two function calls; coupling all Agentium memory to execution thread state. Knowledge graphs and execution graphs solve different problems. No reason to rename Agentium’s graph retrieval package into a workflow feature.

### Temporal: durable execution is a deployment contract

Temporal replay checks generated commands against event history; workers and a service jointly own progress. That is materially different from a state snapshot plus rerunning arbitrary TypeScript. [Workflow execution/replay](https://docs.temporal.io/workflow-execution). TS child-workflow APIs make start acknowledgment and parent lifetime explicit. [Child workflows](https://docs.temporal.io/develop/typescript/workflows/child-workflows).

**Lesson:** durability requires recorded operation identity, replay/version discipline, acknowledgment, time/wait semantics and separate effect handling. Agentium’s durable supervisor already acknowledges unknown outcomes and reconciliation; an optional Temporal adapter could host coarse agent operations for applications that need it. **Poor fit:** adding Temporal service/worker/replay restrictions to the first-hour Agent path, or treating an activity retry as exactly-once email/payment. This audit did not execute a Temporal worker or inspect every activity retry/version contract; adapter design needs a pinned follow-up test.

### Inngest: stable step identity and saved results

step.run persists successful step results and skips completed work on replay; stable step IDs and idempotent effects remain important. The best-practice guide emphasizes putting side effects inside steps because handlers can rerun. [step.run](https://www.inngest.com/docs/durable-execution/primitives/step-run), [best practices](https://www.inngest.com/docs/durable-execution/best-practices).

```ts
// Illustrative host-owned durable boundary, not Agentium's current Workflow API
const draft = await step.run("draft-v1", () => createDraft(input));
await step.run("deliver-v1", () => deliverIdempotently(draft, businessId));
```

**Lesson:** preserve stable cursor/definition identity and separate completed results from effect outcomes. F05 needs an absolute cursor immediately; meaningful durable resume requires more than that fix. **Poor fit:** making event/service deployment a mandatory SDK concern. Optional integration is justified when recoverable waits, cross-worker retries and scheduling are actual application needs.

### Decision for Agentium

Do not build another general durable graph engine now. Repair Workflow as lightweight procedural composition/debugging and Harness as in-process controlled execution. Keep the separate durable task/action subsystem qualified. Add explicit adapters to an external engine when a real deployment requires it. No candidate removes application idempotency, versioning or operational ownership for free.

## Memory and retrieval: a corpus is not one object’s write history

### Mem0: narrow semantic memory operation, configurable backends

The OSS Node recipe adds messages with user metadata and searches with filters, separately configuring LLM, embedder and vector store. Its default path can involve model/embedding work even though the application code is short. [Node SDK quickstart](https://docs.mem0.ai/open-source/node-quickstart).

```ts
// Illustrative memory-only boundary
await memory.add(conversation, { userId: verifiedUser });
const matches = await memory.search(question, { filters: { user_id: verifiedUser } });
```

**Lesson:** a small external MemoryWriter/MemoryReader port can replace automatic Agentium extraction without replacing its loop. Make enabled targets, scope, spend, completion and deletion observable; do not let remember fulfill with no destination (A01). **Poor fit:** silently enabling semantic extraction/provider calls to make that method “work,” or copying another SDK’s defaults as safe production guarantees. Quality, tenant filtering and durable corpus behavior were not benchmarked.

### Letta: explicit always-present memory blocks

Memory blocks are managed independently and attached/detached to agents; shared blocks can be separate from retrieval. [Attaching and detaching blocks](https://docs.letta.com/tutorials/attaching-detaching-blocks/). The cited recipe and current SDK versions can differ, so its exact client call signatures are not asserted here.

**Lesson:** distinguish standing context from retrieval and extracted facts. Agentium fileMemory, sessions, summaries and learned knowledge should have explicit owners and purposes; a facade does not erase lifecycle differences. **Poor fit:** moving all application state into a hosted agent identity model or always injecting unbounded blocks. Agentium’s host-owned stores and optional features are valuable escape hatches.

### Zep/Graphiti: temporal facts and shared graph lifecycle

Graphiti models changing facts with temporal/provenance information and hybrid retrieval; Zep’s current documentation index distinguishes its managed context product from open-source Graphiti. [Graphiti overview, explicitly v2](https://help.getzep.com/v2/graphiti/getting-started/overview), [current v3 index](https://help.getzep.com/v3/llms.txt). The source project is a Python graph-building library, not a JavaScript loop runtime. [Project metadata](https://raw.githubusercontent.com/getzep/graphiti/main/pyproject.toml).

**Lesson:** corpus lifetime, provenance and fact invalidation are genuine data contracts. Lexical and vector retrieval should see the same persistent corpus after restart (F12); graph retrieval needs explicit read authority (F09). **Poor fit:** adopting a temporal graph to solve every session or memory use case, or requiring an additional service/graph database for ordinary Agent runs. The v3 markdown overview could not be retrieved by the web tool; no claim of full current Zep API verification is made.

## Evaluation: target application behavior, preserve integrity

Evalite’s documented data/task/scorer shape evaluates an arbitrary application callback; its beta docs and main version differ. [Beta quickstart](https://v1.evalite.dev/guides/quickstart/). **Lesson:** accept a structural run target before broadening Agentium into generic eval infrastructure. A task callback is a low-cost escape. **Poor fit:** copying a local watch/UI workflow as a requirement for server-side eval or discarding Agentium’s strict timeout/score/result checks.

promptfoo’s JavaScript provider modules expose an ID and callApi over application input/context, enabling adapters around existing implementations. [Custom JavaScript providers](https://www.promptfoo.dev/docs/providers/custom-api/). **Lesson:** application-owned execution should not require the concrete Agent class. **Poor fit:** moving the core runtime into a YAML/provider configuration system merely to gain evaluation flexibility.

Braintrust separates data, application task and scoring, with versioned datasets and result projections. [Datasets](https://www.braintrust.dev/docs/guides/datasets), [TypeScript reference](https://www.braintrust.dev/docs/reference/libs/nodejs). **Lesson:** stable output/cost/trace projections and reporters allow external evaluation without rewriting application logic. **Poor fit:** adopting a hosted experiment/logging service as mandatory or assuming cloud dataset/logging semantics are needed for deterministic local tests. No remote experiment was run.

Inspect supports agent composition/evaluation in Python and distinguishes conversation handoff from string-in/string-out delegation. [Agent guide](https://inspect.aisi.org.uk/agents.html). **Lesson:** declare transcript/control ownership and evaluate actual composed implementations—the obsolete mocked Team handoff test missed native protocol drift. **Poor fit:** treating Python solvers/state models as a drop-in TypeScript API or rebuilding its whole evaluation environment in Agentium.

The smallest immediate improvement is `EvalTarget {run(...):Promise<RunOutput>}` (F14), preserving current scorers, deadlines and session cleanup. Application callback/generic output can follow actual user needs. None of these external tools substitutes for deterministic fake adapters that exercise Agentium’s own operational invariants.

## Extension and CLI design

Standard Schema provides a shared validation/type interface; the current repository includes distinct specifications rather than one magic portable schema. [Official spec](https://github.com/standard-schema/standard-schema). **Lesson:** a validated schema-to-provider conversion boundary could allow non-Zod adopters without giving up inference. Validation compatibility alone does not guarantee lossless JSON-schema conversion or native tool constraints. Agentium already handles Zod 3/4/Mini and raw MCP schema; expanding support is an optional enhancement, not an essential omission.

Commander supports configurable output and exit/error handling; Agentium already depends on it, so raw user-error stacks do not require a CLI framework replacement. [Custom error handling](https://github.com/tj/commander.js#custom-error-handling). **Lesson:** concise actionable domain errors, debug stacks and reliable exit/output behavior. Add structured JSON only if automation is an intended contract. Do not build new install/discovery/telemetry machinery for a CLI whose useful function is local scaffolding.

Claude-specific plugin packages work because they target one runtime’s tools/permissions/session model. Harness ability binding, controller decisions, guardrails, EventBus observations and storage drivers have different authority/lifecycle roles. The useful common convention is explicit capabilities, pure definitions, owned bind/dispose and scoped services—not one global “plugin” hook. This is architectural judgment grounded in the inspected Agentium contracts and runtime comparison, not a claim that every alternative uses this design.

## Existing benchmarks: what they establish

**Source-inspected, not executed.** `benchmarks/run-all.sh` requires OPENAI_API_KEY, invokes external runners and writes results/report files. Running it would violate this audit’s provider-call/source-output restrictions. It was inspected first. `benchmarks/RESULTS.md` is dated **2026-03-02**, preceding current v4 contracts. Dependencies include loose/latest alternatives (`benchmarks/package.json:1`); the historical results cannot identify current pinned comparison versions.

Agentium’s benchmark calls its normalized output usage “api” usage rather than collecting an independent invoice/transport truth (`benchmarks/agentium-bench.ts:1`, `:93`). Five samples and provider-backed latency mix model/network variation with framework work (`benchmarks/agentium-bench.ts:29`, `benchmarks/langchain-bench.ts:26`). Different runtime/framework setups and negative RSS deltas under garbage collection do not prove meaningful lower overhead. `benchmarks/report.ts:420` writes the report, so it was not run.

They can establish that a specific historical recipe produced recorded outputs under its environment. They cannot establish today’s billing accuracy, native capability parity, durable recovery, cancellation semantics, memory quality, package footprint or superior production reliability. If benchmarking is resumed under authorization, pin versions, use deterministic local adapters for framework overhead, separate provider latency, preserve raw evidence, and test semantic invariants before comparing timing.

## Lessons worth adopting

1. Keep model calls and application loops independently adoptable; name effect/step/turn bounds precisely.
2. Expose provider-native customization without surrendering accounting, cancellation or tool ownership.
3. Separate configuration, execution, history, corpus and durable operation ownership.
4. Make state updates, checkpoint identity, asynchronous acknowledgment and failure policy explicit.
5. Treat live suspension, persisted conversation, queued delivery and recoverable execution as distinct capabilities.
6. Evaluate structural application targets and preserve integrity contracts; let external eval systems consume ordinary outputs.
7. Prefer optional domain capabilities/subpaths and mature integrations to a new universal framework layer.

These lessons support the staged roadmap in README. They do not justify cloning the largest alternative, maximizing feature count, or rewriting Agentium wholesale.
