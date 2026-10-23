import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  ApprovalManager,
  ChatMessage,
  ExecutionPolicy,
  ExecutionServices,
  InputReply,
  InputRequest,
  InputRequestOptions,
  MessageContent,
  ModelConfig,
  ModelProvider,
  ModelResponse,
  PublicMessage,
  RootExecutionController,
  RunMode,
  StreamChunk,
  TokenUsage,
  ToolCallResult,
  ToolDef,
  ToolDefinition,
} from "@agentium/core";
import {
  EventBus,
  evaluateExecutionPolicy,
  ModelProtocolError,
  ModelUsageError,
  RunContext,
  ToolExecutor,
  validateModelRequest,
} from "@agentium/core";
import { z } from "zod/v3";
import { continuityContextPolicy } from "../continuity-policies.js";
import {
  estimateInputTokens,
  HarnessBudgetError,
  HarnessBudgetLedger,
  type HarnessBudgetSnapshot,
  type HarnessBudgetState,
  type HarnessBudgets,
  type InputTokenEstimator,
  validateHarnessBudgets,
} from "./budget.js";
import {
  boundRecallQuery,
  createRecallUsage,
  type EvidenceReference,
  openRecallCycle,
  type RecallBudget,
  type RecallCycle,
  type RecallPolicy,
  type RecallResult,
  type RecallScope,
  type RecallStore,
  recallDiagnostic,
  recallScopeSchema,
  scopesEqual,
  validateRecallConfiguration,
} from "./recall.js";
import {
  readTaskSummaryAdditions,
  type TaskSummaryConfig,
  type TaskSummaryRecord,
  updateTaskSummary,
  validateTaskSummaryConfiguration,
  validateTaskSummaryRecord,
} from "./task-summary.js";

export type {
  HarnessBudgetSnapshot,
  HarnessBudgetState,
  HarnessBudgets,
  HarnessResourceSnapshot,
  InputTokenEstimator,
} from "./budget.js";
export { HarnessBudgetError, parseHarnessBudgetState } from "./budget.js";

import { fetchHarnessContext } from "./context.js";
import type { ContextPolicy } from "./context-policy.js";
import { projectHarnessContext } from "./context-policy.js";
import type { CompletionPolicy, ModelRoleBinding, StepController, StepOverrides } from "./controller.js";
import { validateCompletionDecision } from "./controller.js";
import {
  type HarnessEvent,
  type HarnessEventPayload,
  type HarnessReason,
  type HarnessResult,
  type HarnessStatus,
  InMemoryHarnessEventStore,
} from "./events.js";
import {
  archiveCompletedConversation,
  archiveHistory,
  type HistoryArchiveReference,
  planHistoryRetention,
  type ResidentHistoryPolicy,
  retrieveHistory,
  validateHistoryPolicy,
} from "./history.js";
import { HarnessInputError, LiveInput, validateInputRequest, validateRunInput, validateTimeout } from "./input.js";
import {
  runAfterModel,
  runAfterTool,
  runBeforeModel,
  runToolSettlementObservers,
  validateHarnessMessages,
} from "./middleware.js";
import {
  createHarnessNativeRecovery,
  HarnessNativeInputPending,
  HarnessNativeRecoveryError,
  type HarnessNativeRecoveryOptions,
  isHarnessNativeInputPending,
  nativeJSON,
  nativeModelValue,
  nativeRequestOptions,
  parseNativeModelResponse,
  parseNativeToolResult,
} from "./native-recovery.js";
import {
  createHarnessRecoveryLifecycle,
  HarnessRecoveryLifecycleError,
  type HarnessRecoveryLifecycleOptions,
  modelRecoveryBoundary,
  toolsRecoveryBoundary,
} from "./recovery-lifecycle.js";
import { bindHarness, createHarnessDefinition, resolveHarness } from "./resolve.js";
import { resolveHarnessRuntime } from "./runtime-registry.js";
import {
  type HarnessIdentity,
  HarnessResourcePool,
  type HarnessSessionStore,
  harnessSessionKey,
  InMemoryHarnessSessionStore,
  type ScopedResource,
} from "./session-bindings.js";
import type { HarnessContextEntry, HarnessDefinition } from "./types.js";

export type HarnessSendMode = "follow_up" | "steer" | "replace";
export class HarnessUnsupportedError extends Error {
  readonly code = "unsupported";
  constructor(readonly operation: string) {
    super(`Unsupported harness operation: ${operation}`);
  }
}
class SessionCommitError extends Error {
  readonly code = "session_commit_failed";
  constructor(cause: unknown) {
    super("Session commit acknowledgement failed; the write outcome is unknown", { cause });
    this.name = "SessionCommitError";
  }
}
class HarnessContinuityError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HarnessContinuityError";
  }
}
const recallDecisionSchema = z.union([
  z.object({ action: z.literal("continue") }).strict(),
  z.object({ action: z.literal("stop"), reason: z.string().trim().min(1).max(4096) }).strict(),
  z.object({ action: z.literal("await_input"), question: z.string().trim().min(1).max(32768) }).strict(),
]);
export interface HarnessGrants {
  toolIds: readonly string[];
  requiredToolIds?: readonly string[];
  modelRoles: readonly string[];
}
export interface HarnessRunRequest {
  input: MessageContent;
  identity: HarnessIdentity;
  sessionId: string;
  runId: string;
  attemptId: string;
  parentRunId?: string;
  rootRunId: string;
  signal: AbortSignal;
  deadline?: number;
  grants: HarnessGrants;
  runMode: RunMode;
}
export interface HarnessDriverOutput {
  status?: HarnessStatus;
  text: string;
  structured?: unknown;
  reason?: HarnessReason;
  partial?: boolean;
  providerFinishReason?: string;
  usage?: TokenUsage;
  history?: readonly ChatMessage[];
  artifacts?: readonly { id: string; mimeType?: string }[];
}
export interface ExecutionDriver {
  id: string;
  version: number;
  capabilities: {
    controls: readonly HarnessSendMode[];
    durable: boolean;
    policyCoverage: "local" | "remote" | "none";
    /** True only when each model/tool operation uses provided execution services. */
    controlledExecution: boolean;
  };
  start: (request: HarnessRunRequest, services: HarnessExecutionServices) => Promise<HarnessDriverOutput>;
}
export interface HarnessExecutionServices extends ExecutionServices {
  /** Observe every settled effect before cancellation-sensitive result processing. */
  observeToolSettlements(results: readonly ToolCallResult[], context?: RunContext): Promise<void>;
  readonly budget: HarnessBudgetSnapshot;
  readonly archivedHistory: readonly HistoryArchiveReference[];
  retrieveHistory(referenceId: string): Promise<ChatMessage[]>;
  /** Explicit tool-free finishing work; grants and terminal completion policy still apply. */
  finishModel(
    role: string,
    messages: readonly ChatMessage[],
    options?: Pick<ModelConfig, "maxTokens" | "temperature">,
  ): Promise<ModelResponse>;
  readonly definitionId?: string;
  /** Agent-specific declarative options interpreted only by the configured Agent driver. */
  readonly agentConfiguration?: {
    defaults: import("./types.js").HarnessDefaults;
    limits: NonNullable<import("./types.js").HarnessManifest["limits"]>;
    projectRoot: string;
  };
  /** Independent, tool-free policy call using an explicitly granted host role and shared budgets.
   * Skips task controllers, context projection and middleware to avoid policy recursion.
   */
  controlModel(
    role: string,
    messages: readonly ChatMessage[],
    options?: Pick<ModelConfig, "maxTokens" | "temperature">,
  ): Promise<ModelResponse>;
  append(messages: readonly ChatMessage[]): void;
  emit(payload: Exclude<HarnessEventPayload, { type: "run.terminal" | "run.started" }>): void;
  requestInput(request: InputRequestOptions): Promise<InputReply>;
  takeInput(context?: RunContext): { id: string; input: MessageContent; mode: HarnessSendMode } | undefined;
  resource<T>(id: string, scope: "host" | "session" | "run", initialize: () => Promise<ScopedResource<T>>): Promise<T>;
  putArtifact(value: unknown): string;
  getArtifact(id: string): unknown;
}
export type HarnessRunState = "running" | "awaiting_input" | "cancelling" | "finished";
export interface RunHandle {
  readonly budget: HarnessBudgetSnapshot;
  readonly runId: string;
  /** Live state; waiting never resolves result(). */
  readonly state: HarnessRunState;
  readonly pendingInput: InputRequest | undefined;
  reply(requestId: string, input: MessageContent): Promise<void>;
  events(options?: { after?: number }): AsyncGenerator<HarnessEvent>;
  result(): Promise<HarnessResult>;
  cancel(reason?: string): void;
  send(input: MessageContent, options: { mode: HarnessSendMode }): Promise<void>;
}
export interface HarnessRuntimeConfig {
  /** Optional observer bus for the runtime and its direct model/controller calls.
   * Keep Agent instrumentation on its own bus to avoid counting the same call twice. */
  telemetry?: EventBus;
  driver?: ExecutionDriver;
  definition?: HarnessDefinition;
  projectRoot?: string;
  requirements?: readonly string[];
  tools?: readonly ToolDef[];
  models?: Readonly<Record<string, ModelRoleBinding>>;
  grants: HarnessGrants;
  budgets?: HarnessBudgets;
  /** Estimate projected input including tools and opaque replay; hard bounds require a conservative host estimator. */
  estimateInputTokens?: InputTokenEstimator;
  executionPolicy?: ExecutionPolicy;
  approvalManager?: ApprovalManager;
  controller?: StepController;
  contextPolicy?: ContextPolicy;
  completionPolicy?: CompletionPolicy;
  /** Explicit opt-in to new tool effects in completion revisions. */
  allowRevisionEffects?: boolean;
  sessionStore?: HarnessSessionStore;
  residentHistory?: ResidentHistoryPolicy;
  /** Host-owned bounded source evidence, off by default. */
  recall?: { store: RecallStore; budget: RecallBudget; policy: RecallPolicy; maxClarifications?: number };
  /** Incremental archival summaries, off by default; requires recall and residentHistory. */
  taskSummary?: TaskSummaryConfig;
  resources?: HarnessResourcePool;
  eventCapacity?: number;
  /** Active wall time, excluding a pending user question. */
  activeTimeoutMs?: number;
  /** Maximum wait per question. Omit to wait until reply, cancellation or deadline. */
  inputTimeoutMs?: number;
}
export interface HarnessStartOptions {
  /** Borrowed root admission boundary, shared by nested controlled work. */
  rootExecution?: RootExecutionController;
  /** Trusted recovery adapter only. Restored limits must exactly match host budgets. */
  recovery?: {
    budgetState?: HarnessBudgetState;
    persistBudget(state: HarnessBudgetState): Promise<void>;
    invokeTool?: ExecutionServices["invokeTool"];
    /** Opt-in application-state causal boundaries only. Does not make this
     * driver durable or replay model calls, context, input or streaming. */
    lifecycle?: HarnessRecoveryLifecycleOptions;
    /** SDK-owned recorded native decisions; the host supplies the authoritative
     * fenced task journal and recoverable effect connectors. */
    native?: HarnessNativeRecoveryOptions;
  };
  identity: HarnessIdentity;
  sessionId: string;
  parentRunId?: string;
  rootRunId?: string;
  signal?: AbortSignal;
  deadline?: number;
  grants?: HarnessGrants;
  runMode?: RunMode;
  recallScope?: { projectId?: string; repositoryId?: string };
  /** Host attests that a meaningful untagged legacy snapshot belongs to the requested exact scope. */
  attestLegacyMemoryScope?: boolean;
}
const zero = (): TokenUsage => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
function narrow(base: readonly string[], selected: readonly string[], label: string): readonly string[] {
  if (new Set(selected).size !== selected.length || selected.some((value) => !base.includes(value)))
    throw new Error(`Cannot widen ${label} grants`);
  return [...selected];
}
/** Local lifecycle owner. Custom driver code is trusted; services enforce all intercepted effects. */
export class HarnessRuntime {
  readonly sessions: HarnessSessionStore;
  readonly resources: HarnessResourcePool;
  private config: HarnessRuntimeConfig & { driver: ExecutionDriver };
  private artifacts = new Map<string, { owner: string; value: unknown }>();
  getArtifact(identity: HarnessIdentity, sessionId: string, id: string): unknown {
    const entry = this.artifacts.get(id);
    if (!entry || entry.owner !== harnessSessionKey(identity, sessionId)) return undefined;
    return structuredClone(entry.value);
  }
  constructor(config: HarnessRuntimeConfig) {
    const definition = config.definition ? createHarnessDefinition(config.definition) : undefined;
    const bindings = definition ? resolveHarnessRuntime(definition) : {};
    const driver = config.driver ?? bindings.driver;
    if (!driver) throw new Error("A trusted execution driver is required");
    config = { ...bindings, ...config, driver, definition };
    if (bindings.modelRoles) {
      config.models = { ...config.models };
      for (const [role, name] of Object.entries(bindings.modelRoles)) {
        const binding: ModelRoleBinding | undefined = config.models[name];
        if (!binding) throw new Error(`runtime.modelRoles.${role}: missing host model binding ${name}`);
        config.models = { ...config.models, [role]: binding };
      }
    }
    if (!driver.id || !Number.isInteger(driver.version) || driver.version < 1)
      throw new Error("Invalid execution driver identity");
    if (driver.capabilities.durable) throw new HarnessUnsupportedError("durable recovery without a recovery adapter");
    if (driver.capabilities.controls.includes("replace"))
      throw new HarnessUnsupportedError("interrupt-and-replace without a driver checkpoint adapter");
    if (driver.capabilities.policyCoverage !== "local" || !driver.capabilities.controlledExecution)
      throw new HarnessUnsupportedError("mandatory local execution coverage");
    validateHarnessBudgets(config.budgets ?? {});
    if (config.completionPolicy && !config.completionPolicy.id.trim())
      throw new Error("Completion policy id must be nonempty");
    if (config.residentHistory) validateHistoryPolicy(config.residentHistory);
    if (config.recall) validateRecallConfiguration(config.recall);
    if (config.taskSummary)
      validateTaskSummaryConfiguration(
        config.taskSummary,
        Boolean(config.residentHistory),
        config.recall?.store.capabilities.canonicalArchiveReads === true,
      );
    this.config = {
      ...config,
      projectRoot: resolve(config.projectRoot ?? process.cwd()),
      requirements: config.requirements && Object.freeze([...config.requirements]),
      budgets: { ...config.budgets },
      residentHistory: config.residentHistory && { ...config.residentHistory },
      recall:
        config.recall &&
        Object.freeze({
          store: config.recall.store,
          budget: Object.freeze({ ...config.recall.budget }),
          maxClarifications: config.recall.maxClarifications ?? 1,
          policy: Object.freeze({
            id: config.recall.policy.id,
            query: config.recall.policy.query.bind(config.recall.policy),
            decide: config.recall.policy.decide.bind(config.recall.policy),
          }),
        }),
      taskSummary:
        config.taskSummary &&
        Object.freeze({
          ...config.taskSummary,
          policy: Object.freeze({
            id: config.taskSummary.policy.id,
            version: config.taskSummary.policy.version,
            update: config.taskSummary.policy.update.bind(config.taskSummary.policy),
          }),
        }),
      models: Object.fromEntries(
        Object.entries(config.models ?? {}).map(([role, binding]) => [
          role,
          Object.freeze({ ...binding, options: Object.freeze([...(binding.options ?? [])]) }),
        ]),
      ),
      contextPolicy:
        config.contextPolicy &&
        Object.freeze({
          id: config.contextPolicy.id,
          grouping: config.contextPolicy.grouping,
          project: config.contextPolicy.project.bind(config.contextPolicy),
        }),
      completionPolicy:
        config.completionPolicy &&
        Object.freeze({
          id: config.completionPolicy.id,
          evaluate: config.completionPolicy.evaluate.bind(config.completionPolicy),
        }),
      controller:
        config.controller &&
        Object.freeze({
          id: config.controller.id,
          prepareRun: config.controller.prepareRun?.bind(config.controller),
          prepareStep: config.controller.prepareStep?.bind(config.controller),
        }),
      driver: Object.freeze({
        id: driver.id,
        version: driver.version,
        start: driver.start.bind(driver),
        capabilities: Object.freeze({
          ...driver.capabilities,
          controls: Object.freeze([...driver.capabilities.controls]),
        }),
      }),
      tools: [...(config.tools ?? [])],
      grants: {
        toolIds: [...config.grants.toolIds],
        modelRoles: [...config.grants.modelRoles],
        requiredToolIds: [...(config.grants.requiredToolIds ?? [])],
      },
    };
    this.sessions = config.sessionStore ?? new InMemoryHarnessSessionStore();
    this.resources = config.resources ?? new HarnessResourcePool();
  }
  /** Read archived canonical records by a scoped reference; never injects them into model context. */
  async retrieveHistory(identity: HarnessIdentity, sessionId: string, referenceId: string): Promise<ChatMessage[]> {
    const archive = this.config.residentHistory?.archive;
    if (!archive) throw new Error("No history archive configured");
    const lease = await this.sessions.acquire(identity, sessionId);
    let primary: unknown;
    try {
      const reference = lease.read().archivedHistory?.find((item) => item.id === referenceId);
      if (!reference) throw new Error("Unknown scoped history reference");
      return await retrieveHistory(archive, { identity, sessionId }, reference);
    } catch (error) {
      primary = error;
      throw error;
    } finally {
      try {
        await lease.release();
      } catch (error) {
        // biome-ignore lint/correctness/noUnsafeFinally: A cleanup failure is surfaced only when no primary failure exists.
        if (primary === undefined) throw error;
        if (primary instanceof Error) {
          try {
            Object.defineProperty(primary, "cleanupDiagnostics", {
              value: ["session_release_failed"],
              configurable: true,
            });
          } catch {
            /* Preserve the original host error even when frozen. */
          }
        }
      }
    }
  }
  run(input: MessageContent, options: HarnessStartOptions): Promise<HarnessResult> {
    return this.start(input, options).result();
  }
  stream(input: MessageContent, options: HarnessStartOptions): AsyncGenerator<HarnessEvent> {
    return this.start(input, options).events();
  }
  start(input: MessageContent, options: HarnessStartOptions): RunHandle {
    if (!options.identity?.tenantId || !options.identity.userId || !options.sessionId)
      throw new Error("Verified tenant, actor and session identity are required");
    const config = this.config;
    const hostScope = config.recall
      ? z
          .object({ projectId: z.string().min(1).optional(), repositoryId: z.string().min(1).optional() })
          .strict()
          .parse(options.recallScope ?? {})
      : undefined;
    const recallScope = config.recall
      ? recallScopeSchema.parse({ identity: options.identity, sessionId: options.sessionId, ...hostScope })
      : undefined;
    const attestLegacyMemoryScope = options.attestLegacyMemoryScope === true;
    const budget = new HarnessBudgetLedger(config.budgets, options.recovery?.budgetState);
    const rootExecution = options.rootExecution;
    let budgetWrites = Promise.resolve();
    const persistBudget = () => {
      if (!options.recovery) return Promise.resolve();
      const write = budgetWrites.then(() =>
        options.recovery!.persistBudget(options.recovery!.native ? budget.exportStartedState() : budget.exportState()),
      );
      budgetWrites = write.catch(() => {});
      return write;
    };
    if (options.runMode !== undefined && options.runMode !== "execute" && options.runMode !== "plan")
      throw new Error("Invalid run mode");
    const grants = options.grants
      ? {
          toolIds: narrow(config.grants.toolIds, options.grants.toolIds, "tool"),
          modelRoles: narrow(config.grants.modelRoles, options.grants.modelRoles, "model"),
          requiredToolIds: [
            ...new Set([...(config.grants.requiredToolIds ?? []), ...(options.grants.requiredToolIds ?? [])]),
          ],
        }
      : config.grants;
    if (grants.requiredToolIds?.some((id) => !grants.toolIds.includes(id)))
      throw new Error("Required tool omitted by grants");
    if (options.deadline !== undefined && !Number.isFinite(options.deadline))
      throw new Error("Deadline must be finite");
    validateTimeout(config.activeTimeoutMs);
    validateTimeout(config.inputTimeoutMs);
    const controller = new AbortController();
    if (options.recovery?.native && options.recovery.lifecycle)
      throw new HarnessUnsupportedError("simultaneous native and projection-only recovery");
    const runId = options.recovery?.native
      ? z.string().min(1).max(512).parse(options.recovery.native.taskId)
      : randomUUID();
    let nativePending: InputRequest | undefined;
    const request: HarnessRunRequest = Object.freeze({
      input: validateRunInput(input),
      identity: Object.freeze({ ...options.identity }),
      sessionId: options.sessionId,
      runId,
      attemptId: randomUUID(),
      parentRunId: options.parentRunId,
      rootRunId: options.rootRunId ?? runId,
      signal: controller.signal,
      deadline: options.deadline,
      grants: Object.freeze({
        toolIds: Object.freeze([...grants.toolIds]),
        modelRoles: Object.freeze([...grants.modelRoles]),
        requiredToolIds: Object.freeze([...(grants.requiredToolIds ?? [])]),
      }),
      runMode: options.runMode ?? "execute",
    });
    const lifecycle = options.recovery?.lifecycle
      ? createHarnessRecoveryLifecycle(options.recovery.lifecycle, {
          identity: { tenantId: request.identity.tenantId, userId: request.identity.userId },
          sessionId: request.sessionId,
          input: request.input,
          driver: { id: config.driver.id, version: config.driver.version },
          budgets: Object.fromEntries(Object.entries(config.budgets ?? {}).filter(([, value]) => value !== undefined)),
          grants: {
            toolIds: [...request.grants.toolIds],
            modelRoles: [...request.grants.modelRoles],
            requiredToolIds: [...(request.grants.requiredToolIds ?? [])],
          },
          runMode: request.runMode ?? "execute",
          deadline: request.deadline ?? null,
        })
      : undefined;
    const events = new InMemoryHarnessEventStore(
      {
        runId,
        sessionId: request.sessionId,
        attemptId: request.attemptId,
        parentRunId: request.parentRunId,
        rootRunId: request.rootRunId,
      },
      config.eventCapacity,
    );
    const startedAt = Date.now();
    config.telemetry?.emit("run.start", {
      runId,
      agentName: config.driver.id,
      input: "",
      sessionId: request.sessionId,
      tenantId: request.identity.tenantId,
      userId: request.identity.userId,
      parentRunId: request.parentRunId,
      rootRunId: request.rootRunId,
      attemptId: request.attemptId,
    });
    const observeControl = async <T>(operation: string, work: () => Promise<T>): Promise<T> => {
      const controllerCallId = randomUUID();
      const identity = { runId, controllerCallId, operation };
      config.telemetry?.emit("controller.start", identity);
      try {
        const result = await work();
        controller.signal.throwIfAborted();
        const decision = result as (StepOverrides & { action?: string }) | undefined;
        config.telemetry?.emit("controller.result", {
          ...identity,
          decision: decision?.stop ? "stop" : (decision?.action ?? "continue"),
          modelRole: decision?.modelRole,
          activeToolCount: decision?.activeToolIds?.length,
        });
        return result;
      } catch (error) {
        config.telemetry?.emit("controller.error", {
          ...identity,
          status: controller.signal.aborted ? "cancelled" : "error",
        });
        throw error;
      }
    };
    const observeModel = (provider: ModelProvider) => {
      const identity = { runId, modelCallId: randomUUID(), providerId: provider.providerId, modelId: provider.modelId };
      config.telemetry?.emit("model.start", identity);
      return (complete: boolean, amount?: TokenUsage) => {
        if (complete) config.telemetry?.emit("model.result", { ...identity, usage: amount, status: "success" });
        else
          config.telemetry?.emit("model.error", {
            ...identity,
            status: controller.signal.aborted ? "cancelled" : "error",
            ...(amount ? { usage: amount } : {}),
          });
      };
    };
    const generateObserved = async (
      provider: ModelProvider,
      messages: ChatMessage[],
      supplied: ModelConfig,
      onStart: () => void,
    ) => {
      const end = observeModel(provider);
      try {
        liveInput.assertNotWaiting();
        supplied.signal?.throwIfAborted();
        const execute = async () => {
          onStart();
          await persistBudget();
          return provider.generate(messages, supplied);
        };
        const response = rootExecution
          ? await rootExecution.run("model", `${runId}/${randomUUID()}`, execute, supplied.signal)
          : await execute();
        end(!controller.signal.aborted, response.usage);
        return response;
      } catch (error) {
        end(false);
        throw error;
      }
    };
    let terminal = false;
    let acceptingInput = true;
    let acceptingSteering = true;
    let cancellationCode = "cancelled";
    const inbox: Array<{ id: string; input: MessageContent; mode: HarnessSendMode }> = [];
    const cancel = (reason = "Run cancelled", cause?: unknown) => {
      if (!terminal && !controller.signal.aborted) {
        events.append({ type: "control", operation: "cancel", reason });
        controller.abort(cause ?? new Error(reason));
      }
    };
    const liveInput = new LiveInput(
      runId,
      controller.signal,
      config,
      (event) => events.append(event),
      (code) => {
        cancellationCode = code;
        cancel(code === "input_timeout" ? "User input timeout exceeded" : "Active execution timeout exceeded");
      },
    );
    const onAbort = () => cancel("Caller cancelled the run", options.signal?.reason);
    const callerSignal = options.signal;
    callerSignal?.addEventListener("abort", onAbort, { once: true });
    if (callerSignal?.aborted) onAbort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleDeadline = () => {
      if (request.deadline === undefined || controller.signal.aborted) return;
      const remaining = request.deadline - Date.now();
      if (remaining <= 0) {
        cancellationCode = "deadline_exceeded";
        cancel("Run deadline exceeded");
      } else timer = setTimeout(scheduleDeadline, Math.min(remaining, 2_147_483_647));
    };
    scheduleDeadline();
    const result = Promise.resolve().then(async (): Promise<HarnessResult> => {
      let lease: Awaited<ReturnType<HarnessSessionStore["acquire"]>> | undefined;
      let bound: Awaited<ReturnType<typeof bindHarness>> | undefined;
      const releases: Array<() => Promise<void>> = [];
      const usage = zero();
      let stepIndex = 0;
      const cleanupDiagnostics: string[] = [];
      let revision = 0;
      let completion: HarnessResult["completion"];
      let currentRole = "main";
      let prepareDefaults: StepOverrides = {};
      let final: HarnessDriverOutput = { text: "", status: "failed" };
      let canonical: ChatMessage[] = [];
      let conversations: Record<string, ChatMessage[]> = {};
      let archivedHistory: HistoryArchiveReference[] = [];
      const taskSummaries: Record<string, TaskSummaryRecord> = {};
      const pendingSummaryConversations = new Set<string>();
      let memoryScope: RecallScope | undefined;
      let preservedContinuity: { memoryScope?: RecallScope; taskSummaries?: Record<string, TaskSummaryRecord> } = {};
      let persistenceAllowed = true;
      let historyQueue: Promise<unknown> = Promise.resolve();
      const historyProviders = new Map<string, ModelProvider>();
      let state: Record<string, unknown> = {};
      let replayable = true;
      let committed = false;
      let commitAttempted = false;
      let acceptingOperations = true;
      let native: ReturnType<typeof createHarnessNativeRecovery> | undefined;
      const owned = new Set<Promise<unknown>>();
      const streams = new Set<AsyncGenerator<StreamChunk>>();
      const publicMessageIds = new Map<string, string>();
      const track = <T>(operation: Promise<T>): Promise<T> => {
        owned.add(operation);
        operation.then(
          () => owned.delete(operation),
          () => owned.delete(operation),
        );
        return operation;
      };
      const ensureActive = () => {
        if (request.deadline !== undefined && Date.now() >= request.deadline) {
          cancellationCode = "deadline_exceeded";
          cancel("Run deadline exceeded");
        }
        controller.signal.throwIfAborted();
        if (!acceptingOperations) throw new Error("Run has finished accepting operations");
      };
      const activeTools = new Map<string, readonly string[]>();
      const validateSummariesAtCommit = async () => {
        if (!config.recall || !config.taskSummary || !recallScope) return;
        for (const [conversationId, raw] of Object.entries(taskSummaries).slice(
          0,
          config.taskSummary.maxSummaryRecords,
        )) {
          let cycle: RecallCycle | undefined;
          try {
            const record = validateTaskSummaryRecord(raw, {
              scope: recallScope,
              policy: config.taskSummary.policy,
              archives: archivedHistory,
              config: config.taskSummary,
              conversationId,
            });
            if (!record) throw new Error("Invalid summary");
            // A new open attests current scope; never reuse a closed prepare session.
            cycle = await openRecallCycle({
              store: config.recall.store,
              scope: record.scope,
              budget: { ...config.recall.budget, deadlineMs: config.recall.budget.validationDeadlineMs },
              signal: controller.signal,
              runDeadline: request.deadline,
            });
            const result = await cycle.validate(
              record.evidence.map((item) => item.reference),
              record.sourceViewRevision,
            );
            if (!result.valid) throw new Error("Invalid summary");
          } catch {
            delete taskSummaries[conversationId];
            if (!cleanupDiagnostics.includes("summary_invalidated_at_commit"))
              cleanupDiagnostics.push("summary_invalidated_at_commit");
          } finally {
            await cycle?.close();
          }
        }
      };
      const continuitySnapshot = () =>
        config.recall && memoryScope
          ? { memoryScope, ...(config.taskSummary ? { taskSummaries } : {}) }
          : preservedContinuity;
      try {
        ensureActive();
        lease = await this.sessions.acquire(request.identity, request.sessionId);
        ensureActive();
        const snapshot = lease.read();
        canonical = snapshot.history;
        conversations = snapshot.conversations ?? {};
        archivedHistory = snapshot.archivedHistory ?? [];
        memoryScope = snapshot.memoryScope;
        preservedContinuity = {
          ...(snapshot.memoryScope ? { memoryScope: snapshot.memoryScope } : {}),
          ...(snapshot.taskSummaries ? { taskSummaries: snapshot.taskSummaries } : {}),
        };
        if (recallScope) {
          if (
            memoryScope &&
            (!recallScopeSchema.safeParse(memoryScope).success || !scopesEqual(memoryScope, recallScope))
          ) {
            persistenceAllowed = false;
            throw new HarnessContinuityError(
              "memory_scope_mismatch",
              "Session continuity scope differs from the requested host scope",
            );
          }
          if (
            !memoryScope &&
            (canonical.length ||
              archivedHistory.length ||
              Object.keys(conversations).length ||
              Object.keys(snapshot.state).length) &&
            !attestLegacyMemoryScope
          ) {
            persistenceAllowed = false;
            throw new HarnessContinuityError(
              "memory_scope_attestation_required",
              "Host must attest an untagged session before enabling continuity",
            );
          }
          memoryScope = structuredClone(recallScope);
          if (config.taskSummary) {
            if (Object.keys(snapshot.taskSummaries ?? {}).length > config.taskSummary.maxSummaryRecords)
              cleanupDiagnostics.push("summary_record_limit");
            for (const [conversationId, raw] of Object.entries(snapshot.taskSummaries ?? {}).slice(
              0,
              config.taskSummary.maxSummaryRecords,
            )) {
              const record = validateTaskSummaryRecord(raw, {
                scope: recallScope,
                policy: config.taskSummary.policy,
                archives: archivedHistory,
                config: config.taskSummary,
                conversationId,
              });
              if (record) taskSummaries[conversationId] = record;
              else if (!cleanupDiagnostics.includes("summary_invalidated_on_reuse"))
                cleanupDiagnostics.push("summary_invalidated_on_reuse");
            }
          }
        }
        state = snapshot.state;
        replayable = snapshot.replayable;
        if (options.recovery?.native) {
          const optionsNative = options.recovery.native;
          native = createHarnessNativeRecovery(
            optionsNative,
            nativeJSON({
              identity: request.identity,
              sessionId: request.sessionId,
              input: request.input,
              runMode: request.runMode,
              driver: { id: config.driver.id, version: config.driver.version },
              grants: request.grants,
              budgets: config.budgets ?? {},
              deadline: request.deadline ?? null,
            }),
            {
              capture: () =>
                nativeJSON({
                  canonical,
                  state,
                  usage,
                  stepIndex,
                  currentRole,
                  revision,
                  prepareDefaults,
                  replayable,
                  activeTools: [...activeTools],
                  conversations,
                  archivedHistory,
                  taskSummaries,
                  memoryScope: memoryScope ?? null,
                  pendingSummaryConversations: [...pendingSummaryConversations],
                }),
              restore: (value) => {
                const saved = z
                  .object({
                    canonical: z.array(
                      z.custom<ChatMessage>(
                        (item) => typeof item === "object" && item !== null && "role" in item && "content" in item,
                      ),
                    ),
                    state: z.custom<Record<string, unknown>>(
                      (item) => typeof item === "object" && item !== null && !Array.isArray(item),
                    ),
                    usage: z
                      .object({ promptTokens: z.number(), completionTokens: z.number(), totalTokens: z.number() })
                      .passthrough(),
                    stepIndex: z.number().int(),
                    currentRole: z.string(),
                    revision: z.number().int(),
                    prepareDefaults: z.custom<StepOverrides>((item) => typeof item === "object" && item !== null),
                    replayable: z.boolean(),
                    activeTools: z.array(z.tuple([z.string(), z.array(z.string())])),
                    conversations: z.record(
                      z.array(
                        z.custom<ChatMessage>(
                          (item) => typeof item === "object" && item !== null && "role" in item && "content" in item,
                        ),
                      ),
                    ),
                    archivedHistory: z.array(
                      z.object({
                        id: z.string(),
                        conversationId: z.string(),
                        messageCount: z.number().int().nonnegative(),
                        digest: z.string(),
                      }),
                    ),
                    taskSummaries: z.record(z.unknown()),
                    memoryScope: recallScopeSchema.nullable(),
                    pendingSummaryConversations: z.array(z.string()),
                  })
                  .parse(value);
                canonical = saved.canonical;
                for (const key of Object.keys(state)) delete state[key];
                Object.defineProperties(state, Object.getOwnPropertyDescriptors(saved.state));
                Object.assign(usage, saved.usage);
                stepIndex = saved.stepIndex;
                currentRole = saved.currentRole;
                revision = saved.revision;
                prepareDefaults = saved.prepareDefaults;
                replayable = saved.replayable;
                activeTools.clear();
                for (const [id, names] of saved.activeTools) activeTools.set(id, names);
                conversations = saved.conversations;
                archivedHistory = saved.archivedHistory;
                memoryScope = saved.memoryScope ?? undefined;
                for (const key of Object.keys(taskSummaries)) delete taskSummaries[key];
                for (const [id, raw] of Object.entries(saved.taskSummaries)) {
                  const record =
                    config.taskSummary && recallScope
                      ? validateTaskSummaryRecord(raw, {
                          scope: recallScope,
                          policy: config.taskSummary.policy,
                          archives: archivedHistory,
                          config: config.taskSummary,
                          conversationId: id,
                        })
                      : undefined;
                  if (!record) throw new Error("Invalid retained native task summary");
                  taskSummaries[id] = record;
                }
                pendingSummaryConversations.clear();
                for (const id of saved.pendingSummaryConversations) pendingSummaryConversations.add(id);
              },
            },
          );
          await native.initialize();
          ensureActive();
        }
        await lifecycle?.initialize();
        ensureActive();
        const retain = (
          provider?: ModelProvider,
          callCtx?: RunContext,
          messages?: readonly ChatMessage[],
        ): Promise<ChatMessage[]> => {
          const operation = historyQueue.then(async () => {
            const policy = config.residentHistory;
            if (!policy) return structuredClone([...(messages ?? canonical)]);
            const executionId = callCtx?.runId ?? request.runId;
            if (provider) historyProviders.set(executionId, provider);
            provider ??= historyProviders.get(executionId) ?? config.models?.main?.provider;
            const source = executionId === request.runId ? canonical : (conversations[executionId] ?? []);
            const projected = messages ? planHistoryRetention(messages, policy, provider).resident : undefined;
            const length = source.length;
            const retained = await archiveHistory(
              source.slice(0, length),
              policy,
              { identity: request.identity, sessionId: request.sessionId },
              executionId === request.runId ? "main" : executionId,
              provider,
            );
            // The archive acknowledged before any local record is removed.
            source.splice(0, length, ...retained.resident);
            if (retained.reference) archivedHistory.push(retained.reference);
            return structuredClone(projected ?? source);
          });
          historyQueue = operation.catch(() => {});
          return operation;
        };
        let policy!: ExecutionPolicy;
        let services!: HarnessExecutionServices;
        const ctx = new RunContext({
          executionPolicy: {
            decide: (call, callCtx) => policy.decide(call, callCtx),
            resolveEffect: (call, callCtx) => policy.resolveEffect?.(call, callCtx) ?? "unknown",
          },
          sessionId: request.sessionId,
          userId: request.identity.userId,
          tenantId: request.identity.tenantId,
          runId,
          signal: controller.signal,
          rootExecution,
          runMode: request.runMode,
          eventBus: new EventBus(),
          sessionState: state,
          metadata: { parentRunId: request.parentRunId, rootRunId: request.rootRunId },
        });
        Object.defineProperty(ctx, "executionServices", { get: () => services, configurable: false });
        const assertLifecycleContext = (context: RunContext) => {
          if ((lifecycle || native) && context.runId !== request.runId)
            throw new HarnessUnsupportedError("nested native recovery lifecycle");
        };
        policy = {
          decide: async (call, callCtx) => {
            assertLifecycleContext(callCtx);
            ensureActive();
            if (
              !request.grants.toolIds.includes(call.toolName) ||
              (activeTools.has(callCtx.runId) && !activeTools.get(callCtx.runId)!.includes(call.toolName))
            )
              return { action: "deny", reason: "Tool is outside the effective grants" };
            if (revision > 0 && !config.allowRevisionEffects)
              return { action: "deny", reason: "Completion revisions cannot execute effects without host opt-in" };
            const logicalId = options.recovery
              ? `${callCtx.metadata.executionGraphNodeId ?? callCtx.metadata.workflowExecutionPath ?? callCtx.runId}/${call.toolCallId}`
              : undefined;
            if (!budget.admitTool(logicalId)) return { action: "deny", reason: "Aggregate tool budget exhausted" };
            return evaluateExecutionPolicy(config.executionPolicy, call, callCtx);
          },
          resolveEffect: config.executionPolicy?.resolveEffect,
        };
        const resolved = config.definition
          ? resolveHarness(config.definition, {
              projectRoot: config.projectRoot ?? process.cwd(),
              requirements: config.requirements,
            })
          : undefined;
        if (resolved) bound = await bindHarness(resolved, ctx);
        ensureActive();
        const tools = [...(config.tools ?? []), ...(bound?.tools ?? [])];
        if (new Set(tools.map((tool) => tool.name)).size !== tools.length)
          throw new Error("Duplicate runtime tool bindings");
        // Use the same policy identity as the root context: its lazy wrapper
        // already delegates to the budget/grant policy. A distinct identity
        // makes ToolExecutor compose and admit that same operation twice.
        const executor = new ToolExecutor(tools, {
          ...(native ? { concurrency: 1 } : {}),
          approvalManager: config.approvalManager,
          executionPolicy: ctx.executionPolicy,
        });
        const sources = bound
          ? await fetchHarnessContext(
              bound.contextSources,
              typeof input === "string" ? input : JSON.stringify(input),
              ctx,
            )
          : { messages: [] };
        const entries: HarnessContextEntry[] = sources.messages.map((message) => {
          const source = JSON.parse(String(message.content));
          return {
            id: source.entryId,
            text: source.text,
            trust: "source",
            source: source.source,
            byteLength: Buffer.byteLength(source.text),
          };
        });
        const middleware = bound?.middleware ?? [];
        const observedSettlements = new WeakSet<ToolCallResult>();
        const lifecycleSettlements = new WeakMap<ToolCallResult, Promise<void>>();
        const settleApplicationTools = (results: readonly ToolCallResult[]) => {
          if (!lifecycle || !results.length) return Promise.resolve();
          const previous = results.map((result) => lifecycleSettlements.get(result));
          const first = previous[0];
          if (first && previous.every((entry) => entry === first)) return first;
          if (previous.some(Boolean))
            return Promise.reject(new HarnessRecoveryLifecycleError("Cannot mix retained and new tool settlements"));
          const pending = lifecycle.settle(toolsRecoveryBoundary(results));
          for (const result of results) lifecycleSettlements.set(result, pending);
          return pending;
        };
        const observeSettlement = async (result: ToolCallResult, context: RunContext) => {
          if (observedSettlements.has(result)) return;
          observedSettlements.add(result);
          if (
            !(await runToolSettlementObservers(middleware, result, context)) &&
            !cleanupDiagnostics.includes("tool_observation_failed")
          )
            cleanupDiagnostics.push("tool_observation_failed");
          const payload: HarnessEventPayload = {
            type: "tool.complete",
            toolName: result.toolName,
            toolCallId: result.toolCallId,
            denied: Boolean(result.error),
            outcome:
              result.denial === "cancelled"
                ? "cancelled"
                : result.denial
                  ? "denied"
                  : result.error
                    ? "failed"
                    : "succeeded",
            ...(result.denial ? { denial: result.denial } : {}),
          };
          if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 65536) {
            if (!cleanupDiagnostics.includes("tool_observation_failed"))
              cleanupDiagnostics.push("tool_observation_failed");
          } else events.append(payload);
        };
        const prompts: ChatMessage[] = (bound?.promptFragments ?? []).map((fragment) => ({
          role: "system",
          content: fragment.text,
        }));
        const prepare = async (
          provider: ModelProvider,
          messages: ChatMessage[],
          supplied: ModelConfig & { tools?: ToolDefinition[] } = {},
          callCtx = ctx,
        ) => {
          assertLifecycleContext(callCtx);
          await lifecycle?.idle();
          ensureActive();
          liveInput.assertNotWaiting();
          const callReservation = budget.reserveCall();
          let recallCycle: RecallCycle | undefined;
          let summarySlot: string | undefined;
          try {
            const index = stepIndex++;
            const next = config.controller?.prepareStep
              ? await observeControl("prepareStep", () =>
                  config.controller!.prepareStep!({ index, tools: supplied.tools ?? [] }, callCtx),
                )
              : undefined;
            const overrides = { ...prepareDefaults, ...next };
            if (overrides.stop) throw new HarnessBudgetError(overrides.stop.reason);
            const role = overrides.modelRole ?? "main";
            if (!request.grants.modelRoles.includes(role))
              throw new Error("Controller selected an ungranted model role");
            const binding = config.models?.[role];
            const selected = binding?.provider ?? (role === "main" ? provider : undefined);
            if (!selected) throw new Error("No host model binding for selected role");
            const active =
              overrides.activeToolIds ??
              (supplied.tools ?? []).map((tool) => tool.name).filter((id) => request.grants.toolIds.includes(id));
            narrow(request.grants.toolIds, active, "active tool");
            if (request.grants.requiredToolIds?.some((id) => !active.includes(id)))
              throw new Error("Controller omitted a required tool");
            if (active.some((id) => !(supplied.tools ?? []).some((tool) => tool.name === id)))
              throw new Error("Controller selected an unavailable tool");
            for (const key of Object.keys(overrides.options ?? {}))
              if (!binding?.options?.includes(key as keyof ModelConfig))
                throw new HarnessUnsupportedError(`model option ${key}`);
            if (
              currentRole !== role &&
              messages.some((message) => message.providerExtras && !message.providerExtras.harnessContext)
            )
              throw new Error("Cannot switch model roles while opaque provider continuation is present");
            currentRole = role;
            for (const value of [supplied.maxTokens, overrides.options?.maxTokens]) {
              if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
                throw new HarnessUnsupportedError("maxTokens must be a finite positive integer");
            }
            const options: ModelConfig & { tools?: ToolDefinition[] } = {
              ...supplied,
              ...overrides.options,
              signal: AbortSignal.any([
                controller.signal,
                ...(supplied.signal ? [supplied.signal] : []),
                ...(callCtx.signal ? [callCtx.signal] : []),
              ]),
              deadline: Math.min(
                supplied.deadline ?? Infinity,
                overrides.options?.deadline ?? Infinity,
                request.deadline ?? Infinity,
              ),
              tools: supplied.tools?.filter((tool) => active.includes(tool.name)),
            };
            if (!Number.isFinite(options.deadline)) delete options.deadline;
            options.maxTokens ??= selected.capabilities?.maxOutputTokens;
            const resident = await retain(selected, callCtx, messages);
            const conversationId = callCtx.runId === request.runId ? "main" : callCtx.runId;
            let summary: TaskSummaryRecord | undefined = taskSummaries[conversationId];
            let summaryUpdated = false;
            let recall: RecallResult | undefined;
            let archiveAdditions: import("./recall.js").EvidenceExcerpt[] = [];
            const continuityDiagnostics: import("./recall.js").RecallDiagnostic[] = [];
            const usageState = createRecallUsage();
            const estimateEvidenceTokens = (text: string) =>
              (config.estimateInputTokens ?? estimateInputTokens)({
                provider: selected,
                messages: [{ role: "user", content: text }],
                tools: [],
              });
            const openCycle = () =>
              openRecallCycle({
                store: config.recall!.store,
                scope: recallScope!,
                budget: config.recall!.budget,
                signal: options.signal!,
                runDeadline: options.deadline,
                usage: usageState,
                estimateTokens: estimateEvidenceTokens,
              });
            if (config.recall && recallScope) {
              recallCycle = await openCycle();
              if (summary) {
                const validity = await recallCycle.validate(
                  summary.evidence.map((item) => item.reference),
                  summary.sourceViewRevision,
                );
                if (!validity.valid) {
                  delete taskSummaries[conversationId];
                  summary = undefined;
                }
              }
              const batch = config.taskSummary
                ? await readTaskSummaryAdditions(recallCycle, {
                    previous: summary,
                    archives: archivedHistory,
                    conversationId,
                    maxInputBytes: config.taskSummary.maxInputBytes,
                  })
                : undefined;
              archiveAdditions = batch?.additions ?? [];
              continuityDiagnostics.push(...(batch?.diagnostics ?? []));
              // Complete all source I/O under the unchanged retrieval deadline before model latency.
              const query = config.recall.policy.query({ history: resident }, callCtx);
              await recallCycle.query(
                query === undefined ? undefined : boundRecallQuery(query, config.recall.budget.maxQueryBytes),
              );
              if (batch?.coverage && config.taskSummary) {
                const taskTokenFloor =
                  (config.estimateInputTokens ?? estimateInputTokens)({
                    provider: selected,
                    messages: [...prompts, ...sources.messages, ...resident],
                    tools: options.tools ?? [],
                  }) +
                  (options.maxTokens ?? 0) +
                  128;
                const recordCount =
                  Object.keys(taskSummaries).length +
                  [...pendingSummaryConversations].filter((id) => !taskSummaries[id]).length;
                if (
                  (budget.snapshot().modelCalls.ordinaryRemaining ?? Infinity) < 1 ||
                  pendingSummaryConversations.has(conversationId) ||
                  (!summary && recordCount >= config.taskSummary.maxSummaryRecords)
                )
                  continuityDiagnostics.push(recallDiagnostic("pending_summary", "summary"));
                else {
                  pendingSummaryConversations.add(conversationId);
                  summarySlot = conversationId;
                  const summaryServices = new Proxy(services, {
                    get(target, property, receiver) {
                      if (property === "controlModel")
                        return (
                          role: string,
                          history: readonly ChatMessage[],
                          controlOptions: Pick<ModelConfig, "maxTokens" | "temperature"> = {},
                        ) => independentModel(role, history, controlOptions, false, options.signal, options.deadline);
                      return Reflect.get(target, property, receiver);
                    },
                  });
                  const summaryContext = new RunContext({
                    sessionId: callCtx.sessionId,
                    userId: callCtx.userId,
                    tenantId: callCtx.tenantId,
                    runId: callCtx.runId,
                    eventBus: callCtx.eventBus,
                    executionServices: summaryServices,
                    signal: options.signal,
                    metadata: callCtx.metadata,
                    sessionState: callCtx.sessionState,
                    dependencies: callCtx.dependencies,
                    runMode: callCtx.runMode,
                    executionPolicy: callCtx.executionPolicy,
                    ephemeral: callCtx.ephemeral,
                    externalHistory: callCtx.externalHistory,
                    questions: callCtx.questions,
                  });
                  const update = await updateTaskSummary({
                    previous: summary,
                    additions: batch.additions,
                    coverage: batch.coverage,
                    archives: archivedHistory,
                    scope: recallScope,
                    config: config.taskSummary,
                    ctx: summaryContext,
                    cycle: recallCycle,
                    taskTokenFloor,
                    remainingTokens: budget.snapshot().tokens.ordinaryRemaining ?? Infinity,
                    recordCount,
                    estimateTokens: estimateEvidenceTokens,
                  });
                  summary = update.record;
                  summaryUpdated = update.updated;
                  continuityDiagnostics.push(...update.diagnostics);
                }
              }
              const observed = () => {
                const result = recallCycle!.result(archiveAdditions);
                result.diagnostics = [...result.diagnostics, ...continuityDiagnostics];
                if (continuityDiagnostics.length && result.status !== "failed") result.status = "partial";
                return result;
              };
              recall = observed();
              let clarifications = 0;
              while (true) {
                const raw = await config.recall.policy.decide(structuredClone(recall), callCtx);
                ensureActive();
                options.signal?.throwIfAborted();
                const decision = recallDecisionSchema.parse(raw);
                if (decision.action === "continue") break;
                if (decision.action === "stop") throw new HarnessContinuityError("recall_stopped", decision.reason);
                if (clarifications >= (config.recall.maxClarifications ?? 1))
                  throw new HarnessContinuityError("clarification_limit", "Recall clarification limit reached");
                clarifications++;
                await recallCycle.close();
                const reply = await services.requestInput({ question: decision.question });
                ensureActive();
                options.signal?.throwIfAborted();
                if (options.deadline !== undefined && Date.now() >= options.deadline)
                  throw new HarnessContinuityError(
                    "recall_deadline",
                    "Recall call deadline exhausted while awaiting clarification",
                  );
                const evidence: ChatMessage = { role: "user", content: reply.input };
                const destination = conversationId === "main" ? canonical : (conversations[callCtx.runId] ??= []);
                destination.push(structuredClone(evidence));
                resident.push(structuredClone(evidence));
                await retain(selected, callCtx);
                recallCycle = await openCycle();
                const newQuery = config.recall.policy.query({ history: resident }, callCtx);
                await recallCycle.query(
                  newQuery === undefined ? undefined : boundRecallQuery(newQuery, config.recall.budget.maxQueryBytes),
                );
                const references = [
                  ...archiveAdditions.map((item) => item.reference),
                  ...(summary?.evidence.map((item) => item.reference) ?? []),
                ];
                if (
                  references.length &&
                  !(await recallCycle.validate(references, summary?.sourceViewRevision ?? recall?.viewRevision ?? ""))
                    .valid
                ) {
                  delete taskSummaries[conversationId];
                  summary = undefined;
                  archiveAdditions = [];
                }
                recall = observed();
              }
            }
            const composed = [...prompts, ...sources.messages, ...resident];
            const transformed = await runBeforeModel(middleware, composed, callCtx);
            const contextPolicy =
              overrides.contextPolicy ??
              config.contextPolicy ??
              (config.recall
                ? continuityContextPolicy({
                    id: "agentium/continuity",
                    maxRequestTokens: selected.capabilities?.contextWindow ?? Number.MAX_SAFE_INTEGER,
                    reservedRequestTokens:
                      (options.maxTokens ?? 0) +
                      128 +
                      Math.max(
                        0,
                        (config.estimateInputTokens ?? estimateInputTokens)({
                          provider: selected,
                          messages: [],
                          tools: options.tools ?? [],
                        }),
                      ),
                  })
                : undefined);
            const projection = await projectHarnessContext(contextPolicy, transformed, callCtx, entries, {
              recall,
              taskSummary: summary,
            });
            if (config.recall && recall) {
              const requiredIds = new Set([
                ...recall.excerpts.map((item) => item.id),
                ...(summary ? [summary.id] : []),
              ]);
              const inserted = projection.messages.filter((message) => message.providerExtras?.harnessContext);
              const markers = inserted.map((message) => ({
                role: message.role,
                metadata: z
                  .object({ entryId: z.string(), trust: z.literal("source") })
                  .passthrough()
                  .safeParse(message.providerExtras?.harnessContext),
              }));
              if (markers.some((message) => message.role !== "user" || !message.metadata.success))
                throw new HarnessContinuityError(
                  "source_trust_violation",
                  "Continuity evidence must remain user source data",
                );
              const omissions = [...requiredIds].filter(
                (id) =>
                  !markers.some((message) => message.metadata.success && message.metadata.data.entryId === id) ||
                  projection.provenance.some((item) => item.sourceId === id && !item.included),
              );
              if (omissions.length) {
                const partial: RecallResult = {
                  ...recall,
                  status: "partial",
                  diagnostics: [...recall.diagnostics, recallDiagnostic("partial_evidence", "assembly")],
                };
                const decision = recallDecisionSchema.parse(
                  await config.recall.policy.decide(structuredClone(partial), callCtx),
                );
                ensureActive();
                if (decision.action !== "continue")
                  throw new HarnessContinuityError(
                    "recall_assembly_omitted",
                    "Required continuity evidence was omitted by prompt allocation",
                  );
              }
            }
            ensureActive();
            options.signal?.throwIfAborted();
            activeTools.set(callCtx.runId, active);
            const projectedInput = (config.estimateInputTokens ?? estimateInputTokens)({
              provider: selected,
              messages: projection.messages,
              tools: options.tools ?? [],
            });
            validateModelRequest(
              selected.capabilities,
              projection.messages,
              options,
              selected.unknownCapabilities,
              projectedInput + (config.recall ? 128 : 0),
            );
            if (recallCycle && recall) {
              const references: EvidenceReference[] = [
                ...recall.excerpts.map((item) => item.reference),
                ...(summary?.evidence.map((item) => item.reference) ?? []),
              ];
              if (references.length || recall.status !== "failed") {
                const validity = await recallCycle.validate(
                  references,
                  summary?.sourceViewRevision ?? recall.viewRevision ?? "",
                );
                if (!validity.valid) {
                  delete taskSummaries[conversationId];
                  throw new HarnessContinuityError(
                    "recall_validation_failed",
                    "Continuity evidence changed or could not be validated before submission",
                  );
                }
              }
            }
            const reservation = budget.reserve(projectedInput, options.maxTokens, false, callReservation);
            if (summary && summaryUpdated) taskSummaries[conversationId] = summary;
            if (reservation.maxTokens !== undefined) options.maxTokens = reservation.maxTokens;
            return { provider: selected, messages: projection.messages, options, reservation };
          } catch (error) {
            callReservation.release();
            throw error;
          } finally {
            if (summarySlot) pendingSummaryConversations.delete(summarySlot);
            await recallCycle?.close();
            if (recallCycle?.cleanupFailed && !cleanupDiagnostics.includes("recall_cleanup_failed"))
              cleanupDiagnostics.push("recall_cleanup_failed");
          }
        };
        const account = (provider: ModelProvider, amount: TokenUsage) => {
          if (
            [amount.promptTokens, amount.completionTokens, amount.totalTokens].some(
              (value) => !Number.isFinite(value) || value < 0,
            )
          )
            throw new Error("Provider returned invalid token usage");
          usage.promptTokens += amount.promptTokens;
          usage.completionTokens += amount.completionTokens;
          usage.totalTokens += amount.totalTokens;
          for (const key of ["reasoningTokens", "cachedTokens", "audioInputTokens", "audioOutputTokens"] as const)
            if (amount[key] !== undefined) usage[key] = (usage[key] ?? 0) + amount[key]!;
          if (!controller.signal.aborted && !terminal)
            events.append({
              type: "model.complete",
              providerId: provider.providerId,
              modelId: provider.modelId,
              usage: {
                promptTokens: amount.promptTokens,
                completionTokens: amount.completionTokens,
                totalTokens: amount.totalTokens,
              },
            });
        };
        const independentModel = (
          role: string,
          messages: readonly ChatMessage[],
          options: Pick<ModelConfig, "maxTokens" | "temperature"> = {},
          finishing = false,
          operationSignal?: AbortSignal,
          operationDeadline?: number,
        ): Promise<ModelResponse> =>
          track(
            (async () => {
              const generate = async () => {
                ensureActive();
                liveInput.assertNotWaiting();
                operationSignal?.throwIfAborted();
                if (!request.grants.modelRoles.includes(role)) throw new Error("Ungranted control model role");
                const binding = config.models?.[role];
                if (!binding) throw new Error("Control model requires an explicit host binding");
                for (const key of Object.keys(options)) {
                  if (
                    !["maxTokens", "temperature"].includes(key) ||
                    !binding.options?.includes(key as keyof ModelConfig)
                  )
                    throw new HarnessUnsupportedError(`control model option ${key}`);
                }
                if (
                  options.maxTokens !== undefined &&
                  (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)
                )
                  throw new HarnessUnsupportedError("maxTokens must be a finite positive integer");
                if (
                  options.temperature !== undefined &&
                  (!Number.isFinite(options.temperature) || options.temperature < 0)
                )
                  throw new HarnessUnsupportedError("temperature must be finite and non-negative");
                const projection = structuredClone(messages) as ChatMessage[];
                if (
                  projection.some(
                    (message) => message.role === "tool" || message.toolCalls?.length || message.providerExtras,
                  )
                )
                  throw new Error(
                    "Control model calls require independent plain messages without provider/tool continuation",
                  );
                validateHarnessMessages(projection, projection);
                const projectedInput = (config.estimateInputTokens ?? estimateInputTokens)({
                  provider: binding.provider,
                  messages: projection,
                  tools: [],
                });
                const requestedOutput = options.maxTokens ?? binding.provider.capabilities?.maxOutputTokens;
                validateModelRequest(
                  binding.provider.capabilities,
                  projection,
                  { ...options, maxTokens: requestedOutput },
                  binding.provider.unknownCapabilities,
                  projectedInput,
                );
                const reservation = budget.reserve(projectedInput, requestedOutput, finishing);
                const maxTokens = reservation.maxTokens;
                let accounted = false;
                try {
                  ensureActive();
                  const response = await generateObserved(
                    binding.provider,
                    projection,
                    {
                      ...options,
                      ...(maxTokens !== undefined ? { maxTokens } : {}),
                      signal: operationSignal
                        ? AbortSignal.any([controller.signal, operationSignal])
                        : controller.signal,
                      deadline: operationDeadline ?? request.deadline,
                    },
                    reservation.start,
                  );
                  reservation.settle(response.usage);
                  await persistBudget();
                  if (!native) account(binding.provider, response.usage);
                  accounted = true;
                  ensureActive();
                  operationSignal?.throwIfAborted();
                  if (response.finishReason !== "stop" || response.message.toolCalls?.length)
                    throw new Error("Control model must return a complete tool-free response");
                  return response;
                } catch (error) {
                  const amount = error instanceof ModelUsageError ? error.usage : undefined;
                  if (amount && !accounted) {
                    reservation.settle(amount);
                    account(binding.provider, amount);
                  }
                  throw error;
                } finally {
                  reservation.settle();
                  await persistBudget();
                }
              };
              if (!native) return generate();
              const response = await native.run(
                "control",
                { role, messages, options, finishing },
                async () => nativeModelValue(await generate()),
                parseNativeModelResponse,
              );
              // Apply usage after child replay too. Nested decisions intentionally
              // do not restore a transient parent snapshot during context projection.
              const binding = config.models?.[role];
              if (!binding) throw new Error("Control model requires an explicit host binding");
              account(binding.provider, response.usage);
              return response;
            })(),
          );
        services = {
          ...(native
            ? {
                toolConcurrency: 1,
                isControlFlowError: (error: unknown) =>
                  isHarnessNativeInputPending(error) || error instanceof HarnessNativeRecoveryError,
              }
            : {}),
          ctx,
          signal: controller.signal,
          tools,
          definitionId: config.definition?.kind === "portable" ? config.definition.manifest.id : config.definition?.id,
          agentConfiguration: {
            defaults: resolved?.defaults ?? {},
            limits: resolved?.limits ?? {},
            projectRoot: config.projectRoot ?? process.cwd(),
          },
          executionPolicy: policy,
          rootExecution,
          executeTool: native
            ? async (call, context, execute) => {
                assertLifecycleContext(context);
                const recovery = native;
                if (!recovery) throw new Error("Native recovery was not initialized");
                return recovery.run(
                  "tool",
                  { id: call.id, name: call.name, args: call.arguments },
                  async () => {
                    const result = await execute();
                    await persistBudget();
                    return nativeJSON(result);
                  },
                  (value) => {
                    const result = z
                      .object({
                        toolCallId: z.string(),
                        toolName: z.string(),
                        result: z.unknown(),
                        error: z.string().optional(),
                        denial: z.enum(["policy", "approval_required", "approval_denied", "cancelled"]).optional(),
                      })
                      .parse(value);
                    if (result.toolCallId !== call.id || result.toolName !== call.name)
                      throw new HarnessNativeRecoveryError(new Error("Retained tool identity mismatch"));
                    return { ...result, result: parseNativeToolResult(result.result) };
                  },
                );
              }
            : undefined,
          invokeTool: async (tool, call, args, context, execute) => {
            assertLifecycleContext(context);
            await persistBudget();
            const previous = context.metadata.nativeToolCallId;
            if (native) context.metadata.nativeToolCallId = call.id;
            try {
              return options.recovery?.invokeTool
                ? await options.recovery.invokeTool(tool, call, args, context, execute)
                : await execute();
            } finally {
              if (native) {
                if (previous === undefined) delete context.metadata.nativeToolCallId;
                else context.metadata.nativeToolCallId = previous;
              }
            }
          },
          approvalManager: config.approvalManager,
          state,
          sessionKey: harnessSessionKey(request.identity, request.sessionId),
          get history() {
            return structuredClone(canonical);
          },
          get budget() {
            return budget.snapshot();
          },
          get archivedHistory() {
            return structuredClone(archivedHistory);
          },
          retainHistory: config.residentHistory
            ? (provider, messages, context) =>
                track(
                  native
                    ? native.run(
                        "retain-history",
                        { providerId: provider?.providerId, modelId: provider?.modelId, messages },
                        () => retain(provider, context, messages),
                        (value) =>
                          z
                            .array(
                              z.custom<ChatMessage>(
                                (item) =>
                                  typeof item === "object" && item !== null && "role" in item && "content" in item,
                              ),
                            )
                            .parse(value),
                      )
                    : retain(provider, context, messages),
                )
            : undefined,
          retrieveHistory: (referenceId) =>
            track(
              (async () => {
                ensureActive();
                const reference = archivedHistory.find((item) => item.id === referenceId);
                if (!reference || !config.residentHistory) throw new Error("Unknown scoped history reference");
                return retrieveHistory(
                  config.residentHistory.archive,
                  { identity: request.identity, sessionId: request.sessionId },
                  reference,
                );
              })(),
            ),
          controlModel: (role, messages, options) => independentModel(role, messages, options),
          finishModel: (role, messages, options) => independentModel(role, messages, options, true),
          model: (provider, messages, options, callCtx) =>
            track(
              (async () => {
                assertLifecycleContext(callCtx ?? ctx);
                const generate = async () => {
                  const call = await prepare(provider, messages, options, callCtx);
                  let accounted = false;
                  try {
                    ensureActive();
                    const response = await generateObserved(
                      call.provider,
                      call.messages,
                      call.options,
                      call.reservation.start,
                    );
                    call.reservation.settle(response.usage);
                    await persistBudget();
                    account(call.provider, response.usage);
                    accounted = true;
                    ensureActive();
                    await lifecycle?.settle(
                      modelRecoveryBoundary(call.provider, call.messages, call.options, response),
                    );
                    ensureActive();
                    await runAfterModel(middleware, response, callCtx ?? ctx);
                    return response;
                  } catch (error) {
                    const amount = error instanceof ModelUsageError ? error.usage : undefined;
                    if (amount && !accounted) {
                      call.reservation.settle(amount);
                      account(call.provider, amount);
                    }
                    throw error;
                  } finally {
                    call.reservation.settle();
                    await persistBudget();
                  }
                };
                return native
                  ? native.run(
                      "model",
                      {
                        providerId: provider.providerId,
                        modelId: provider.modelId,
                        messages,
                        options: nativeRequestOptions(options),
                      },
                      async () => nativeModelValue(await generate()),
                      parseNativeModelResponse,
                    )
                  : generate();
              })(),
            ),
          streamModel: (provider, messages, options, callCtx) => {
            assertLifecycleContext(callCtx ?? ctx);
            const open = (streamSignal?: AbortSignal) => {
              let finishLifetime!: () => void;
              track(
                new Promise<void>((resolve) => {
                  finishLifetime = resolve;
                }),
              );
              const implementation = (async function* (): AsyncGenerator<StreamChunk> {
                const call = await prepare(
                  provider,
                  messages,
                  streamSignal
                    ? {
                        ...options,
                        signal: AbortSignal.any([streamSignal, ...(options?.signal ? [options.signal] : [])]),
                      }
                    : options,
                  callCtx,
                );
                const endObservation = observeModel(call.provider);
                let stream: AsyncGenerator<StreamChunk> | undefined;
                let succeeded = false;
                let text = "";
                let finished = false;
                let amount = zero();
                let reason = "stop";
                let extras: Record<string, unknown> | undefined;
                let publicMessages: PublicMessage[] | undefined;
                let phase: "commentary" | "final" | undefined;
                let executionLease: Awaited<ReturnType<RootExecutionController["acquire"]>> | undefined;
                const calls: Array<{ id: string; name: string; args: string }> = [];
                try {
                  ensureActive();
                  liveInput.assertNotWaiting();
                  call.options.signal?.throwIfAborted();
                  executionLease = await rootExecution?.acquire(
                    "model",
                    `${runId}/${randomUUID()}`,
                    call.options.signal,
                  );
                  call.reservation.start();
                  await persistBudget();
                  stream = call.provider.stream(call.messages, call.options);
                  while (true) {
                    const next = await (executionLease ? executionLease.run(() => stream!.next()) : stream.next());
                    if (!next.done && next.value.type === "finish") {
                      if (finished) throw new Error("Provider emitted duplicate terminal usage");
                      finished = true;
                      reason = next.value.finishReason;
                      extras = next.value.providerExtras;
                      publicMessages = next.value.publicMessages;
                      phase = next.value.phase;
                      amount = next.value.usage ?? zero();
                      call.reservation.settle(next.value.usage);
                      await persistBudget();
                      account(call.provider, amount);
                    }
                    ensureActive();
                    if (next.done) break;
                    if (next.value.type === "text") text += next.value.text;
                    else if (next.value.type === "tool_call_start") calls.push({ ...next.value.toolCall, args: "" });
                    else if (next.value.type === "tool_call_delta") {
                      const chunk = next.value;
                      const pending = calls.find((item) => item.id === chunk.toolCallId);
                      if (pending) pending.args += chunk.argumentsDelta;
                    }
                    yield next.value;
                  }
                  if (!finished) throw new ModelProtocolError(text, amount);
                  const response: ModelResponse = {
                    message: {
                      role: "assistant",
                      content: text || null,
                      ...(phase ? { phase } : {}),
                      ...(calls.length
                        ? {
                            toolCalls: calls.map((item) => ({
                              id: item.id,
                              name: item.name,
                              arguments: JSON.parse(item.args),
                            })),
                          }
                        : {}),
                      ...(extras ? { providerExtras: extras } : {}),
                    },
                    usage: amount,
                    finishReason:
                      reason === "tool_calls" || reason === "length" || reason === "content_filter" ? reason : "stop",
                    raw: { streamed: true },
                    ...(publicMessages ? { publicMessages } : {}),
                  };
                  await lifecycle?.settle(modelRecoveryBoundary(call.provider, call.messages, call.options, response));
                  ensureActive();
                  await runAfterModel(middleware, response, callCtx ?? ctx);
                  succeeded = true;
                } catch (error) {
                  const known = error instanceof ModelUsageError ? error.usage : undefined;
                  if (known && !finished) {
                    call.reservation.settle(known);
                    account(call.provider, known);
                  }
                  throw error;
                } finally {
                  endObservation(succeeded, finished ? amount : undefined);
                  call.reservation.settle();
                  try {
                    if (stream)
                      await (executionLease
                        ? executionLease.cleanup(() => stream!.return(undefined))
                        : stream.return(undefined));
                    await persistBudget();
                  } finally {
                    await executionLease?.release();
                  }
                }
              })();
              const finish = () => {
                streams.delete(iterator);
                finishLifetime();
              };
              const iterator: AsyncGenerator<StreamChunk> = {
                [Symbol.asyncIterator]() {
                  return this;
                },
                [Symbol.asyncDispose]: async () => {
                  await iterator.return(undefined);
                },
                next: (...args) =>
                  track(implementation.next(...args)).then(
                    (item) => {
                      if (item.done) finish();
                      return item;
                    },
                    (error) => {
                      finish();
                      throw error;
                    },
                  ),
                return: (value) => track(implementation.return(value)).finally(finish),
                throw: (error) => track(implementation.throw(error)).finally(finish),
              };
              streams.add(iterator);
              return iterator;
            };
            return native
              ? native.stream(
                  {
                    providerId: provider.providerId,
                    modelId: provider.modelId,
                    messages,
                    options: nativeRequestOptions(options),
                  },
                  open,
                )
              : open();
          },
          runOwned: (operation) =>
            track(
              (async () => {
                ensureActive();
                return operation();
              })(),
            ),
          observeTool: async (result, callCtx) => {
            assertLifecycleContext(callCtx ?? ctx);
            const observe = async () => {
              await observeSettlement(result, callCtx ?? ctx);
              ensureActive();
              await runAfterTool(middleware, result, callCtx ?? ctx);
              return null;
            };
            if (native) await native.run("observe-tool", { result }, observe, () => undefined);
            else await observe();
          },
          dispatch: (call) =>
            track(
              (async () => {
                ensureActive();
                const [result] = await executor.executeAll([call], ctx);
                await settleApplicationTools([result]);
                await observeSettlement(result, ctx);
                ensureActive();
                await runAfterTool(middleware, result, ctx);
                return result;
              })(),
            ),
          dispatchEffect: (name, args, execute) =>
            track(
              (async () => {
                ensureActive();
                let value: unknown;
                const tool: ToolDef = {
                  name,
                  description: "Trusted deterministic workflow step",
                  parameters: z.object({}).passthrough(),
                  execute: async (validated, callCtx) => {
                    value = await execute(validated, callCtx);
                    return "Completed";
                  },
                };
                const effectExecutor = new ToolExecutor([tool], {
                  approvalManager: config.approvalManager,
                  executionPolicy: ctx.executionPolicy,
                });
                const [result] = await effectExecutor.executeAll([{ id: randomUUID(), name, arguments: args }], ctx);
                await observeSettlement(result, ctx);
                ensureActive();
                await runAfterTool(middleware, result, ctx);
                if (result.error) throw new Error(result.error);
                return value as never;
              })(),
            ),
          recordConversation: (executionId, messages) => {
            ensureActive();
            const destination = executionId === request.runId ? canonical : (conversations[executionId] ??= []);
            const additions = structuredClone(messages);
            const combined = [...destination, ...additions];
            validateHarnessMessages(combined, combined);
            destination.push(...additions);
            if (executionId === request.runId && !config.residentHistory)
              (conversations[executionId] ??= []).push(...structuredClone(additions));
          },
          observeToolSettlements: async (results, context = ctx) => {
            assertLifecycleContext(context);
            const observe = async () => {
              await settleApplicationTools(results);
              for (const result of results) await observeSettlement(result, context);
              return null;
            };
            if (native) await native.run("tool-batch", { results }, observe, () => undefined);
            else await observe();
          },
          append: (messages) => {
            ensureActive();
            canonical.push(...structuredClone(messages));
          },
          emit: (payload) => {
            if (payload.type !== "compaction.failed" || terminal) ensureActive();
            const bytes = Buffer.byteLength(JSON.stringify(payload));
            if (bytes > 65536) throw new Error("Generic event exceeds 64KB; store an artifact reference instead");
            events.append(payload);
          },
          finishInput: (context) => {
            if (context.runId === request.runId) acceptingSteering = false;
          },
          publishMessage: (event) => {
            // Failure events must remain observable during cooperative cancellation.
            if (terminal) return;
            if (native) {
              const originalId = event.type === "message.completed" ? event.message.id : event.id;
              let id = publicMessageIds.get(originalId);
              if (!id) {
                id = `${runId}/message/${publicMessageIds.size}`;
                publicMessageIds.set(originalId, id);
              }
              event =
                event.type === "message.completed" ? { ...event, message: { ...event.message, id } } : { ...event, id };
            }
            if (event.type === "message.completed" && Buffer.byteLength(JSON.stringify(event)) > 60000) {
              const artifactId = randomUUID();
              this.artifacts.set(artifactId, { owner: services.sessionKey, value: structuredClone(event.message) });
              events.append({ ...event, message: { ...event.message, text: "" }, artifactId });
            } else events.append(event);
          },
          requestInput: (question) => {
            ensureActive();
            question = validateInputRequest(question);
            if (native)
              return track(
                native.run(
                  "input",
                  question,
                  async (id) => {
                    const inputRequest = { ...question, id: `${request.runId}/${id}`, runId: request.runId };
                    nativePending = inputRequest;
                    events.append({ type: "input.requested", request: inputRequest });
                    const reply = await options.recovery?.native?.requestInput?.(inputRequest);
                    if (!reply) throw new HarnessNativeInputPending(inputRequest);
                    if (reply.requestId !== inputRequest.id)
                      throw new HarnessInputError("input_mismatch", "Durable answer does not match its question");
                    const answer = validateRunInput(reply.input);
                    nativePending = undefined;
                    events.append({ type: "input.resolved", requestId: inputRequest.id });
                    return nativeJSON({ requestId: reply.requestId, input: answer });
                  },
                  (value) => {
                    const reply = z.object({ requestId: z.string(), input: z.unknown() }).parse(value);
                    nativePending = undefined;
                    return { requestId: reply.requestId, input: validateRunInput(reply.input) };
                  },
                ),
              );
            return track(liveInput.requestInput(question));
          },
          takeInput: (context) => {
            ensureActive();
            if (context && context.runId !== request.runId) return undefined;
            const index = inbox.findIndex((item) => item.mode === "steer");
            if (index < 0) return undefined;
            const item = inbox.splice(index, 1)[0];
            events.append({ type: "input.applied", inputId: item.id, mode: "steer" });
            return item;
          },
          resource: (id, scope, initialize) =>
            track(
              (async () => {
                ensureActive();
                const lease = await this.resources.acquire(request.identity, request.sessionId, id, scope, initialize);
                releases.push(lease.release);
                ensureActive();
                return lease.value;
              })(),
            ),
          putArtifact: (value) => {
            ensureActive();
            const id = randomUUID();
            this.artifacts.set(id, { owner: services.sessionKey, value: structuredClone(value) });
            return id;
          },
          getArtifact: (id) => {
            ensureActive();
            return this.getArtifact(request.identity, request.sessionId, id);
          },
        };
        const prepareRun = async () => {
          if (config.models?.main || !canonical.some((message) => message.providerExtras)) await retain();
          return (
            (config.controller?.prepareRun
              ? await observeControl("prepareRun", () => config.controller!.prepareRun!(ctx))
              : undefined) ?? {}
          );
        };
        prepareDefaults = native
          ? await native.run("prepare-run", {}, prepareRun, (value) =>
              z.custom<StepOverrides>((item) => typeof item === "object" && item !== null).parse(value),
            )
          : await prepareRun();
        if (prepareDefaults.stop) throw new HarnessBudgetError(prepareDefaults.stop.reason);
        events.append({ type: "run.started", driverId: config.driver.id });
        let current = request;
        while (true) {
          ensureActive();
          acceptingSteering = true;
          final = await config.driver.start(current, services);
          acceptingSteering = false;
          if (streams.size) throw new Error("Driver returned with an unfinished model stream");
          ensureActive();
          if (
            !final ||
            typeof final.text !== "string" ||
            (final.status !== undefined &&
              !["completed", "failed", "cancelled", "stopped", "awaiting_input"].includes(final.status))
          )
            throw new Error("Driver returned an invalid terminal output");
          final = structuredClone(final);
          JSON.stringify(final);
          if (final.history) {
            const proposed = structuredClone(final.history) as ChatMessage[];
            if (canonical.some((message, index) => JSON.stringify(message) !== JSON.stringify(proposed[index])))
              throw new Error("Driver replaced immutable canonical history");
            validateHarnessMessages(proposed, proposed);
            canonical = proposed;
          }
          if (final.status && final.status !== "completed") break;
          const evaluateCompletion = async () =>
            config.completionPolicy
              ? await observeControl("completion", async () =>
                  validateCompletionDecision(
                    await config.completionPolicy!.evaluate(
                      { text: final.text, structured: final.structured, revision },
                      ctx,
                    ),
                  ),
                )
              : undefined;
          const decision =
            config.completionPolicy && native
              ? await native.run("completion", { final, revision }, evaluateCompletion, validateCompletionDecision)
              : await evaluateCompletion();
          if (decision) {
            completion = { policyId: config.completionPolicy?.id ?? "completion", revision, decision };
            services.emit({
              type: "completion",
              policyId: completion.policyId,
              revision,
              action: decision.action,
              reason: decision.reason,
              ...(decision.evidence ? { evidence: decision.evidence } : {}),
            });
            if (decision.action === "stop" || decision.action === "await_input") {
              final = {
                ...final,
                status: decision.action === "stop" ? "stopped" : "awaiting_input",
                reason: { code: decision.action, message: decision.reason },
              };
              break;
            }
            if (decision.action === "revise") {
              if (revision >= (config.budgets?.maxRevisions ?? 0)) {
                final = {
                  ...final,
                  status: "stopped",
                  reason: { code: "revision_limit", message: "Completion revision limit reached" },
                };
                break;
              }
              revision++;
              current = { ...request, input: decision.instruction };
              continue;
            }
          }
          const followUp = inbox.findIndex((item) => item.mode === "follow_up");
          if (followUp < 0) break;
          const item = inbox.splice(followUp, 1)[0];
          events.append({ type: "input.applied", inputId: item.id, mode: "follow_up" });
          current = { ...request, input: item.input };
        }
        acceptingInput = false;
        const operations = await Promise.allSettled([...owned]);
        const rejected = operations.find((entry) => entry.status === "rejected");
        if (rejected?.status === "rejected") throw rejected.reason;
        ensureActive();
        const finalize = async () => {
          await retain();
          // Completed child transcripts are canonical archive records, not permanent resident copies.
          for (const [executionId, messages] of Object.entries(conversations)) {
            if (!config.residentHistory) break;
            const reference = await archiveCompletedConversation(
              messages,
              config.residentHistory,
              { identity: request.identity, sessionId: request.sessionId },
              executionId,
            );
            if (reference) archivedHistory.push(reference);
            delete conversations[executionId];
            delete taskSummaries[executionId];
          }
          await validateSummariesAtCommit();
          return null;
        };
        if (native) await native.run("finalize", {}, finalize, () => undefined);
        else await finalize();
        await lifecycle?.finish();
        ensureActive();
        commitAttempted = true;
        try {
          await lease.commit({
            history: canonical,
            conversations,
            archivedHistory,
            state,
            replayable,
            ...continuitySnapshot(),
          });
        } catch (error) {
          cleanupDiagnostics.push("session_commit_outcome_unknown");
          throw new SessionCommitError(error);
        }
        committed = true;
      } catch (error) {
        if (native) persistenceAllowed = false;
        if (isHarnessNativeInputPending(error)) nativePending = error.request;
        if (lifecycle) {
          try {
            await lifecycle.idle();
          } catch {
            // A failed restore may leave application state partially applied.
            // Do not publish it through the ordinary session fallback commit.
            persistenceAllowed = false;
          }
        }
        final = {
          ...final,
          ...(final.text || final.structured !== undefined ? { partial: true } : {}),
          status: controller.signal.aborted
            ? "cancelled"
            : isHarnessNativeInputPending(error)
              ? "awaiting_input"
              : error instanceof HarnessBudgetError || error instanceof HarnessContinuityError
                ? "stopped"
                : "failed",
          reason: {
            code: controller.signal.aborted
              ? "cancelled"
              : error instanceof HarnessBudgetError
                ? error.code
                : ((error as { code?: string })?.code ?? "execution_failed"),
            message: controller.signal.aborted
              ? "Cancellation acknowledged; already started external effects are not rolled back"
              : error instanceof Error
                ? error.message
                : "Execution failed",
          },
        };
      } finally {
        acceptingInput = false;
        liveInput.close();
        acceptingOperations = false;
        await Promise.allSettled([...streams].map((stream) => stream.return(undefined)));
        await Promise.allSettled([...owned]);
        if (lease && persistenceAllowed && !commitAttempted && !committed) {
          await validateSummariesAtCommit();
          commitAttempted = true;
          try {
            await lease.commit({
              history: canonical,
              conversations,
              archivedHistory,
              state,
              replayable: false,
              ...continuitySnapshot(),
            });
          } catch {
            cleanupDiagnostics.push("partial_history_commit_failed");
          }
        }
        for (const release of releases.reverse()) {
          try {
            await release();
          } catch {
            cleanupDiagnostics.push("resource_release_failed");
          }
        }
        try {
          const diagnostics = await bound?.dispose();
          cleanupDiagnostics.push(...(diagnostics ?? []).map((item) => item.code));
        } catch {
          cleanupDiagnostics.push("binding_release_failed");
        }
        try {
          await lease?.release();
        } catch {
          cleanupDiagnostics.push("session_release_failed");
        }
        if (timer) clearTimeout(timer);
        callerSignal?.removeEventListener("abort", onAbort);
      }
      if (controller.signal.aborted)
        final = {
          ...final,
          status: "cancelled",
          reason: {
            code: cancellationCode,
            message:
              controller.signal.reason instanceof Error
                ? controller.signal.reason.message
                : "Cancellation acknowledged",
          },
        };
      const terminalResult: HarnessResult = {
        status: final.status ?? "completed",
        text: final.text,
        ...(final.structured !== undefined ? { structured: final.structured } : {}),
        ...(final.reason ? { reason: final.reason } : {}),
        ...(completion ? { completion } : {}),
        ...(final.partial !== undefined ? { partial: final.partial } : {}),
        ...(final.providerFinishReason ? { providerFinishReason: final.providerFinishReason } : {}),
        ...(final.artifacts ? { artifacts: final.artifacts } : {}),
        usage: budget.snapshot().modelCalls.used ? usage : (final.usage ?? usage),
        budget: budget.snapshot(),
        runId,
        sessionId: request.sessionId,
        finalCursor: events.cursor + 1,
      };
      if (cleanupDiagnostics.length) terminalResult.cleanupDiagnostics = cleanupDiagnostics;
      // Keep the persisted generic terminal bounded, with full output retrievable by scoped artifact ID.
      if (Buffer.byteLength(JSON.stringify(terminalResult)) > 65536) {
        const id = randomUUID();
        this.artifacts.set(id, {
          owner: harnessSessionKey(request.identity, request.sessionId),
          value: structuredClone(terminalResult),
        });
        terminalResult.text = terminalResult.text.slice(0, 4096);
        delete terminalResult.structured;
        terminalResult.artifacts = [{ id, mimeType: "application/json" }];
        if (terminalResult.reason)
          terminalResult.reason = {
            code: terminalResult.reason.code.slice(0, 128),
            message: terminalResult.reason.message.slice(0, 2048),
          };
      }
      terminal = true;
      events.append({ type: "run.terminal", result: terminalResult });
      config.telemetry?.emit("run.complete", {
        runId,
        output: {
          text: "",
          toolCalls: [],
          usage: terminalResult.usage,
          runId,
          agentName: config.driver.id,
          sessionId: request.sessionId,
          durationMs: Date.now() - startedAt,
          status:
            terminalResult.status === "failed"
              ? "error"
              : terminalResult.status === "awaiting_input"
                ? "stopped"
                : terminalResult.status,
        },
      });
      return structuredClone(terminalResult);
    });
    return {
      get budget() {
        return budget.snapshot();
      },
      runId,
      get state() {
        return nativePending
          ? "awaiting_input"
          : terminal
            ? "finished"
            : controller.signal.aborted
              ? "cancelling"
              : liveInput.request
                ? "awaiting_input"
                : "running";
      },
      get pendingInput() {
        return nativePending ?? liveInput.request;
      },
      reply: async (requestId, input) => {
        if (!acceptingInput) throw new HarnessInputError("run_finished", "Run is no longer active");
        liveInput.reply(requestId, input);
      },
      events: (options) => events.events(options),
      result: () => result.then((value) => structuredClone(value)),
      cancel,
      send: async (input, options) => {
        if (
          !acceptingInput ||
          (options.mode === "steer" && !acceptingSteering) ||
          terminal ||
          controller.signal.aborted
        )
          throw new HarnessInputError("run_finished", "Run is no longer active");
        if (!config.driver.capabilities.controls.includes(options.mode))
          throw new HarnessUnsupportedError(options.mode);
        if (inbox.length >= 32) throw new Error("Run input queue is full");
        if (options.mode === "replace") throw new HarnessUnsupportedError(options.mode);
        const item = { id: randomUUID(), input: validateRunInput(input), mode: options.mode };
        inbox.push(item);
        events.append({ type: "control", operation: options.mode });
        events.append({ type: "input.received", inputId: item.id, mode: options.mode });
      },
    };
  }
}
