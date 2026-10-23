# Dependable Agent and harness usage

Start with the ordinary Agent. Add a harness when the host needs shared execution policy, budgets, canonical session ownership or control policies. Recall, task summaries, verification and evaluation are optional. None requires a particular provider or database.

## 1. One Agent, a typed tool and cancellation

The application supplies a `ModelProvider` and an `AbortSignal`. This function uses only core and Zod. The caller aborts its controller and waits for the operation to settle before reusing or closing resources.

```ts
import { Agent, defineTool, type ModelProvider } from "@agentium/core";
import { z } from "zod/v3";

export async function readRecord(model: ModelProvider, signal: AbortSignal) {
  const lookup = defineTool({
    name: "lookup",
    description: "Read a local fixture record",
    parameters: z.object({ id: z.string() }),
    execute: async ({ id }, ctx) => {
      ctx.signal?.throwIfAborted();
      return JSON.stringify({ id, value: "fixture" });
    },
  });
  const agent = new Agent({ name: "reader", model, tools: [lookup], register: false });
  try {
    const output = await agent.run("Read record A", { signal });
    if (output.status !== "completed") return { outcome: "incomplete" as const, output };
    return { outcome: "completed" as const, output };
  } finally {
    await agent.close();
  }
}
```

After run-context admission, ordinary `Agent.run()` settles cooperative cancellation with `status: "cancelled"`. Pre-admission cancellation checks and `Agent.stream()` reject instead. An aborted callback can still have applied an external effect; this function's local read has none. A length/content-filter terminal response returns `status: "stopped"`, `partial: true`, a reason and `providerFinishReason`. Missing stream finish frames and empty terminal tool batches throw `ModelProtocolError` with a code and partial output. Preserve that output as evidence; do not promote it to a completed answer.

Core's `maxToolRoundtrips` counts tool batches in both run and stream paths. Zero allows a tool-free answer but no tool batch. The last allowed batch can be followed by the model's final answer; another batch is rejected before effects. Reflection and native handoff retain the target/revised result's completion state. Semantic caching stores and reuses only complete candidates.

`Agent.close()` rejects `AgentLifecycleError` with `AGENT_BUSY` while an operation is admitted; it does not cancel that operation. Cancel and await it first. Close then blocks new runs and waits up to 30 seconds for owned memory work by default. Concurrent close calls share one attempt. `MemoryDrainError` has code `MEMORY_DRAIN_INCOMPLETE` and a drain result; timed-out/cancelled waiting leaves storage open and run admission closed. Retry close after the work settles. Use `close({ closeStorage: false, memoryDrain: { timeoutMs: 5000 } })` for a borrowed backing store. The host remains responsible for closing that store.

`MemoryManager.drain()` without a timeout waits for all tracked summary, extraction and final-write work. Its `failed` count describes failures during that drain interval; `drained` means settled, not that every write succeeded. `remember()` remains a void-returning compatibility API; `rememberWithResult()` reports the actual destination or `no_destination`. Memory context is labelled user-role source data beneath host instructions, and its budget includes its rendered wrapper.

## 2. The same Agent configuration under a harness

Reuse an `AgentConfig`. This function creates a per-run owned Agent through `agentDriver(config)`. The harness disposes that Agent after owned work settles; backing clients configured by the host remain borrowed.

```ts
import type { AgentConfig } from "@agentium/core";
import { agentDriver, HarnessRuntime, type HarnessIdentity } from "@agentium/harness";

export async function runGoverned(
  agent: AgentConfig,
  input: string,
  identity: HarnessIdentity,
  sessionId: string,
  signal: AbortSignal,
) {
  const runtime = new HarnessRuntime({
    driver: agentDriver(agent),
    grants: { toolIds: (agent.tools ?? []).map((tool) => tool.name), modelRoles: ["main"] },
    budgets: { maxModelCalls: 8, maxToolCalls: 12, maxTokens: 16000 },
  });
  const result = await runtime.run(input, { identity, sessionId, signal });
  // completed, stopped, cancelled, failed and awaiting_input remain distinct.
  return result;
}
```

These numeric limits are an example host policy. Identity must come from application authentication. Tool names must be intentionally approved; configuration is not permission to operate on arbitrary host files or services. For a long-lived conversation, keep one runtime and supply a host session store when process-local defaults are insufficient.

`agentDriver(existingAgent)` borrows the Agent instead. Its host closes it. Definitions cannot supply conflicting Agent defaults/limits for a borrowed Agent. Both forms retain harness policy and aggregate budgets.

The harness returns a settled cancellation result after started work quiesces. Cancellation stops new calls and tool effects; it cannot undo an applied effect. Every known settled result is observed before cancellation enforcement can stop further batch processing. Observer errors become bounded diagnostics; they cannot authorize effects or prove task success. A provider or custom callback that ignores cancellation can delay settlement.

Session `commit()` and `release()` may be asynchronous and must acknowledge completion. A commit rejection can mean the write applied but its acknowledgement was lost. The runtime does not retry that uncertain write or redispatch the effect; it returns `session_commit_failed` with retained partial evidence. The host must reconcile its store. A local lease is not a distributed writer lock.

## 3. Evidence continuity, verified completion and optional evaluation

The host supplies these ports: archive, bounded recall store, session store, summary model, application verifier and verified identity. The SDK supplies their contracts and orchestration. Archive writes must acknowledge storage. Recall must authorize scope and seek bounded evidence directly; adapting the legacy unbounded `HistoryArchive.read()` is insufficient.

```ts
import type { AgentConfig, ModelProvider } from "@agentium/core";
import {
  agentDriver, continuityContextPolicy, currentSessionRecallPolicy,
  HarnessRuntime, incrementalTaskSummaryPolicy, verifiedCompletionPolicy,
  type CompletionVerifier, type HarnessIdentity, type HarnessRuntimeConfig,
  type HarnessSessionStore, type HistoryArchive, type RecallStore,
} from "@agentium/harness";
import { createHarnessEvalTarget } from "@agentium/harness/testing";
import { contains, EvalSuite, type EvalCase, type EvalTarget } from "@agentium/eval";

export function evidenceAwareAgent(host: {
  agent: AgentConfig;
  summaryModel: ModelProvider;
  archive: HistoryArchive;
  recall: RecallStore;
  sessions: HarnessSessionStore;
  verifier: CompletionVerifier;
  identity: HarnessIdentity;
}) {
  const config: HarnessRuntimeConfig = {
    driver: agentDriver(host.agent),
    sessionStore: host.sessions,
    grants: {
      toolIds: (host.agent.tools ?? []).map((tool) => tool.name),
      modelRoles: ["main", "summary"],
    },
    models: { summary: { provider: host.summaryModel, options: ["maxTokens"] } },
    budgets: { maxModelCalls: 8, maxToolCalls: 12, maxTokens: 16000, maxRevisions: 1 },
    residentHistory: { archive: host.archive, maxMessages: 40, maxBytes: 65536 },
    recall: {
      store: host.recall,
      policy: currentSessionRecallPolicy("project-recall"),
      maxClarifications: 1,
      budget: {
        maxQueryBytes: 2048, maxQueries: 2, maxCandidates: 5,
        maxDiscoveryBytes: 8192, maxExcerpts: 5, maxExcerptBytes: 8192,
        maxSourceBytes: 16384, maxEvidenceTokens: 2048,
        deadlineMs: 500, validationDeadlineMs: 250, maxValidationBytes: 8192,
      },
    },
    taskSummary: {
      policy: incrementalTaskSummaryPolicy({
        id: "task-summary", version: 1, modelRole: "summary",
        maxInputBytes: 16384, maxOutputBytes: 4096, maxTokens: 512,
        maxEvidenceReferences: 32, maxUncertainties: 8,
      }),
      maxInputBytes: 16384, maxSummaryBytes: 4096, maxSummaryTokens: 512,
      maxEvidenceReferences: 32, maxRecordBytes: 32768, maxSummaryRecords: 32,
    },
    contextPolicy: continuityContextPolicy({
      id: "continuity", maxRequestTokens: 12000, reservedRequestTokens: 2048,
    }),
    completionPolicy: verifiedCompletionPolicy({ verifier: host.verifier }),
  };
  const runtime = new HarnessRuntime(config);
  const target = createHarnessEvalTarget({ config, identity: host.identity });
  const structuralTarget: EvalTarget = target;
  return {
    runtime,
    async evaluate(cases: EvalCase[], expectedText: string) {
      return new EvalSuite({
        name: "project acceptance", agent: structuralTarget, cases,
        scorers: [contains(expectedText)],
      }).run();
    },
  };
}
```

`@agentium/eval` is needed only for the evaluation code. The testing adapter itself does not depend on eval or a test framework. It fixes the host identity, validates supported `RunOpts`, uses isolated per-run observers and keeps cancelled/failed traces explicitly partial. A structural `Agent` remains a valid `EvalTarget`.

Keep evaluation sessions separate from live sessions, including any persistent project/repository scope. The adapter accepts `sessionId`, `signal`, `runMode` and matching tenant/user IDs; it rejects options that try to replace host authority or model configuration. It closes owned run resources and its completed evaluation session resources, while borrowed Agents and backing clients stay with the host.

The runtime records archive references, incremental task summaries and current recall separately. Summaries cover an exact contiguous prefix of complete canonical groups. An unavailable group blocks that cursor; later relevant evidence can still be recalled without advancing the summary past the gap. Summary work requires an available model-call slot while protecting one task call; its task-token floor is advisory and final provider admission still applies.

Source reads/discovery occur within one bounded cycle before a potentially slow summary model call. Fresh validation windows check the current view after summary work and again before model submission. Terminal publication opens a fresh authorized session and drops invalid derived summaries while retaining canonical records. These checks do not make revocation atomic with provider submission or cross-store publication; hosts needing that guarantee must implement conditional publication/reconciliation.

Recall budgets bound queries, candidates, response/source bytes, excerpts, estimated evidence tokens, latency and validation. The adapter must stop backend work on abort. Evidence is included whole. Retrieval-stage policy can stop, request bounded clarification or explicitly continue with uncertainty. Insufficient prompt allocation also changes recall to partial; at that stage the policy must stop or explicitly continue. A clarification request after allocation returns `recall_assembly_omitted` because more input cannot repair an unchanged prompt ceiling. `currentSessionRecallPolicy` stops failed/partial evidence and allows an empty accessible result; a host requiring evidence for every answer should reject `no_accessible_evidence` too. The helper's query is the latest user text; production ranking and query formulation remain host choices.

Recall scope contains tenant, actor and session, plus optional project/repository IDs supplied through `runtime.run(..., { recallScope: { projectId, repositoryId } })`. Enabling continuity on a meaningful legacy snapshot without `memoryScope` requires `attestLegacyMemoryScope: true` from the host. This attests an already verified scope; it is not a bypass for a mismatched scope. A store used for task summaries must advertise `canonicalArchiveReads: true` as well as bounded discovery, reads and current revision validation.

The [indexed fixture](https://github.com/agentiumOS/agentium/blob/main/packages/harness/src/runtime/__tests__/fixtures/continuity-fixture.ts) demonstrates direct complete-group reads, bounded discovery, revision validation, physical-byte measurements and source deletion. It is a test adapter, not a persistent backend. The [runtime tests](https://github.com/agentiumOS/agentium/blob/main/packages/harness/src/runtime/__tests__/continuity-runtime.test.ts) demonstrate summary reuse, unavailable coverage, cancellation, scope attestation and precommit revocation.

The verifier reads current host evidence such as artifact digests and test records. `pass` permits acceptance; `fail` stops by default or requests a configured revision; `unknown` stops. Candidate prose and successful tool settlement do not establish verification. Evidence references are bounded to at most 32 entries and 8192 serialized bytes. Revisions share the run budget, and effects remain disabled during revision unless the host explicitly enables them.

The text scorer above is a minimal wiring example. The [memory acceptance runner](https://github.com/agentiumOS/agentium/blob/main/packages/harness/src/__tests__/context-memory-acceptance.test.ts) separately measures discovered/read evidence, prompt inclusion, answer behavior, stale facts, abstention and scope. It compares full history, incremental summaries and summaries plus recall with equal model/resource settings. Failed graders keep generated output and report infrastructure failures and valid-grade denominators; missing grades are not successes. Offline fake providers establish contracts, not production quality gains.

## Responsibility and outcome reference

| Concern | SDK behavior | Host responsibility |
| --- | --- | --- |
| Agent lifecycle | Reject busy close; drain owned memory/accounting; distinguish borrowed resources | Cancel/await admitted work; retry incomplete close; close shared clients |
| Canonical history | Harness session store owns controlled history; ordinary Agent owns its session/memory path | Select storage, retention and coordination; avoid duplicate extraction |
| Context and memory | Label archives, summaries and recall as source data; preserve evidence and uncertainty | Confirm persistent facts; own corrections, validity, deletion and access control |
| Storage identity | Explicit tuple-v1 codecs; legacy defaults preserve old records | Authenticate scope; migrate keys; choose TTLs and backups |
| Budgets | Aggregate logical model calls, tools and token reservations; separate finishing allowance | Select limits; account for physical retries and unknown provider usage |
| Completion | Validate bounded decisions; keep stopped/cancelled/failed distinct; optional current-evidence verifier | Define task proof and revision policy; reconcile uncertain effects |
| Workflows | Join produced patches; enforce strict conflicts/cancellation; validate versioned continuation | Version callable code; validate state; make external effects recoverable |
| Recovery | Snapshots/checkpoints describe completed boundaries; default stores/events are process-local | Durable stores, intent/receipt reconciliation and distributed ownership |

Ordinary token/model-call limits and reserved finishing allowances are separate. A finishing call is tool-free and cannot authorize a new effect. Logical-call counts do not equal physical HTTP attempts; cost accounting retains observable retries and marks opaque attempts/unknown usage. No SDK threshold can guarantee the final provider invoice.

Use typed errors or stable codes, not message text: `AgentLifecycleError`, `MemoryDrainError`, `ModelProtocolError`, `HarnessInputError`, `HarnessBudgetError`, `HarnessUnsupportedError`, `ModelDeadlineError`, and workflow `workflow_merge_conflict`, `workflow_cancelled` or `checkpoint_incompatible`. Inspect `HarnessResult.status`, `reason`, `partial`, `providerFinishReason`, `completion`, `budget` and cleanup diagnostics before presenting success. A session commit failure retains the primary failure and does not imply a safe retry.

See the [workflow contract](https://github.com/agentiumOS/agentium/blob/main/packages/core/src/workflow/README.md) for shallow-state limits, strict joins, versioned continuation and legacy migration. See the [storage guide](https://github.com/agentiumOS/agentium/blob/main/packages/core/src/storage/README.md) before changing a persistent key encoding. Fresh packed consumers check core-only, core+harness and optional eval in ESM/CommonJS and `.ts`/`.cts`, without optional provider/database SDKs.

## Native application-state recovery lifecycle (opt-in spike)

`HarnessStartOptions.recovery.lifecycle` records causal application-state transitions at native model completion and complete tool-batch settlement. It is an application-state contract, **not a durable native driver**. `agentDriver` continues to advertise `durable: false`; model calls still execute normally. The static execution graph keeps its existing configuration restrictions.

The host supplies an adapter with an ID, version, credential-free configuration commitment, initial-state capture, state restoration and a pure reducer. The configuration commitment must identify all executable behavior that can affect the state: tools, skill content, context policy, controller, middleware and reducer versions. The native integration additionally binds records to tenant, actor, session, original input, driver identity, grants, budgets, run mode and deadline.

After the native session lease is acquired and continuity checks pass, a fresh attempt commits initial state before application work. A rejected concurrent session writer never calls capture, persistence or restoration. On an attempt with retained records, only that initial state is restored first. Each matching settled boundary restores its own retained post-state; later states never appear before their corresponding boundary. A fresh boundary invokes the reducer once, commits the boundary and post-state together, then restores the acknowledged state. The next native model preparation awaits pending lifecycle writes. A mismatch, failed write or incomplete replay stops the lifecycle. A failed state restoration also suppresses the ordinary fallback session commit.

Tool effects can run in parallel, but the reducer receives one complete batch in declared call order after all members settle. Re-observation of the same result objects is deduplicated, including direct dispatch followed by batch observation; mixing new results into an already observed batch is rejected. Do not mutate reducer-owned state in concurrent `tool.execute` callbacks or result resolvers. Return immutable evidence/result references and derive application state from those outcomes. Reducer inputs and persisted records are copied and frozen; the reducer must not call providers, mutate external state, publish events or persist separately. The supplied persistence callback must enforce the existing authoritative task fence; this module does not create another lease or task ledger.

Native response records omit provider `raw` and direct `apiKey`/`signal` request fields. Their request identity includes the prepared messages and non-secret options as a digest. Host adapters remain responsible for excluding credentials and unnecessary sensitive data from state and tool results. Records default to at most 1,000,000 canonical JSON bytes and 1,000 boundaries. Exceeding a bound rejects the write without truncation. Large workloads need a separate referenced-record and retention contract.

This spike does **not** restore the native loop cursor, skip provider execution, replay context/summary/controller decisions, persist active-work time, recover a pending free-text question, or publish restart-safe stream/event IDs. Completed stream responses have a state boundary, but already-emitted chunks remain provisional and have no recovery protocol. Nested model/tool contexts are rejected when this lifecycle is enabled. Completion policies, standalone effect dispatch and auxiliary control/summary models need their own versioned boundaries before full native restart can be claimed. Existing session history is not an active recovery checkpoint. Use deterministic/offline retained-result tests while those gates remain open; do not treat this option as permission to retry an ambiguous production effect.

## Native decision journal (explicit host integration)

`HarnessStartOptions.recovery.native` is a separate opt-in path. The SDK retains decisions while continuing to execute the ordinary native Agent loop. The host supplies the existing task authority through `journal.operation(id, input, execute)`, a stable `taskId`, a configuration commitment, and optional application state capture/restore. Do not combine this option with `recovery.lifecycle`.

The operation callback must execute only for a fresh or safely reconciled operation. The host must atomically check the recorded input identity and commit the complete output under its current task lease/fence. A committed operation returns its retained output without invoking the callback. A pending effect after worker loss requires a connector receipt or another authoritative reconciliation result; the SDK does not authorize a blind retry. This API creates no independent task supervisor, scheduler or retry ledger.

The version 1 journal input contains `kind`, `configurationDigest`, `scopeDigest`, and `inputJSON`. The result contains `valueJSON` and `snapshot: { applicationJSON, harnessJSON }`. Payloads use JSON strings or ordered `chunks-v1` references so legitimate field names such as `__proto__`, `constructor` and `prototype` survive the durable store's record validation. All payloads are validated finite JSON; undefined object properties are omitted, and functions, cycles, host service instances and nonfinite numbers are rejected. Credentials and abort signals are excluded from model request identity. Records have a default 4,000,000-byte encoded limit; exceeding it fails closed instead of truncating history or application state.

Large values, application/harness snapshots, and non-tool/non-input decision inputs reuse immutable content-addressed fragments through the same task journal. `snapshot-chunk` operations have IDs `native/snapshot/<digest>`, an `inputJSON` object containing that digest, and a `{ version: 1, data }` result. They can retry an interrupted immutable write, never invoke application restoration, and must be retained with their referring operations. Every fragment is acknowledged before its parent operation commits. Reads verify each digest plus the complete text's digest, length and byte count before restoring state; absent or corrupt fragments stop recovery. Content-defined boundaries reuse unchanged history even when preceding counters change length. Large decision inputs encode `{ nativeInput: <reference> }` in `inputJSON`; tool/input request fields remain directly readable for domain receipt and question reconciliation. A retained text is bounded to 128,000,000 decoded bytes, while the host continues to enforce its aggregate task quota over physically stored records. Fragment reuse does not reset that quota. The regression fixture retains and freshly replays 150 distinct 64 KB model/tool results with growing application and harness histories within a 128 MB aggregate journal cap.

Retained boundaries include run preparation, complete nonstreaming and streaming model responses, auxiliary control-model responses, complete tool outcomes, tool settlement observers, completion decisions, history retention and finalization. Model capture happens after request preparation, context projection and after-model middleware. Tool capture happens after authorization, execution and output transforms. Native recovery runs tools in declaration order with concurrency one, preserving causal application state even if a worker is lost between members of a model's tool batch. Sibling decisions are serialized and a failed decision prevents queued work in its causal frame. Each committed boundary restores its own application and harness state before later work runs. Completed replay skips providers, tools, transforms and the recorded controller/context/middleware callbacks.

The host must include executable and tool/skill/context policy versions in `configuration`; callbacks are not serialized. Use a pinned `SkillMdSnapshot` for a reproducible native catalog. Keep callable policy objects in runtime configuration, rather than returning new function-bearing objects from `prepareRun`. Ordinary nested Agent/handoff execution remains rejected under this opt-in until it has an explicit resumable contract. Arbitrary Agent hooks outside the harness execution-service boundaries, external resource factories, and live steering are not durable journal operations. The driver-wide `durable` capability therefore remains false; applications explicitly opt into the tested root-native subset.

For free-text input, supply `requestInput(request)` that durably records the question, then throws `HarnessNativeInputPending(request)` when no accepted answer exists. The run settles as `awaiting_input` with a stable pending question ID and releases its worker resources. On a replacement worker, return the durably accepted `InputReply` for that ID. Acceptance is itself a nested recorded operation, so a loss after acceptance but before the enclosing tool settles does not consume the answer twice. Persist expiration and active-work time in the host task ledger; process-local timers alone do not cover a restart.

Completed stream chunks replay without reopening the provider, and harness public-message IDs remain stable within the logical task. Before completion commits, emitted chunks are provisional. The generic in-memory event store still has per-attempt IDs and timestamps; a durable UI timeline belongs to the host event store. Native core Agent event-bus listeners also retain their own presentation IDs.

The host continues to provide `recovery.persistBudget` and restores `budgetState` with the same limits. Completed replay spends no additional model calls, and tool admission IDs remain stable. An interrupted provider attempt retains the existing conservative unknown-usage accounting. `native_recovery_failed` identifies journal, snapshot, retained-payload or persistence failures; consult the authoritative pending-operation state before deciding whether the task can resume. An ordinary harness budget exhaustion still returns its stopped outcome. No npm publication or deployment is implied by enabling this source-level integration.
