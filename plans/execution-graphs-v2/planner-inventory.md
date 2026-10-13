# Planner and streamed-plan inventory

Read-only source investigation at `e9551e3690bdf274fc66f82222851fe9d06d8e97`. This report proposes implementation contracts; it does not claim they exist or have passed tests. Scope: the optional model-generated tool-DAG planner and safe streamed revisions requested in the 2026-10-13 attachment. No source edits, installs, builds, tests, commits or paid model calls were performed for this inventory.

## Existing hooks and relevant constraints

| Hook | Current behavior | Consequence for the extension |
|---|---|---|
| `packages/core/src/agent/execution-services.ts:42` and `:48` | Host `model`/`streamModel` ports receive provider, messages, options and optional child context. | Planner calls should use these controlled ports, never invoke `provider.generate`/`provider.stream` directly under harness execution. |
| `packages/harness/src/runtime/driver.ts:880` | `prepare` checks active state, reserves a model call, chooses a granted host model role, narrows tools, projects context, applies model options and joins cancellation/deadlines. | A first implementation can use `services.model/streamModel` with an empty tool list. Controller-selected role semantics still apply. Do not promise a dedicated planner role unless adding a granted-role operation. |
| `packages/harness/src/runtime/driver.ts:1216` | Reserves projected input plus output token capacity before dispatch. | Correction and streamed-planning calls use the same root budget. An invalid proposal must still retain billed usage and model-call consumption. |
| `packages/harness/src/runtime/driver.ts:1384` and `:1415` | Controlled generation/streaming account usage, run middleware, settle reservations, track iterator lifetime, and require a terminal usage record. | Preserve these wrappers and cleanup. During streaming, a valid committed prefix can survive a later model-protocol failure, but no uncommitted bytes become executable. |
| `packages/harness/src/runtime/driver.ts:204` and `:1254` | `controlModel(role, messages)` is explicitly granted, tool-free and shared-budget; skips ordinary controllers, projection and middleware to avoid recursion. It rejects provider/tool continuation and non-stop/tool-call outputs. | Useful for nonstreaming planning if planner deliberately uses this harness-specific seam. There is no existing `streamControlModel`, so streaming must use the existing controlled streaming port or add a symmetric optional host operation. |
| `packages/core/src/models/types.ts:217` | `responseFormat` supports text, JSON and JSON Schema. `StreamChunk` at `:117` has text deltas and tool-call fragments. | Provider schema hints improve generation but cannot replace SDK validation. A data-only NDJSON commit protocol can use plain text deltas without executing tool calls. |
| `packages/core/src/agent/llm-loop.ts:566` | Agent structured-output parse errors only warn; output may fall back to raw text. | Do not treat ordinary Agent structured output as an executable-plan validation boundary. Dedicated proposal parsing must fail closed. Preserve the Agent loop for ordinary workloads. |
| `packages/core/src/tools/types.ts:35` | ToolDef includes parameter schema, executable closure, optional raw JSON Schema, approval, sandbox and result transformer. | Catalog descriptions must exclude executable closures. Model proposals name catalog IDs/versions; host registration alone provides executable bindings. Raw JSON Schema and model metadata are not approval or effect authority. |
| `packages/core/src/tools/schema.ts:17`, `:32` and `:36` | Existing Zod 3/4 structural boundary, parse and safe-parse helpers. | Reuse for proposals and concrete arguments; introduce no schema-library migration. |
| `packages/core/src/tools/json-schema.ts:11` | Zod conversion diagnoses runtime-only transforms/refinements. | Do not assert that a proposal's schema proves arbitrary future output references satisfy executable refinements. Validate resolved arguments at admission as well. |
| `packages/core/src/tools/tool-executor.ts:249`, `:278`, `:299`, `:360` | Runtime schema validation, protected argument snapshots, mandatory policy composition, approval and sandboxed/direct execution. | Planner execution must keep this boundary. Do not dispatch raw catalog closures outside it. |
| `packages/harness/src/runtime/driver.ts:796` | Harness policy checks grants then calls `budget.admitTool()` before host policy. | Calling this policy during speculative plan validation consumes budget. Separate pure host catalog/preflight checks from final execution-time policy. |
| `packages/core/src/workflow/step-runner.ts:203` | Every ordinary FunctionStep under harness is already an effect via `dispatchEffect`. | Wrapping `services.dispatch(toolCall)` in an ordinary FunctionStep charges/adjudicates both the wrapper and tool. Prefer an explicit binding-step kind or a single controlled binding execution boundary. |
| `packages/core/src/workflow/graph-runner.ts:99`, `:216` | Episode validates complete materialized graph then snapshots/freeze edges; scheduler is currently one-shot. | Reuse graph validation/state ownership, but safe streaming needs a committed versioned plan journal and admission against the current revision. Mutating the existing frozen node array is insufficient. |
| `packages/core/src/durable/types.ts:105` | Atomic bounded task updates, CAS and fences; extensions can hold serialized state. | Commit revisions and pending-node claims in the same fenced aggregate. Scope this to one root task; existing store has no cross-task transaction guarantee. |
| `packages/core/src/durable/actions.ts:54`, `:106`, `:190` | Logical action IDs bind connector version/destination/arguments/policy/grants/identity; execution writes intent before dispatch, confirmed receipt returns without dispatch, unknown/executing requires reconciliation. | Bind every planned effect to this ledger. Pending revisions must not overwrite any prepared/executing/confirmed/unknown action or reinterpret its inputs. |
| `packages/core/src/durable/records.ts:105`, `:136` | Sequenced fenced events and immutable artifact references, bounded retention; blobs precede reference commit. | Use bounded events for revision/causal observations and artifacts for immutable raw/validated proposals. Recovery state must not depend solely on events that may be truncated. |
| `packages/harness/src/runtime/events.ts:76` | Harness event history is explicitly in-process and non-durable. | Observability events supplement persisted graph state; they cannot serve as recovery proof. |
| `packages/harness/src/testing.ts:121` | Existing verified-host eval target preserves grants/model settings and records tools with bounded coverage. | Evaluate planner/stream cases through the actual harness; add planner-specific revision/reference/admission metrics rather than inferring them from displayed text. |
| `packages/harness/src/drivers.ts:19`, `:111` | Existing workflow driver is non-durable and follows the unchanged Workflow API. | Add durable capabilities only through a verified adapter. Preserve the default driver and old checkpoint consumers. |

## Recommended implementation order

1. Establish durable graph/node/binding contracts and root scheduling/expansion admission. Freeze those interfaces before implementing planner code.
2. Add a host-approved executable binding catalog and versioned serializable proposal format. Implement nonstreamed planning, full proposal validation and bounded correction through controlled model calls.
3. Add a bounded text-stream parser producing candidate commit frames. Connect validated frames to the same durable revision commit and scheduler admission protocol.
4. Add persistent-backend process-crash tests for revision commits, pending edits, in-flight siblings and planner restart; run matched offline fixtures through the public harness/eval surfaces.

The catalog, proposals and stream protocol can be additive. They should not create another ordinary Agent loop, retry owner, independent budget ledger or external-effect adapter stack.

## Initial design options

The initial alternatives below motivate the contract. The concrete coordinator-aligned interface in the final sections supersedes these illustrative names and discriminated reference syntax.

```ts
type BindingReference = { id: string; version: string };
type PlanValue =
  | { kind: "literal"; value: DurableJSON }
  | { kind: "input"; path: readonly string[] }
  | { kind: "output"; nodeId: string; path: readonly string[] };

type ProposedNode = {
  id: string;
  binding: BindingReference;
  arguments: Record<string, PlanValue>;
  dependsOn?: readonly string[];
};

type ExecutionProposal = {
  schemaVersion: 1;
  baseRevision: number;
  nodes: readonly ProposedNode[];
  observations: readonly string[]; // References to retained causal evidence.
};

interface ExecutableBinding {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly inputSchema: AgentiumSchema;
  readonly outputSchema: AgentiumSchema;
  readonly tool: ToolDef; // Host-only; never serialized or taken from proposal.
  readonly durable: SupportedDurableBinding;
  validateProposalArguments(template: Readonly<Record<string, PlanValue>>): void;
}

type PlannerOptions = {
  maxCorrections: number;
  maxProposalBytes: number;
  maxPlanDepth: number;
  maxNodes: number;
  maxRevisions: number;
  maxStreamFragmentBytes: number;
};
```

Use a strict discriminated reference object; never interpret `${...}`, JavaScript, shell strings, JSONPath functions, URLs to executable modules, arbitrary property access or string interpolation as code. Array segments should be explicit validated indexes if supported. For object paths, read only own properties and reject prototype/accessor traversal. Input paths are bounded to the immutable root/node input snapshot. Output refs refer to a producer's recorded validated output in the same scoped graph episode.

The approved catalog should expose only execution-eligible bindings. It needs an immutable digest covering IDs/versions, serializable input/output contracts, effect metadata and durable adapter identity. A restored plan rejects a changed catalog/binding version before admission. Catalog registration verifies executable uniqueness and recovery safety once; speculative validation cannot widen tool/model grants, substitute implementations, or grant itself approval.

Tool-DAG execution should use one real tool boundary per binding operation. A binding-step kind is preferable to wrapping `services.dispatch` inside FunctionStep, because the latter creates a separately budgeted effect. The concrete adapter must preserve original tool schema transforms, policy, approval, sandbox and output transformer or reject unsupported combinations. For durable execution, transformations/sandbox hooks that can themselves perform effects need coverage in the durable adapter contract; a ToolDef's `read` label alone does not prove replay safety.

Catalog Agent bindings can delegate to the existing Agent while relying on the same durable Agent-effect protocol. They must not imply arbitrary Agent restart safety from safe function recovery. Unsupported Agent tools, delegation or captured resource effects must fail before admission.

## Complete proposal validation and bounded correction

Validate all executable structure before committing/admitting any node:

- Strict versioned shape; bounded JSON bytes/depth/arrays/strings; positive bounded revision fields; valid Unicode identifiers; duplicate IDs, bindings and fields rejected.
- Every binding exists in the frozen host catalog at the requested version, has a supported durable mode when durable execution is selected, and passes pure effect-policy compatibility checks.
- Node count/depth/local concurrency/replanning/revision allowances fit host limits and remaining root expansion. The model cannot raise them.
- All control and data references resolve within the candidate revision or retained immutable prior nodes; automatic data dependencies join control dependencies for cycle validation.
- Literal arguments and root-input values undergo runtime schema checks. Future output references undergo template/path/producer validation using declared supported output paths or host `validateProposalArguments`; every node's resolved concrete arguments must later pass its executable schema before effect intent/admission.
- No reference may depend on missing/cancelled/failed/superseded output or target an unsupported accessor/prototype path. Refine incompatible declared paths before effects. Data-dependent predicates/refinements that cannot be proven before runtime remain admission checks, clearly documented.
- Owned state/output keys join under the existing explicit conflict policy; completion timing must not choose the winner. Output is validated and persisted before downstream references become ready.

A model proposal is data. Host-authored instructions remain the system/developer prompt; task content, retrieved content, tool observations and correction errors stay quoted user/source data. Reject unexpected tool calls from the planning response. A model-supplied `instructions`, `code`, `grants`, provider or executable field is not accepted by the schema.

Count at most `maxCorrections + 1` complete logical planning responses. The planner owns schema correction only; providers/harness retain their existing transport retry ownership. Retain each raw proposal, validation diagnostics, model identity/usage, parent revision and causal observation refs. On exhaustion return a machine-readable invalid-plan terminal, not an empty success. Do not erase invalid attempts or reset budgets when correcting or resuming.

Persist accepted materialized plans before dispatch, not only the model request needed to regenerate them. A restart uses committed plans and observations rather than resampling old choices. Interrupted uncommitted proposals may be discarded/replanned under the retained planning counters and original deadlines; expose this distinction from deterministic replay.

## Safe streamed commit protocol

Use complete bounded NDJSON records in text chunks. No raw delta or incomplete JSON record is executable. The parser caps individual fragment/record bytes and total proposal bytes, rejects unexpected tool/reasoning records as plan data, and emits strict records such as:

```ts
type StreamedPlanRecord =
  | { type: "commit"; proposal: ExecutionProposal; commitId: string }
  | { type: "finish"; revision: number };
```

Each commit supplies a complete replacement of the current executable topology, including immutable running/completed nodes, rather than relying on arbitrary in-place patches. A first commit can be a self-contained prefix: all its references/prerequisites resolve in the committed prefix. A future missing node cannot act as a placeholder for runnable work. Nodes depending on uncommitted future work stay in model/parser staging and cannot dispatch.

Commit protocol:

1. Parse/validate a complete frame and its proposed full topology. Resolve frozen catalog, static input references and immutable prior outputs. Compute canonical proposal/binding/input digests.
2. Atomically, under the current root lease fence and exact base revision, re-check phases/action intents, reject protected-node changes, consume total expansion/revision allowance, and persist the new materialized plan, causal observations and commit decision.
3. Notify/wake scheduler only after that write succeeds. Scheduler claims readiness and freezes a node's concrete inputs against the currently committed revision under the same atomic protocol.
4. A duplicate `commitId` with the same canonical proposal returns the recorded decision. The same ID with changed bytes conflicts. An obsolete base revision conflicts; do not reinterpret the proposal silently against a later revision.

Allowed edits concern **pending and unprepared** work: add nodes, change their arguments/binding/dependencies, or remove them, provided all remaining dependencies and refs still validate. A node whose effect intent is already prepared is protected even if its display phase says pending. Running/completed/uncertain/failed/cancelled nodes and their causal inputs/output/effect evidence are immutable in a streamed revision. Editing dependencies of a completed node must also be rejected; it would rewrite the explanation of work already done.

For an edited pending logical node, increment a persisted incarnation/generation, revoke superseded local admission tokens and never reuse the old effect identity for different inputs. An implementation may require a new logical node ID instead of silently changing the operation; either way retain prior candidate/commit/tombstone evidence and charge cumulative expansion. Deleting and re-adding work must not refund lifetime expansion. Immutable output references remain accessible even if topology rendering hides a retired pending declaration.

Reject running/completed mutations for this feature. This is a supported safe streamed protocol; an explicit future cancellation/reconciliation protocol may permit broader replacement, but an abort signal does not prove the remote effect was rolled back. Late results/effect acceptances from superseded or fenced-out attempts are retained by durable adapter evidence and cannot overwrite current node state. A lease fence protects local commits, not an already-sent remote request.

Frame commits and ready-node claims must serialize through the authoritative store. A preflight read followed by an unfenced mutation races with dispatch. Similarly, writing a journal event separately from topology without a recoverable commit marker can acknowledge a plan that never committed.

## Global limits and stream lifecycle

- A stream model call occupies the root's physical model-work slot until its iterator settles. It uses normal root model/token/deadline reservations.
- Graph/repeat/planner coordinators do not hold worker slots while awaiting children. Concrete controlled function/tool/model operations hold slots. Root allowance remains shared across nested graphs, Agent tool batches and planning.
- If root concurrency is one, consuming/committing the model stream must continue without awaiting an effect's completion; effects wait for the model slot to release. Otherwise "await commit, then await node, then read next model fragment" can deadlock. Graph execution and stream parsing need distinct progress channels.
- Charge each committed new incarnation/node expansion and every actual execution attempt according to the root contract. A failed correction/plan fragment consumes planning/model allowance as specified; it cannot create an unbounded new stream outside the root limits.
- On malformed fragments, interrupted stream, usage-protocol failure or budget exhaustion, retain already committed revisions and completed effects. Stop new admission, mark planning failure/partial terminal, drain already-started work, preserve late evidence and explicitly expose unresolved nodes. Do not pretend the prefix is a successful complete task.
- On cancellation persist root cancellation first, close the iterator, stop admissions and drain owned work. Recovery does not restore cancelled planning as a fresh run. Durable counters/deadlines/cancel state must survive attempts.
- A stream ending after a valid commit but without an explicit plan `finish` is interrupted planning. A plan `finish` alone is insufficient until the controlled model stream also settles its terminal protocol/accounting. Keep the final committed revision; do not silently discard completed work.

## Required tests, not executed by this inventory

Write observable failing tests before implementing the behavior:

1. Valid chain/fanout/cross-dependency proposal uses one real tool admission per binding, correct causal output refs, deterministic joins and ordinary grants/approval enforcement.
2. Duplicate/malformed Unicode IDs, missing binding/version, code/grant fields, cycles, absent producer/path, deep/oversized JSON, incompatible literal args and unsupported durable effects fail before any unauthorized dispatch.
3. One malformed proposal then corrected proposal retains both records and shared model/token consumption; correction cap returns an explicit invalid-plan result.
4. An observation containing "ignore host policy" remains source data; a proposed forbidden binding fails even when the model labels it read-only.
5. Fragments split across every byte boundary emit zero executable work until a complete validated commit. A complete safe prefix may dispatch while a later record is still arriving.
6. Pending add/change/remove succeeds; changing running/completed/uncertain or action-prepared nodes fails. Editing a pending node racing with claim yields exactly one fenced winner, preserves old evidence and prevents stale publication.
7. Same commit ID/revision/bytes is idempotent; same ID/different bytes and obsolete base revision conflict. Removing prerequisites or introducing a future unresolved ref/cycle fails atomically.
8. Plan-generation/token/revision/node-expansion exhaustion stops new work without refunding consumed lifetime counters. Nested graph + Agent tool batches + streamed planner never exceed measured root active work.
9. Root concurrency one completes without parent/stream deadlock; cancelling queued work releases permits, while active work holds its permit until actual settlement.
10. Malformed later frame, missing stream finish, model usage-protocol failure and cancellation preserve committed effects/late evidence but produce a partial/failure terminal.
11. Fresh-process persistent-backend crashes before/after plan commit, during pending edits, during sibling effects and between repeat/replanning episodes restore the last authoritative revision, completed nodes and counters. Mocks cannot prove this.
12. Existing Agent/Workflow fixtures, ESM/CJS and TS/CTS packed consumers retain default behavior; new contracts are available through supported public exports.

## Feasible evaluation contract

Extend the existing public `scripts/compare-execution-graphs.ts` comparison with three paired arms: existing Agent loop, complete-proposal planner, streamed-prefix planner. Use task-keyed deterministic providers first, identical executable tools, input/output schemas, grants, root model/token/tool/expansion/concurrency budgets and isolated storage. Keep held-out expected outputs out of model-visible prompts. Fix cases and number of runs before execution.

Cases should include ordinary chains/fanout/cross-dependencies, useful pending correction, malformed/forbidden proposal, stream interruption, superseded pending work, budget exhaustion and ambiguous effect reconciliation. Match the model fixture and resource ceilings; report each arm's actual consumed calls/tokens rather than equalizing consumption after the fact. Correctness must mean completed validated outputs; partial prefixes stay in the denominator as failures/partial outcomes.

Record task correctness, dependency violations, forbidden-binding proposals versus actual unsafe dispatches, unresolved effects, stale-commit attempts accepted/rejected, model calls/tokens, tool/attempt/expansion counts, peak aggregate work, wall time and unknown usage. Preserve infrastructure failures, cancellation and skips separately. Offline fixtures show protocol correctness only. Their timing with zero provider delay cannot establish production latency, task quality or billed-cost improvement. Paid/live provider evaluation is separately unauthorized; do not perform it.

## Compatibility and material limitations to document

The planner remains optional, and existing complete GraphStep/RepeatStep/Agent paths preserve behavior. A new binding/planning step variant is additive but exhaustive external switches may need updates. Keep v2 top-level checkpoint formats readable; durable graph recovery uses a separate versioned adapter/state contract rather than relabeling those checkpoints durable. Host-owned credentials/storage/connectors remain outside serializable plans.

Supported streaming means validated self-contained commit frames and pending edits under fences, not unrestricted live code mutation. Future-output argument refinement remains a concrete admission check. Graph durability must explicitly cover Agent effects or reject unsafe Agent bindings before dispatch; safe function-only tests cannot establish general Agent recovery. Local fencing and retained evidence do not guarantee exactly-once external execution. These are semantic boundaries, not reasons to omit the required capabilities.

## Concrete API contract aligned with the coordinator

This section is design-only while foundation tasks 1–3 are implemented. No planner/stream source implementation should start before their working gate. Coordinator owns `packages/harness/src/runtime/graph-contracts.ts` (GraphBinding), runner, journal CAS and budget/admission integration; the planner expert can own new proposal validation, model generation and bounded NDJSON decoding modules/tests without shared-file edits. Keep these new modules in harness alongside that catalog to avoid a core-to-harness package dependency.

```ts
// Parent-owned executable catalog. parseInput/parseOutput are host JSON validators;
// names can align with the foundation module without changing these semantics.
type GraphBinding =
  | {
      id: string; version: string; kind: "tool"; tool: ToolDef;
      parseInput(value: unknown): DurableJSON;
      parseOutput(value: unknown): DurableJSON;
      recovery: "pure" | {
        connector: DurableActionConnector;
        resolveResult(resultRef: string): Promise<DurableJSON>;
      };
    }
  | {
      id: string; version: string; kind: "agent"; agent: Agent;
      tools: readonly string[];
      parseInput(value: unknown): DurableJSON;
      parseOutput(value: unknown): DurableJSON;
    }
  | {
      id: string; version: string; kind: "graph"; program: ExecutionPlan;
      parseInput(value: unknown): DurableJSON;
      parseOutput(value: unknown): DurableJSON;
    }
  | {
      id: string; version: string; kind: "repeat"; program: ExecutionPlan;
      maxIterations: number;
      while(state: DurableJSON, completedIterations: number): boolean;
      parseInput(value: unknown): DurableJSON;
      parseOutput(value: unknown): DurableJSON;
    };

// JSON templates are literal JSON except reserved exclusive output-ref objects.
type GraphOutputReference = { $ref: { node: string; path: readonly string[] } };
type ExecutionPlanNode = {
  id: string;
  binding: string;
  version: string;
  args: Record<string, DurableJSON>;
  dependsOn?: readonly string[];
  inputsFrom?: readonly string[];
};
type ExecutionPlan = {
  schemaVersion: 1;
  revision: number;
  nodes: readonly ExecutionPlanNode[];
  maxConcurrency?: number;
  merge?: "error" | "declaration_order";
};
type PlanValidationLimits = {
  maxBytes: number;
  maxNodes: number;
  maxDepth: number;
  maxConcurrency: number;
  durable: boolean;
};
type PlanReferenceRequirement = {
  consumer: string;
  producer: string;
  outputPath: readonly string[];
  argumentPath: readonly string[];
};
type ValidatedExecutionPlan = {
  plan: ExecutionPlan;
  order: readonly string[];
  referenceRequirements: readonly PlanReferenceRequirement[];
  digest: string;
  catalogDigest: string;
};
function validateExecutionPlan(
  value: unknown,
  catalog: readonly GraphBinding[],
  limits: PlanValidationLimits,
): ValidatedExecutionPlan;
function resolvePlanArguments(
  node: ExecutionPlanNode,
  outputs: ReadonlyMap<string, DurableJSON>,
): Record<string, DurableJSON>;

type PlanCommitFrame = { baseRevision: number; plan: ExecutionPlan };
type ValidatedPlanCommitFrame = {
  baseRevision: number;
  validated: ValidatedExecutionPlan;
};
type PlanStreamLimits = {
  maxFrameBytes: number;
  maxTotalBytes: number;
  maxFrames: number;
};
// Decoder accepts text chunks; model adapter separately rejects tool-call chunks.
function decodePlanCommitFrames(
  source: AsyncIterable<string>,
  limits: PlanStreamLimits,
  signal?: AbortSignal,
): AsyncGenerator<PlanCommitFrame>;
```

`args` is a JSON object whose nested ordinary values may contain an exclusive `{$ref:{node,path}}` object. A reference object may not have additional fields; malformed `$ref` markers fail instead of falling back to a literal. This reserves `$ref` within planner argument objects; if a workload requires literal `$ref` payloads, it needs an explicit separately-versioned escaping convention. Do not add ambiguous string interpolation. JSON numeric path segments can be permitted only when canonical array-index syntax is validated; other path segments use own-data-property traversal and reject `__proto__`, `prototype` and `constructor`.

References infer mandatory data/scheduling edges in addition to declared `inputsFrom`/`dependsOn`. Declared `inputsFrom` must also resolve and can supply inherited state according to the parent runner contract. Any producer needed by an argument is not optional, even if the model omits it from declared edge arrays. The pure validator returns requirements without creating phases, allocating incarnations, contacting providers, charging budgets, evaluating a repeat guard, calling parseOutput on absent future values, or invoking host authorization.

The version pins the implementation/schema/predicate contract. Durable catalog construction must reject duplicate IDs, invalid versions, unsafe bindings, unsupported Agent-local tool access and recursive static programs. Freeze trusted catalog references or copy their descriptors at registration; plain readonly TypeScript properties do not prevent runtime replacement. An Agent's `tools` getter (`packages/core/src/agent/agent.ts:96`) and harness-tools merge (`:499`) mean the declared allowlist must be enforced at dispatch, not checked only once when registering the Agent. Host version discipline remains necessary for opaque closure behavior.

`parseInput` may normalize validated concrete data; persist the normalized result and its digest before any effect identity is bound. During structural proposal validation, call it only when args have no unresolved refs. For referenced arguments, the binding needs a pure template validator or explicit declared reference-path contract if the SDK promises preflight type compatibility. Otherwise the documented guarantee is structural reference validation plus full concrete input validation before dispatch, not proof that every possible future value passes custom predicates. `parseOutput` validates every effect/Agent result before persistence and successor readiness.

Planning interface:

```ts
type PlannerObservation = {
  id: string;
  kind: "input" | "node" | "effect" | "validation";
  data: DurableJSON;
};
type PlannerProposalRecord = {
  id: string;
  baseRevision: number;
  source: "model" | "stream";
  raw: string;
  observations: readonly string[];
  status: "proposed" | "validated" | "rejected" | "interrupted";
  planDigest?: string;
  diagnostics?: readonly { code: string; path: readonly string[]; message: string }[];
};
interface ExecutionPlannerConfig {
  provider: ModelProvider;
  catalog: readonly GraphBinding[];
  validation: PlanValidationLimits;
  maxCorrections: number;
  maxOutputTokens: number;
  stream: PlanStreamLimits;
  hostInstructions: string;
  record(record: PlannerProposalRecord): Promise<void>;
}
interface PlannerRequest {
  services: ExecutionServices;
  ctx: RunContext;
  baseRevision: number;
  input: DurableJSON;
  observations: readonly PlannerObservation[];
  currentPlan?: ExecutionPlan;
}
interface ExecutionPlanner {
  plan(request: PlannerRequest): Promise<ValidatedExecutionPlan>;
  stream(request: PlannerRequest): AsyncGenerator<ValidatedPlanCommitFrame>;
}
function createExecutionPlanner(config: ExecutionPlannerConfig): ExecutionPlanner;
```

Planner `record` is required so proposed/invalid/corrected choices are available for diagnosis; the parent binds it to its bounded journal/records sink in durable mode. Journal `record` failure prevents plan dispatch. Model usage stays in the controlled model port rather than a second ledger. `plan()` requires a complete stop response without executable tool calls, uses at most `maxCorrections + 1` controlled calls, and returns a validated plan for the parent to commit. Parsing/correction failures throw a typed machine-readable error. `stream()` generates validated candidate frames, never calls catalog tools or commits phases itself. The parent owns authoritative commit, decision evidence and scheduler coordination.

The stream adapter consumes only text chunks as NDJSON proposal bytes. Provider thinking/public messages remain non-executable observations; any tool-call fragment fails planning. In this frames-only protocol, successful provider completion/EOF seals planning. Buffered non-whitespace at EOF is a malformed trailing frame. Missing terminal provider accounting, truncation, stream error or cancellation is interrupted planning even after earlier frames were valid. Parent observes successful seal separately from the existence of an accepted frame; a nonempty prefix alone is not complete task success. Nonstream correction is bounded; malformed streamed planning may fail explicitly after retaining its prefix without a second correction stream.

## Frozen revision and pending-edit rules

An uncommitted episode has revision `0`; first plan revision is `1`. A frame for base `N` requires `plan.revision === N + 1`. Accepted exact retransmission of an already-recorded revision/digest returns the previous decision. Conflicting bytes at the same revision or an obsolete unrelated base fail. Parent journal CAS owns these rules; pure validation alone cannot detect a concurrent claim.

The candidate is a full plan, with identical canonical definitions for all existing protected nodes. Parent must compare binding/version/args/control/data edges, not only IDs. "Protected" includes any node with prepared effect intent, allocated irreversible ownership or a running/completed/failed/cancelled/uncertain record. The allowed phase is pending and unprepared. Changed pending nodes receive a new persisted incarnation; removed nodes are tombstoned, not erased from evidence, and expansion is never refunded. References to removed pending nodes fail. Existing immutable producer outputs/effects remain retained; revisions cannot imply rollback.

Candidate validation must precede its atomic commit, and the commit must revalidate protection against current authoritative node state. Only after commit acknowledgement may the scheduler claim nodes from that revision. Before dispatch, claim checks revision/generation, concrete input digest and catalog version; stale/superseded attempts may retain evidence but cannot publish into current state. Parent does not hold a root leaf slot while waiting for these orchestration actions.

Coordinator implementation agreement: the commit reserves all candidate node identities as pending journal records before scheduling. Identity is scope/node ID/incarnation, and replaced or removed pending records become superseded tombstones. `journal.node` performs the claim CAS; an active same-fence duplicate claim rejects. The runner executes an existing Workflow for the observed committed topology, checks incarnation at claim, drains already-started work, then rebuilds from the latest plan with completed outputs cached. Superseded pending callbacks cannot execute. The stream parser progresses independently of graph completion, including at root concurrency one.

## Reusable Mongo process-fixture layout

Existing reliable hooks:

- `packages/core/src/durable/__tests__/fixtures/crash-worker.ts:6` accepts explicit URI/database/task/phase. It initializes a fresh Mongo store and supervisor; `:29` blocks after intent preparation and `:39` blocks after a real Mongo effect but before returning its receipt. IPC indicates the reached barrier before SIGKILL.
- `packages/core/src/durable/__tests__/mongodb.integration.test.ts:30` launches independent `fork` workers with `--import tsx`, captures stderr and a 15-second timeout, waits for IPC and exits. `:61` kills workers; `:67` waits past lease expiry. `:85` tests two-process arbitration and a stale fence.
- `packages/harness/src/watch/__tests__/fixtures/mongo-watch.ts:20` builds the same real store, unique Mongo document effect connector and test services; `:28` provides reusable named barriers. The connector requires acknowledged durable destination writes, not a vi.fn result.
- `packages/harness/src/watch/__tests__/watch-mongodb.integration.test.ts:10` follows the same IPC/SIGKILL/lease-expiry pattern. Both suites use `AGENTIUM_DURABLE_MONGO_TEST=1`, explicit `AGENTIUM_DURABLE_MONGO_URI`, isolated generated database names and task-owned cleanup.

Recommended new files owned by the process/eval worker:

```text
packages/harness/src/__tests__/fixtures/durable-graph-fixture.ts
packages/harness/src/__tests__/fixtures/durable-graph-worker.ts
packages/harness/src/__tests__/durable-graphs-mongodb.integration.test.ts
scripts/compare-durable-execution-plans.ts
```

`durable-graph-fixture.ts` should construct the parent adapter, pinned catalog, deterministic offline model, fresh store/records and real Mongo effect destination. `durable-graph-worker.ts` receives only explicit test endpoint/database/task/scenario/phase and IPC commands. Reopen the same task in a **second fresh process** for recovery, rather than proving only that the Vitest parent can reconstruct a runner. Maintain destinations/counts/dispatch audit/model audit in the isolated database so all assertions survive process death.

Barrier phases should cover `plan.before_commit`, `plan.after_commit`, `node.claimed_before_dispatch`, `effect.accepted_before_receipt`, `effect.receipt_before_node_done`, `sibling.one_done_one_running`, `repeat.guard_committed`, `repeat.next_episode_committed`, `stream.prefix_committed`, `stream.pending_revision_committed`, and `agent.model_recorded_before_tool`. Wrapper-based phase hooks should be test-owned: observe acknowledgements from store/connector operations, send IPC, then await forever; do not add production crash knobs solely for testing.

Use a noncrashing sibling fixture to prove its completed output is reused. Use the real document connector's read/reconciliation to resolve a killed accepted effect without increasing destination count. After a killed prepared effect, admission may dispatch safely under the same operation intent. After receipt but before node completion, receipt resolver completes the node without redelivery. Record original absolute deadline and budget/admission snapshots in the task, verify they persist, and exhaust only remaining allowance on recovery. Simultaneous recovery workers should yield one fence owner and reject an old fence's node/plan commit.

The test worker's stream provider can emit one closed safe frame, block on IPC while a sibling runs, emit a pending-only replacement and block after its persisted acknowledgement, then be killed. Recovery verifies the second committed revision, obsolete pending incarnation tombstone and completed outputs. A separate invalid replacement case attempts to edit the running sibling and asserts revision unchanged plus rejection evidence. Task corruption/binding-version mismatch must fail before any destination insertion.

## Focused local test plan for planner ownership

Planner expert-owned source/test files, after the foundation gate:

```text
packages/harness/src/runtime/execution-proposal.ts
packages/harness/src/runtime/execution-planner.ts
packages/harness/src/runtime/plan-stream.ts
packages/harness/src/runtime/__tests__/execution-proposal.test.ts
packages/harness/src/runtime/__tests__/execution-planner.test.ts
packages/harness/src/runtime/__tests__/plan-stream.test.ts
```

Parent supplies/imports the trusted GraphBinding shape and owns index exports and runner integration. Tests should pin public observable contracts before implementation: complete proposal reference/dependency validation without invoking catalog execute/policy/guard; byte/depth/node/concurrency bounds; exact safe own-property reference resolution; pure literal and concrete input validation; one controlled model call then one bounded correction; forbidden tool/code/grant proposals; proposal record retention/fail-closed sink; provider cancellation/accounting behavior; every text-fragment split point; valid self-contained prefix emission; malformed later frame preserving prior output; incomplete tail; frame and total byte bounds; duplicate revision and monotonic candidate rules. Real phase/edit CAS and persistent recovery belong in parent/process integration tests.

Stop after this contract and fixture plan until the coordinator signals tasks 1–3 working. These sections are a proposed freeze, not evidence of implemented capability.

## Durability-foundation implementation status

The coordinator subsequently authorized the pure catalog/proposal validator and journal commit helper as prerequisites for safe durable admission. Model planning and streamed model integration remain behind the foundation gate.

Implemented owned modules:

- `packages/harness/src/runtime/execution-proposal.ts` exports `validateExecutionPlan(value, catalog, limits)`, `resolvePlanArguments(node, outputs, maxDepth = 64)`, `graphCatalogDescriptor(catalog, limits)`, `graphCatalogDigest(catalog, limits)` and `ExecutionPlanValidationError`.
- `packages/harness/src/runtime/plan-commit.ts` exports `MaterializedExecutionPlan`, `commitExecutionPlan(journal, root, scope, frame)` and `readExecutionPlan(journal, scope)`.

Validation rejects malformed or executable data, undeclared output references, missing/cyclic dependencies, unsafe property paths, unsupported durable tool recovery, and unsupported durable Agent configuration before execution. Referenced arguments require exact host declarations and template approval; resolved arguments are subsequently parsed by the parent runtime at admission. Nested graph/repeat programs share inherited depth checks; repeat guards do not execute during preflight. Durable tool cache and `toModelOutput` options fail admission until an explicit recorded policy exists. Ordinary `durable: false` validation retains support for these options. Catalog JSON schemas use only the trusted converter's serialized JSON representation, removing Zod4's nonenumerable `~standard` runtime annotation before strict finite-JSON validation. Untrusted proposal validation remains strict.

Commit preflight uses authoritative journal time and phases before reserving lifetime counters, then repeats those checks in the commit CAS. It atomically retains a revision at `${scope}/revision/${revision}`, updates `plan:${scope}`, reserves pending node records and supersedes obsolete unclaimed incarnations. Stable node keys are `node:${durableDigest([scope, node.id, revision, nodeDefinition])}`; their scope, node ID and originating revision are retained in metadata. Identical retained revisions return their original materialization without regressing the current pointer or charging again. Losing races and failed reservations conservatively consume admission allowance. Protected operations and their causal definitions remain immutable, including removal or a later change to merge semantics. Declared ordering cannot reorder protected writers.

Local verification on 2026-10-13:

- Proposal tests: 43 passed, covering the initial RED implementation, targeted RED cases for premature catalog callbacks, Agent approval/configuration, dependency depth, duplicate executable names, Zod4 descriptors and unrecorded durable tool policies.
- Commit tests: 17 passed, covering retained revisions, pending replacement/removal, prepared/completed/uncertain/cancelled immutability, original deadlines and cancellation, bounded reservations, ownership restart, snapshot corruption, a real in-process claim-versus-commit race and competing revision CAS.
- Parent static adapter tests: 4 passed in the combined focused run. Total: 64 tests across three files.
- Biome checked and formatted all four owned source/test files successfully; harness `tsc --noEmit` succeeded.

Evidence logs: `/tmp/agentium-planner-foundation-green.log`, `/tmp/agentium-planner-foundation-biome.log`, `/tmp/agentium-planner-foundation-tsc.log`; targeted RED logs include `/tmp/agentium-execution-proposal-zod4-red.log` and `/tmp/agentium-execution-proposal-tool-policy-red.log`. These checks prove local contracts and adapter integration. The commit fixture uses an in-memory task store; it is not evidence of persistent-backend process-death recovery. The coordinator owns those separate Mongo process checks, package exports and the runtime adapter. No optional planner or stream implementation, source commit, backend launch or paid model call has been performed by this worker.

## Planner implementation after the foundation gate

The coordinator confirmed foundation adapter, global capacity, budget restoration and fresh Mongo worker recovery checks before authorizing optional planning implementation. Implemented modules now include `packages/harness/src/runtime/execution-planner.ts` and `packages/harness/src/runtime/plan-stream.ts`; the earlier inventory's read-only status describes its initial phase.

Final integration APIs are:

```ts
interface ExecutionPlanGenerationOptions {
  program: ExecutionGraphProgram;
  scope: string;
  input: DurableJSON;
  catalog: readonly GraphBinding[];
  limits: PlanValidationLimits;
  services: HarnessExecutionServices;
  journal: DurableGraphJournal;
  root: RootExecutionController;
  signal?: AbortSignal;
  depth?: number;
}
generateExecutionPlan(options): Promise<MaterializedExecutionPlan>;
streamExecutionPlans(options, onCommit: (plan: MaterializedExecutionPlan) => void): Promise<void>;
decodePlanCommitFrames(source, limits, signal?, onFrame?): AsyncGenerator<PlanCommitFrame>;
```

`onCommit` is a synchronous notification to wake the independent scheduler. It does not wait for graph nodes or effects. `onFrame` is an optional async pre-parse evidence observer used by the planner; standalone decoding needs no observer. The decoder emits only newline-closed protocol frames, supports arbitrary fragments and CRLF, bounds UTF8 bytes and frames, retains valid prefix emission before a malformed later frame, and races a suspended `next()` against cancellation. It requests iterator cleanup without waiting indefinitely for an uncooperative source after abort.

Planning metadata at `planning:${scope}` pins configuration, input, provider, catalog, inherited depth and mode. It retains lifetime attempts/corrections and stream bytes/frame counts across owners. Complete calls and stream lifetimes use `journal.model` IDs `${scope}/planner/model/${index}` around the existing controlled `services.model` / `services.streamModel` operations. Requests always supply `tools: []`, bounded output tokens, a 30-second default call latency, the original absolute deadline, and combined caller/services/root cancellation. The optional `PlanStreamLimits.maxLatencyMs` changes that host-pinned latency. Neither models nor proposals construct callbacks, widen grants, invoke policy preflight or dispatch catalog tools.

The controlled prompt puts fixed host instructions and protocol requirements in the system message. Input, catalog descriptors, current retained topology, operation status/output-digest observations and validation diagnostics remain user source data. Proposed, validated and rejected frames retain bounded raw evidence, source/model identity, input digest, plan digest and base-revision causality. Normalized model responses and stream terminal usage are retained without opaque provider objects or credentials.

Corrections apply only to invalid complete proposals. A failed commit admission interrupts immediately instead of spending correction calls. A transport failure, malformed stream or provider truncation with remaining allowance raises `DurableRecoveryRequiredError` while retaining committed prefixes. Recovery allocates a fresh bounded continuation with the current revision and materialized topology. A permanently exhausted fresh-call allowance raises terminal `ExecutionPlanValidationError`, preserving the causal diagnostic. It does not leave a nonresumable task pretending to await another recovery attempt. Cached complete model responses remain reusable at the cap. A completed stream terminal result retained before metadata sealing is also validated and sealed without a fresh call; incomplete or uncertain streams require continuation. Sealed planning performs no further provider calls.

The pure validator now accepts `initialDepth = 1` as an optional fourth argument. It rejects invalid or exhausted inherited depth before catalog callbacks, carries depth into existing dependency/static-nesting guards, and keeps the catalog digest independent of episode depth. Planner options carry `depth`; every candidate and a provider preflight use it. The parent runtime is responsible for passing each child's accumulated absolute episode depth. This closes the dynamic nested-planner reset that otherwise allowed each proposal to restart its depth allowance.

Verification on the latest owned state:

- Initial planner/parser stubs produced 19 failing cases and five expected rejection cases that already passed.
- Targeted RED checks reproduced stalled-source cancellation timeout, wasted model corrections after a rejected commit, duplicate same-owner planning, missing malformed-frame evidence/counts, cached stream sealing at the attempt cap, inherited dynamic depth reset, split-surrogate UTF8 overcount, and a simultaneous admission loser clearing the winning pending reservation. Already-active admission errors now bypass interruption cleanup so they cannot mutate another call's planning state.
- Latest focused run passed 97 cases across proposal validation, commit, planner, parser and the coordinator's planning adapter integration.
- Harness `tsc --noEmit` and Biome checks passed on the latest owned source/test files.

Current logs are `/tmp/agentium-execution-planner-green.log`, `/tmp/agentium-execution-planner-tsc.log` and `/tmp/agentium-execution-planner-biome.log`. Targeted RED logs are `/tmp/agentium-execution-planner-hardening-red.log`, `/tmp/agentium-execution-planner-owner-evidence-red.log`, `/tmp/agentium-execution-planner-cache-seal-red.log`, `/tmp/agentium-execution-planner-depth-utf8-red.log`, `/tmp/agentium-execution-planner-admission-race-red.log`; the initial RED log is `/tmp/agentium-execution-planner-red.log`. Persistent process recovery, matched offline evaluation, full repository checks, built-package consumption and public exports remain coordinator/evaluation-worker owned. No backend launch, paid model call, source commit, push or deployment was performed by this worker.

## Review follow-ups

The coordinator additionally assigned an isolated core cleanup correction. `RootExecutionLease.cleanup()` shares `run()`'s released/concurrent/nested-work ownership checks and AsyncLocalStorage scope, but permits already-admitted finalization after cancellation or deadline. It does not reserve another slot or work attempt. Ordinary `run()` retains its active gate, and release still waits for the callback to settle. The standalone provider wrapper now calls `cleanup()` around iterator return before releasing its permit. Three targeted RED regressions established absent cleanup and finalizer nested-dispatch bypass; 29 core root tests subsequently passed. Core `tsc --noEmit` and Biome passed, with logs `/tmp/agentium-root-cleanup-{red,green,tsc,biome}.log`. The coordinator owns the harness driver's corresponding cleanup change and subsequent build.

Catalog descriptors now pin description, strict mode, raw JSON schema, input examples and concrete sandbox settings. Sandbox environment names remain visible, while each value is represented only by its durable hash; raw host environment credentials are neither persisted in descriptors nor sent in planner catalog messages. Agent-local tool comparisons preserve executable/schema/approval/output-transform identity and allow canonical equivalence of finite copied sandbox/schema/example data. Changed permissions or model-visible contracts fail admission. Two targeted RED tests reproduced cloned-sandbox rejection and missing descriptor identity; the subsequent focused run passed 119 tests across these proposal cases, planner/commit, the coordinator's adapter integration and core cleanup. Latest Biome checks passed; harness TypeScript checks showed no owned-file errors but still reflected coordinator-owned graph recovery changes and core declarations awaiting rebuild. Follow-up evidence: `/tmp/agentium-execution-proposal-data-contract-red.log`, `/tmp/agentium-planner-followup-green.log`, `/tmp/agentium-planner-followup-tsc.log`, `/tmp/agentium-planner-followup-biome.log`.
