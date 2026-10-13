# Evidence-based completion, harness evaluation, and public journeys

> **Status: PROPOSED; analysis only.** Use the [master plan](2026-10-13-core-harness-dependability.md) and [design](2026-10-13-core-harness-dependability-design.md). Implement only after approval.

**Goal:** Accept completion from current host evidence, evaluate the actual harness, and publish simple supported journeys.

**Architecture:** Add one CompletionPolicy recipe and a structural eval target. Evaluation remains optional; core/harness never depend on eval.

**Tech stack:** Existing TypeScript, Zod, Vitest, fake/recorded providers and packed ESM/CJS consumers.

**Global constraints / review focus:** Unknown verification cannot pass; tool settlement alone does not verify a task; missing observations/grades cannot become absence/success; respect existing session and cleanup ownership.

No source files were changed and no new builds or tests were run for this review. Current source is the evidence; the checks in host-controlled-execution/RESULTS.md remain previously executed evidence for that implementation, not evidence for these proposals.

## Verdict and findings

Retain the current execution ownership: core owns the ordinary Agent loop and provider protocols; harness owns policy, aggregate budgets, canonical records, sessions, and resource lifecycle; host supplies verified identity, storage, operational effects, and application-specific acceptance. Existing mechanisms are sufficient for the proposed completion recipe and target adapter. Do not introduce a second evaluation execution loop or a mandatory memory/eval service.

| Finding | Current evidence | Impact | Owner / compatibility |
|---|---|---|---|
| E1: Completion reflection does not verify external facts | `packages/harness/src/policies.ts:70` sends candidate JSON to a critic; `runtime/controller.ts:23` already supports arbitrary CompletionPolicy callbacks; `runtime/driver.ts:1166` enforces decisions and revision limits | Text claiming tests passed can be accepted without actual test evidence | Harness optional helper and host verifier; additive |
| E2: Completion decision evidence is dropped from public run events/results | CompletionDecision has `evidence`; `runtime/events.ts:38` carries only action/reason and `runtime/driver.ts:1172` emits only these | A host cannot explain acceptance from the ordinary final result or event replay | Harness bounded reference diagnostics; optional event/result fields |
| E3: Eval unnecessarily requires concrete Agent | `packages/eval/src/types.ts:52`, `case-lifecycle.ts:47,103`; all execution consumers invoke only `.run`; integrity tests cast fake Agents at `__tests__/result-integrity.test.ts:23` | Application wrappers/harness targets need unsafe casts | Minimal dependent eval type widening; preserve existing `agent` property |
| E4: Tool events cannot establish test success | Harness tool.complete has name/id/`denied`; dispatch sets denied to Boolean(result.error) at driver.ts:1018,1032,1062; Agent driver drops core RunOutput.toolCalls at drivers.ts:37 | A normal execution failure resembles policy denial; event counts do not prove artifact/test validity | Harness outcome diagnostics; host verification; additive |
| E5: Grading failures are conflated with bad answers | EvalSuite catches invalid/throwing scorers into score 0/pass false at suite.ts:25–35; evaluateCase catch at case-lifecycle.ts:165–175 loses completed output on later timeout | Memory/model comparisons can attribute judge infrastructure problems to the agent and lose inspectable output | Minimal dependent eval integrity repair; preserve legacy pass totals |
| E6: Public consumption coverage is good but new journeys need it | Harness package test already packs core+harness and runs ESM, CJS, strict NodeNext .ts/.cts without optional SDKs; lines 15–205 | Source-only examples can hide missing declarations/exports | Extend existing packed fixture; no new dependencies |

Existing audit F14 remains confirmed: structural target support has not yet been implemented. Do not duplicate existing host request controls, input parsers, budgets, capability types, history retention, or package test infrastructure. The completed package work already exports OpenAIConfig, AnthropicConfig, input validation, budget/history types, model control errors and ESM/CJS declarations; retain it. Defer unrelated packages, CLI/Edge/admin/queue audits, and vendor-backed benchmark claims.

## M6a: Optional deterministic completion verification

### Observable behavior and ownership

Supply an optional `verifiedCompletionPolicy` recipe using the existing CompletionPolicy boundary. It invokes one host-supplied verifier for each candidate, including each revision. The verifier returns pass, fail, or unknown. Pass accepts; fail stops by default or requests an explicitly configured host-authored revision instruction; unknown stops with the verifier's reason. Existing `maxRevisions` and `allowRevisionEffects` enforce revision behavior. Do not silently add tool grants, dispatch checks, paid model calls, or use finishing capacity.

The verifier is a trusted, read-only host callback. It checks actual facts via authenticated host services or validated artifacts, not text claims. A tool invocation with no executor error proves execution settled, not that a shell returned exit code zero or the resulting artifact satisfies requirements. Source text returned by tools remains source data. A verifier can use a host-maintained execution record keyed by tenant/user/project/run/revision, or core `getArtifact(ctx, ...)` when a trusted tool deliberately stored an artifact there. It must validate artifact content with the existing Zod dependency.

Core artifacts (`storeArtifact/getArtifact`, `ctx.sessionState`) and harness artifacts (`services.putArtifact/getArtifact`, runtime-owned map) are separate stores. Document that distinction; do not introduce a unified artifact store solely for this milestone. Neither store makes a record host-confirmed merely because it has an ID.

A record must match the current work: run, candidate revision or task execution version, repository/artifact revision and applicable scope. Old test success cannot verify an artifact subsequently edited. Cancellation is not rollback; a verifier must not perform operational effects. A bounded host callback must observe `ctx.signal`; it may impose a shorter own deadline. Existing observeControl directly awaits callbacks, so noncooperative cancellation handling depends on the lifecycle milestone, not this helper. Do not claim arbitrary JavaScript can be forcibly interrupted.

### Proposed APIs (new, in packages/harness/src/policies.ts)

```ts
import type { RunContext } from "@agentium/core";
import type { CompletionPolicy } from "./runtime/index.js";

export type CompletionCandidate = {
  text: string;
  structured?: unknown;
  revision: number;
};

export type CompletionVerification = {
  verdict: "pass" | "fail" | "unknown";
  reason: string;
  /** Stable host-validated references, not copies of arbitrary source content. */
  evidence?: readonly string[];
};

export interface CompletionVerifier {
  verify(candidate: CompletionCandidate, ctx: RunContext): Promise<CompletionVerification>;
}

export interface VerifiedCompletionPolicyOptions {
  id?: string;
  verifier: CompletionVerifier;
  /** Default: stop. Revision instruction is authored by the host, not generated from evidence. */
  onFailure?: { action: "stop" } | { action: "revise"; instruction: string };
  /** Defaults: 32 references and 8192 total UTF-8 bytes, including reason. */
  maxEvidenceEntries?: number;
  maxEvidenceBytes?: number;
}
```

Use one new helper rather than a hierarchy of verifier combinators. Hosts can compose checks inside their verifier. Do not change reflectionPolicy or the default of having no completion policy. Reflection remains useful for qualitative criticism and is explicitly described as model assessment.

Representative integration (constructor validation uses the existing positive validation convention; returned values need real runtime validation even though the callback is typed):

```ts
import { z } from "zod";

const verificationSchema = z.strictObject({
  verdict: z.enum(["pass", "fail", "unknown"]),
  reason: z.string().trim().min(1),
  evidence: z.array(z.string().trim().min(1)).optional(),
});

export function verifiedCompletionPolicy(options: VerifiedCompletionPolicyOptions): CompletionPolicy {
  const maxEntries = positive(options.maxEvidenceEntries ?? 32, "maxEvidenceEntries");
  const maxBytes = positive(options.maxEvidenceBytes ?? 8192, "maxEvidenceBytes");
  const onFailure = options.onFailure ?? { action: "stop" };
  if (onFailure.action === "revise" && !onFailure.instruction.trim()) {
    throw new Error("Revision instruction must be nonempty");
  }
  return {
    id: options.id ?? "agentium/verified-completion",
    async evaluate(candidate, ctx) {
      ctx.signal?.throwIfAborted();
      const result = verificationSchema.parse(await options.verifier.verify(candidate, ctx));
      ctx.signal?.throwIfAborted();
      if ((result.evidence?.length ?? 0) > maxEntries || Buffer.byteLength(JSON.stringify(result)) > maxBytes) {
        throw new Error("Completion verification exceeds evidence limits");
      }
      const detail = { reason: result.reason, evidence: result.evidence };
      if (result.verdict === "pass") return { action: "accept", ...detail };
      if (result.verdict === "fail" && onFailure.action === "revise") {
        return { action: "revise", instruction: onFailure.instruction, ...detail };
      }
      return { action: "stop", ...detail };
    },
  };
}
```

Treat malformed or oversized verifier results as infrastructure failure, not acceptance or a missing-evidence fallback. A legitimate unknown result is task evidence insufficiency. Do not auto-convert every thrown verifier error into unknown, because that conceals broken integrations.

Before, applications implement this mapping independently:

```ts
completionPolicy: {
  id: "project-verifier",
  async evaluate(candidate, ctx) {
    const check = await verificationService.check(ctx.runId, candidate.revision, ctx.signal);
    return check.passed
      ? { action: "accept", reason: "Verified" }
      : { action: "stop", reason: "Verification failed" };
  },
}
```

After, using the **proposed helper** (verificationService remains host-owned):

```ts
completionPolicy: verifiedCompletionPolicy({
  verifier: {
    async verify(candidate, ctx) {
      return verificationService.check({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        runId: ctx.runId,
        candidateRevision: candidate.revision,
        signal: ctx.signal,
      });
    },
  },
  onFailure: { action: "revise", instruction: "Resolve the reported verification failure, then present the result." },
}),
```

The host service contract in this example is application code, not an existing Agentium symbol. A README fixture should implement it concretely with recorded facts and Zod validation. Fixture pass requires an actual matching run/revision and artifact hash with exitCode 0; absent/mismatched data returns unknown and nonzero exitCode returns fail. Avoid interpreting arbitrary console text as a test result.

### Bound evidence diagnostics

In `packages/harness/src/runtime/events.ts`, add optional `policyId`, `revision`, and `evidence?: readonly string[]` to the existing completion payload. Add optional `completion?: { policyId: string; revision: number; decision: CompletionDecision }` to HarnessResult, using a type-only import from controller.ts. Runtime stores the last validated completion decision, not every candidate response. Bound stored/emitted decision reason/instruction/evidence collectively to 8192 UTF-8 bytes, leaving room inside the existing 64 KiB generic event limit for result text, identity and envelopes. Reject an oversized decision before acceptance; do not truncate away the evidence required to justify acceptance. Add shared private completion-decision validation in runtime/controller.ts and invoke it before emitting or acting: validate action-specific instruction/evidence/reason fields, nonempty policy ID, safe revision and total bounds. This applies to existing custom policies too; malformed output fails closed. No lifecycle milestone is assumed to have already supplied this helper.

In runtime/driver.ts, attach those fields when emitting completion and attach the last decision to terminalResult. A result subsequently cancelled/failed retains the decision as an observation, not proof the run completed. Only final status completed plus decision accept establishes completion acceptance. Bound/reference-only diagnostics prevent a critic or verifier from copying private artifacts into normal events. Hosts must still redact reference strings as needed.

Refactor three tool.complete construction sites to one private helper preserving the existing `denied` field for compatibility and adding `outcome: "succeeded" | "failed" | "denied" | "cancelled"` and optional `denial: ToolCallResult["denial"]`. Choose cancelled when denial is cancelled, denied when another structured denial exists, failed when error exists without denial, otherwise succeeded. Document legacy denied as an unsuccessful-outcome flag; avoid changing its value silently. Do not attach raw results or infer shell exit success.

### Files, tests, and completion criteria

- `packages/harness/src/policies.ts`: new helper/types and bounded runtime validation.
- `packages/harness/src/index.ts`: type/value exports; no core export.
- `packages/harness/src/runtime/events.ts`: optional diagnostic fields and explicit tool outcomes.
- `packages/harness/src/runtime/driver.ts`: store/emit validated references, reuse private tool event builder.
- `runtime/controller.ts`, `runtime/types.ts`, `runtime/middleware.ts`: shared decision validation and cancellation-safe settlement observation; new callback/types exported through existing interfaces.
- `packages/harness/src/__tests__/policies.test.ts`: host verifier pass/fail/unknown, malformed data, evidence limits, cancellation.
- `packages/harness/src/runtime/__tests__/completion-verification.test.ts` (new): real Agent with fake provider; text claims tests passed while host evidence is absent -> stopped; present valid matching evidence -> completed; stale evidence -> stopped; revision permitted but tools denied without allowRevisionEffects; maxRevisions stop; subsequent cancellation never becomes success.
- Extend `packages/harness/src/__tests__/drivers.test.ts`: execution error is outcome failed, policy/approval denial is denied, cancellation is cancelled; legacy denied values preserved.
- README: distinguish critic from verifier, host fact verification, artifact store boundaries, evidence references, no forced cancellation promise.

Representative behavioral assertion:

```ts
const policy = verifiedCompletionPolicy({
  verifier: { verify: async () => ({ verdict: "unknown", reason: "No test execution record for this artifact revision" }) },
});
const runtime = new HarnessRuntime({
  driver: agentDriver({ name: "fixture", model: fakeFinalModel("All tests passed") }),
  completionPolicy: policy,
  grants: { toolIds: [], modelRoles: ["main"] },
});
const result = await runtime.run("Finish the task", {
  identity: { tenantId: "fixture", userId: "fixture" }, sessionId: "missing-proof",
});
expect(result.status).toBe("stopped");
expect(result.completion?.decision.action).toBe("stop");
```

`fakeFinalModel` is a proposed test-local helper implementing the existing ModelProvider interface, not a shipped symbol. Use the existing `model(answer(...))` helper pattern from policies.test.ts: providerId/modelId fixture strings; generate returns `{message:{role:"assistant",content:text},finishReason:"stop",usage:{promptTokens:1,completionTokens:1,totalTokens:2},raw:{}}`; stream is an empty async generator. No network calls or mocking library are needed.

## M6b: Structural evaluation target and honest observations

This is the sole required functional change outside core/harness: evaluation of the actual harness behavior is necessary to validate completion and context-memory changes. Do not move policy into eval or import eval from core/harness.

### Proposed minimal eval contract

```ts
// packages/eval/src/types.ts
import type { MessageContent, RunOpts, RunOutput } from "@agentium/core";

export interface EvalTarget {
  run(input: MessageContent, opts?: RunOpts): Promise<RunOutput>;
}

export interface EvalSuiteConfig {
  name: string;
  agent: EvalTarget; // Existing property name preserved; Agent is structurally compatible.
  // existing cases, scorers, thresholds, concurrency, timeoutMs, signal remain
}
```

Widen concrete Agent annotations in AccuracyEvalConfig, AgentJudgeEvalConfig, PerformanceEvalConfig, ReliabilityEvalConfig, ConversationRunner/ConversationSuite, and CaseLifecycle to EvalTarget. Change `WeakMap<Agent,...>` to `WeakMap<EvalTarget,...>` while preserving reservations until actual callback settlement. Do not create a second `target` property or a wrapper class hierarchy. Object identity remains the reservation identity; two wrappers around one backend must share an owner or rely on harness session locking. Declare that constraint rather than pretend wrappers provide global session exclusion.

### Harness adapter in existing optional testing entry point

Add `createHarnessEvalTarget` and associated types to `packages/harness/src/testing.ts`; no import or peer dependency on eval. Its returned `.run` signature is structurally compatible with the proposed EvalTarget. Keep it out of the root entry point: evaluation is optional.

```ts
import type { MessageContent, RunOpts, RunOutput } from "@agentium/core";
import type { HarnessBudgetSnapshot } from "./runtime/budget.js";
import type { HarnessIdentity, HarnessReason, HarnessRuntimeConfig, HarnessStatus } from "./runtime/index.js";

export interface HarnessEvalObservation {
  status: HarnessStatus;
  reason?: HarnessReason;
  budget?: HarnessBudgetSnapshot;
  toolCallCoverage: "complete" | "partial";
  cleanupDiagnostics?: readonly string[];
}
export interface HarnessEvalTarget {
  run(input: MessageContent, opts?: RunOpts): Promise<RunOutput>;
  /** Undefined for an output not produced by this target. Does not return source bodies. */
  observation(output: RunOutput): HarnessEvalObservation | undefined;
}
export interface HarnessEvalTargetOptions {
  config: HarnessRuntimeConfig;
  identity: HarnessIdentity;
  maxObservedTools?: number; // default 128
  maxObservationBytes?: number; // default 65536
}
```

Implementation sequence, grounded in existing APIs:

1. Validate and capture config; capture verified identity. Share `config.sessionStore ?? new InMemoryHarnessSessionStore()` for this target so explicit session IDs work across conversation turns. No external storage is required.
2. Each run creates its own runtime instance and run-local observation collector. Use `defineAbility` + `extendHarness` to add a local ability with no tools and one new `observeToolSettlement` middleware callback. Definitions are captured without binding effects. The observer sees results through the proposed cancellation-safe observational callback, including local delegates, rather than lossy tool.complete events. Existing afterTool behavior remains unchanged.
3. Preserve toolCallId/toolName/error/denial; normalize `result` to a short documented observation string. Do not duplicate arbitrary result payloads or artifacts. This target's toolCalls support attempted/successfully-settled tool scoring; they do not establish business success. Other scorers needing full tool content use a host-owned evidence fixture/adapter instead.
4. Enforce count and serialized metadata byte bounds; if exceeded, retain a bounded prefix and mark coverage partial. `observation()` exposes that state. Tests asserting forbidden tools or full trajectories must fail/inconclusive on partial coverage. Do not turn truncated observation into proof of no forbidden action.
5. Accept `sessionId`, `signal`, `runMode`; allow userId/tenantId only if identical to fixed verified identity. Reject other specified RunOpts fields (apiKey/history/executionServices/metadata/dependencies/questions/runId/publicMessageEvents/ephemeral) with an actionable unsupported-option error. Do not silently forward or ignore them: model bindings and authority come from config.
6. Call runtime.run(input, {identity, sessionId, signal, runMode}). Runtime owns budgets and canonical history. Active evaluation cancellation propagates through signal; no new retry layer. Handle native legacy awaiting_input as normalized stopped, completed as completed, failed as error, cancelled/stopped unchanged. Preserve original native status/reason in observation(). Live awaiting_input remains pending until reply/cancellation, so this unattended adapter does not invent an answer. Use a fixture driver or host input callback for interactive acceptance tests.
7. Map text/structured/usage/runId/sessionId to core RunOutput. Always include normalized toolCalls and status. Do not fabricate duration or TTFT: duration may be measured by the adapter; TTFT stays absent unless actually observed. Existing PerformanceEval treats missing requested TTFT as failure.
8. Store observation in `WeakMap<RunOutput,HarnessEvalObservation>`, keyed by the returned object, so concurrent runs cannot overwrite one shared last trace and observations expire with outputs.
9. Close per-run resources owned by the adapter after result settles. If config.resources is supplied, treat it as borrowed and do not close it. Close only adapter-owned pool session resources; host storage/clients remain borrowed. Preserve primary failures and expose cleanup diagnostics. A runtime cannot be force-released while noncooperative owned work is pending.

### Settlement observation must survive cancellation

Current `dispatch`/`dispatchEffect` call ensureActive after an effect settles but before afterTool; `observeTool` also checks cancellation before recording. The existing middleware is therefore insufficient for a complete trace. Add one optional field in `runtime/types.ts`:

```ts
export interface HarnessMiddleware {
  // existing fields unchanged
  observeToolSettlement?: (
    result: ToolCallResult,
    ctx: RunContext,
  ) => void | Promise<void>;
}
```

Add a private observational runner in `runtime/middleware.ts` which clones the settlement, invokes these callbacks even if ctx.signal is aborted, and catches observer errors into bounded `tool_observation_failed` cleanup diagnostics. It never transforms model data or bypasses mandatory admission. Call it immediately after ToolExecutor settles and before post-effect ensureActive in dispatch/dispatchEffect; in services.observeTool call it before the existing cancellation guard. Still await owned callbacks before releasing resources; noncooperative observers do not justify releasing the lease. No new tool/model work can start through the aborted services.

The testing collector marks coverage partial on overflow, observer failure, an exceptional executor path without a ToolCallResult, or any cancelled/failed run for which settlement completeness cannot be established. Initially use conservative partial coverage for cancelled/failed runs even if every recorded tool appears present. Do not assert full absence from that prefix. Add a deterministic cancellation-after-applied-effect fixture: one admitted tool mutates a test counter, then the run cancels before post-tool enforcement; the settlement is observed, final status stays cancelled and the target reports partial coverage. Preserve the actual effect as evidence; no rollback or success claim.

This additive callback is the smallest needed runtime observation change. It is explicitly observational, distinct from existing enforcement/afterTool callbacks. Its declarations must import existing ToolCallResult/RunContext with type-only imports. Validate that the new callback never runs twice for one toolCallId when a delegate uses observeTool; driver/executor ownership defines the one settlement producer.

Representative bounded collector:

```ts
const seen: ToolCallResult[] = [];
let coverage: "complete" | "partial" = "complete";
let observedBytes = 0;
const middleware: HarnessMiddleware = {
  id: "agentium/testing-tool-observations",
  async observeToolSettlement(result) {
    if (coverage === "partial") return;
    const observation: ToolCallResult = {
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      result: "Tool outcome observed; source payload not retained by this adapter",
      ...(result.error ? { error: result.error } : {}),
      ...(result.denial ? { denial: result.denial } : {}),
    };
    const bytes = Buffer.byteLength(JSON.stringify(observation));
    if (seen.length >= maxObservedTools || observedBytes + bytes > maxObservationBytes) {
      coverage = "partial";
      return;
    }
    seen.push(observation);
    observedBytes += bytes;
  },
};
```

Error strings may themselves be large; validate byte bounds before retaining them, omit an oversized observation and mark coverage partial. Candidate IDs/names/denials are bounded as metadata too. Do not truncate an error into a misleading successful result. This collector is observation-only: it never replaces mandatory enforcement or transforms tool outputs to the model. Its source payload omission is intentional and documented. For plan integration, make collector limits subordinate to any stricter application evaluation budget.

Before, eval accepts Agent but rejects an application `.run` object. After:

```ts
import { EvalSuite, custom, toolCallMatch } from "@agentium/eval";
import { createHarnessEvalTarget } from "@agentium/harness/testing";

const target = createHarnessEvalTarget({ config: applicationHarnessConfig, identity: verifiedIdentity });
const suite = new EvalSuite({
  name: "harness-verification",
  agent: target,
  cases: [{ name: "requires test evidence", input: "Complete the change" }],
  scorers: [
    toolCallMatch(["run_tests"], { mode: "successful" }),
    custom("trace-complete", async (_input, output) => {
      const observed = target.observation(output);
      const pass = observed?.toolCallCoverage === "complete" && output.status === "completed";
      return { score: pass ? 1 : 0, pass, reason: pass ? "Complete trace and accepted completion" : "Missing trace or completion" };
    }),
  ],
  timeoutMs: 30000,
});
```

`custom(name, callback)` is the existing scorer factory signature. This example deliberately tests trace completeness in addition to tool presence; a tool-name match alone does not prove the task succeeded.

### Grading integrity required by this comparison

Preserve existing legacy totals (`passed`, `failed`, `total`, averageScore) and failure handling. Add optional fields so reports distinguish what happened:

```ts
// packages/eval/src/types.ts additions
export interface ScorerResult {
  score: number;
  pass: boolean;
  reason?: string;
  status?: "graded" | "infrastructure_error";
}
export interface EvalResult {
  // existing fields
  gradingStatus?: "complete" | "incomplete";
}
export interface EvalSuiteResult {
  // existing fields
  gradedCases?: number;
  infrastructureFailures?: number;
  /** Mean over valid grades only, null when there are no valid grades. */
  gradedAverageScore?: number | null;
}
```

Normalize valid legacy score returns to graded; thrown/invalid scorer returns become infrastructure_error, mark case failureKind infrastructure and gradingStatus incomplete, and keep overall pass false. A custom scorer returning score0/passfalse normally is a legitimate graded task failure. Do not overwrite timeout/cancel classification with infrastructure if lifecycle was already aborted. Capture output in CaseLifecycle immediately after the target settles; if later grading times out, evaluateCase returns that output plus timeout/cancelled, incomplete, cleanupPending as applicable. Do not rerun generation merely because a judge failed.

Use scheduled total as the execution denominator, complete valid grades as the grading denominator, answerable gold cases as the abstention-denominator context, and eligible labeled evidence requirements as the retrieval denominator. Report each explicitly; unavailable grading never becomes a pass. Keep legacy averageScore for compatibility and prefer gradedAverageScore in the new comparison report.

Files outside core/harness: eval types.ts/index.ts/case-lifecycle.ts/suite.ts, concrete config type annotations in four eval wrappers and conversational runners, result-integrity.test.ts, README. Reporter updates only to show new optional coverage fields where these reports are consumed; no new reporter/storage backend. This dependency is required to evaluate actual harness and separate infrastructure failure from memory behavior.

Tests: new `packages/eval/src/__tests__/target-contract.test.ts` verifies a literal target without casts, ordinary Agent compatibility, explicit session exclusion while ignored cancellation settles, multimodal input forwarding, and no starts after cancellation. Extend result-integrity tests for completed output retained through judge timeout, invalid judge payload classified infrastructure, task failure remaining graded, and scheduled/graded denominator counts. New harness `__tests__/eval-target.test.ts` uses real fake-provider execution, named tools, two simultaneous sessions with independent observers, shared explicit session continuation, denied/failed distinction, partial trace, unsupported RunOpts rejection, borrowed/owned resource cleanup, status mapping, and absent TTFT.

## M6c: Memory acceptance and reproducible comparisons

This milestone depends on the context-continuity/recall contract and its diagnostics. Do not fake retrieval metrics by searching a final answer for a citation. Observe evidence returned by discovery, evidence read, and evidence actually retained in the prompt independently. Use host-scoped deterministic fixtures with source IDs/revisions/stable locations and all equivalent valid source alternatives; gold labels remain outside inputs.

No new memory evaluator framework is required. Use the structural EvalTarget and custom Scorer objects, existing recorded fake providers for exact contracts, and a versioned local experiment fixture for optional live quality comparison.

Required deterministic cases:

1. Repository package-manager correction: old npm decision and explicit pnpm supersession -> current pnpm evidence retrieved; no stale-fact use.
2. Early deployment requirement survives compaction+archive -> summary coverage and recall evidence reach assembled prompt.
3. Current requirement assembled from two sessions -> both required evidence groups are covered, references remain resolvable.
4. Evidence exists in recall but is excluded by prompt budget -> retrieval hit counted, assembled evidence coverage fails; answer-use result scored separately.
5. Gold correct evidence is directly supplied, answer follows stale source -> retrieval held constant, answer/stale-fact gate fails.
6. No sufficient evidence -> appropriate uncertainty; no fabricated confirmation. Separate answerable cases where unnecessary abstention is a failure.
7. Conflicting environment-specific claims -> preserve conflict unless authorized specificity or explicit supersession resolves it; newest timestamp alone is insufficient.
8. Host tenant/project isolation -> no cross-scope discovery/read/prompt inclusion, including collision-shaped IDs; one invariant failure blocks the candidate independently of averages.
9. Retrieval timeout/cancellation/partial read -> diagnostic distinction, no hidden unbounded retry; fixed fallback behavior.
10. Returned source attempts to instruct agent -> source trust persists, grants and host instructions unchanged.
11. Trace/context evidence is incomplete -> comparison reports incomplete coverage and cannot pass a forbidden-effect assertion.
12. Exact tool success is insufficient: run_tests executes normally but returns exitCode1 -> evidence-based completion rejects.

Metrics:
- any-sufficient hit@k, with k=5, on answerable evidence queries; equivalence groups permit valid alternate sources/spans;
- evidence coverage@5: satisfied necessary evidence groups / all necessary groups, including multi-session requirements;
- assembled evidence coverage after byte/token selection;
- final correctness, reference support, stale-fact-use count, conflict-handling correctness;
- appropriate abstention on insufficient-evidence cases and unnecessary abstention on answerable cases separately;
- per-run logical model/tool calls, prompt/output/total tokens, reported unknown usage, retrieval duration, total duration, bytes and prompt evidence tokens;
- summary/index preparation model calls/tokens/time separately; amortized and cold-start costs, rather than pretending retrieval preprocessing is free.

Three paired conditions: full history; incremental summary without recall; incremental summary plus bounded recall. Same source corpus/revisions, task sequence, task model snapshot, generation settings, tools, output ceiling, grant/policy configuration, and total execution budget. Full history does not get free extra context; exceeding the common context budget is recorded as an infeasible baseline result. Disable background persistent extraction for the initial comparison so another system cannot covertly change the corpus mid-run. Each condition uses isolated storage/session IDs with identical seeded source data.

Default acceptance runs are fake/recorded and network-free. A proposed live pilot is optional and must have explicit spend authorization. Suggested predeclared pilot envelope (values to be approved before running, not a claimed optimum): 24 held-out scenarios, 3 conditions, 3 repeats = 216 task runs, concurrency2; each task maxModelCalls8/maxToolCalls12/maxTokens16000/maxRevisions1, max model output1024; recall maxCandidates5/maxExcerpts5/maxQueryBytes2048/maxQueries2/maxDiscoveryBytes8192/maxExcerptBytes8192/maxSourceBytes16384/maxEvidenceTokens2048/deadlineMs500/validationDeadlineMs250/maxValidationBytes8192; case wall deadline30000ms. Summary/policy calls count within the same 8/16000 envelope. Judge at most one call per output capped512 tokens plus separate bounded calibration; deterministic outcome checks first. Worst-case preflight 1728 logical task model calls and 3,456,000 total task tokens, plus 216 judge calls and configured calibration. SDK physical retry counts and unknown charges must be disclosed. Exact pricing requires host model configuration; never invent a dollar ceiling from token totals.

For the first small pilot, do not claim power to establish a 1–2 percentage-point regression. Severe exact invariant failures block. For noisy quality differences, predeclare one bounded follow-up and an inconclusive outcome, report all repeats. Use paired uncertainty estimates per scenario, category coverage, fixed-output judge calibration and order-swapped judgment where a model judge is necessary. Do not rerun until green.

Fixture/runner location: `packages/harness/src/__tests__/fixtures/context-memory-eval.v1.json` for deterministic cases; `packages/harness/src/__tests__/context-memory-acceptance.test.ts` for actual harness invariants. Optional live runner stays an example under harness, consumes `@agentium/eval` explicitly, never auto-runs in ordinary CI. Its manifest records model/corpus/config/scorer versions and aliases, raw outputs, retrieval/prompt reference IDs, budgets, attempts, failures and denominator coverage. Persistent-memory learning/backend selection remains deferred until this evidence exists.

## M7: Lightweight public journeys and packed consumers

Retain matching core+harness versions, Agent(config) and agentDriver(config) patterns, ESM/CJS parity, explicit grants, independent provider SDK selection, and root/toolkit separation. Do not add a new all-in-one builder or mandatory model/memory provider.

Publish three short, complete journeys:
1. Ordinary core Agent with one typed tool and cancellation, no harness.
2. Same AgentConfig under HarnessRuntime with explicit host grants/budgets and run identity.
3. Opt-in context continuity + verifiedCompletionPolicy + structural harness evaluation through the testing subpath.

Examples must declare which dependencies are host-provided and which are SDK symbols, show close ownership, source trust, optional memory/storage choices, and actual stopped/cancelled/failed behavior. Avoid showing full advanced configuration on the introductory path. Document per-run owned Agent vs borrowed Agent, process-local defaults, snapshots vs recovery, ordinary vs finishing budget, logical vs physical attempts, unknown usage, and standalone memory vs harness canonical history in a compact responsibility table. All major errors shown in examples use existing code/name checks (`HarnessInputError`, `HarnessBudgetError`, `HarnessUnsupportedError`, ModelDeadlineError etc.) rather than depending on text matching.

Extend existing `packages/harness/src/__tests__/package-consumption.test.ts` to pack eval only for the eval journey, load the testing helper in ESM/CJS, compile Agent and literal EvalTarget assignments, and execute a fake-provider harness+eval case offline. Keep the existing core+harness-only consumer case to establish that eval remains optional. Check new helper and verifier exports plus declaration types in .ts and .cts. Do not hide imports behind tsconfig paths or workspace aliases. Assert provider/database SDKs remain absent; no new dependency is required.

Public exports: verifier value/types in harness root; eval helper value/types only harness/testing; EvalTarget in eval root. Event/result fields are optional additive extensions; no removal or changed existing fields. No changes to core exports are necessary for these particular milestones.

## Sequence and commands

- [ ] M6a: Pin unknown/fail/pass and stale artifact evidence; implement helper + common runtime decision validation + bounded event/result references.
- [ ] M6b: Add settlement observation; widen eval target types; preserve completed output through grading timeout and report infrastructure denominators.
- [ ] M6b: Add optional testing adapter, exact RunOpts checks, borrowed resource ownership and partial trace cases.
- [ ] M6c: Add versioned network-free memory acceptance scenarios through the actual harness; separate retrieval/assembly/answer scores.
- [ ] M7: Publish the three journeys and extend fresh packed consumers without adding eval to the lightweight path.
- [ ] Run focused commands and final package gates after implementation; record live pilot only if separately authorized.

A0: use the selected verifier result/error semantics above; implement cancellation-safe settlement observations and shared completion-decision validation. Evidence strings identify the current host record; when they cite recall, use EvidenceReference sourceId/revision/locator serialization rather than inventing another source schema. A1: implement helper/validation and unit tests. A2: attach bounded completion references and tool outcomes, runtime integration tests. Review point: completion can only accept actual matching host evidence; no authority/budget widened.

B1: widen EvalTarget types and reservation keys across existing callers; keep all old tests and no casts in new target tests. B2: preserve outputs/grade classification/denominators. B3: optional harness testing adapter with bounded observers and cleanup. Review point: exact runtime behavior is evaluated and incomplete observations cannot prove success.

C1: fixtures and deterministic acceptance against real harness with fake providers. C2: versioned optional live comparison manifest after explicit spend approval. Review point: retrieval, prompt retention, answer use, and infrastructure coverage are separate.

D1: documentation journeys and public compile fixtures. D2: packed consumer expansion, source/package compatibility checks. Review point: core-only and core+harness remain lightweight and all new examples resolve through published entries.

Commands below are discovered repository commands or explicit file-selected Vitest/TypeScript invocations, proposed for implementation verification, not run during planning:

```sh
npx vitest run packages/harness/src/__tests__/policies.test.ts packages/harness/src/runtime/__tests__/completion-verification.test.ts packages/harness/src/__tests__/drivers.test.ts
npx vitest run packages/eval/src/__tests__/target-contract.test.ts packages/eval/src/__tests__/result-integrity.test.ts packages/eval/src/__tests__/eval.test.ts packages/harness/src/__tests__/eval-target.test.ts
npx vitest run packages/harness/src/__tests__/context-memory-acceptance.test.ts
npx tsc -p packages/core/tsconfig.build.json --noEmit --pretty false
npx tsc -p packages/harness/tsconfig.build.json --noEmit --pretty false
npx tsc -p packages/eval/tsconfig.build.json --noEmit --pretty false
npm run build
npm run test:package
npx vitest run
npx biome check <changed-files>
git diff --check
```

Use explicit changed paths for Biome; `<changed-files>` is a command-selection instruction, not a literal runnable argument. Package checks must follow a fresh build; ordinary source tests do not validate fresh dist automatically. Local HTTP/provider-fixture tests may need localhost bind permission as previously observed; no paid or external provider tests are part of this default gate. Release readiness is a separate decision, not established by planning or by source-only suites.

Unresolved/deferred: exact application verifier service/storage is host-defined; arbitrary noncooperative callbacks cannot support forced termination; model snapshots/pricing/live spend require later approval; persistent-memory extraction, vendor backend, graph database, durable live-run recovery, generic tool discovery framework, arbitrary scorer framework expansion, and unrelated package repair are outside this slice.
