import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  ApprovalManager,
  ChatMessage,
  ExecutionPolicy,
  ExecutionServices,
  MessageContent,
  ModelConfig,
  ModelProvider,
  ModelResponse,
  RunMode,
  StreamChunk,
  TokenUsage,
  ToolDef,
  ToolDefinition,
} from "@agentium/core";
import { EventBus, evaluateExecutionPolicy, RunContext, ToolExecutor } from "@agentium/core";
import { z } from "zod/v3";
import { fetchHarnessContext } from "./context.js";
import type { ContextPolicy } from "./context-policy.js";
import { projectHarnessContext } from "./context-policy.js";
import type { CompletionPolicy, ModelRoleBinding, StepController, StepOverrides } from "./controller.js";
import {
  type HarnessEvent,
  type HarnessEventPayload,
  type HarnessReason,
  type HarnessResult,
  type HarnessStatus,
  InMemoryHarnessEventStore,
} from "./events.js";
import { runAfterModel, runAfterTool, runBeforeModel, validateHarnessMessages } from "./middleware.js";
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
export class HarnessBudgetError extends Error {
  readonly code = "budget_exhausted";
  constructor(message: string) {
    super(message);
  }
}
export interface HarnessGrants {
  toolIds: readonly string[];
  requiredToolIds?: readonly string[];
  modelRoles: readonly string[];
}
export interface HarnessBudgets {
  maxModelCalls?: number;
  maxToolCalls?: number;
  maxTokens?: number;
  maxRevisions?: number;
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
  takeInput(): { input: MessageContent; mode: HarnessSendMode } | undefined;
  resource<T>(id: string, scope: "host" | "session" | "run", initialize: () => Promise<ScopedResource<T>>): Promise<T>;
  putArtifact(value: unknown): string;
  getArtifact(id: string): unknown;
}
export interface RunHandle {
  readonly runId: string;
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
  executionPolicy?: ExecutionPolicy;
  approvalManager?: ApprovalManager;
  controller?: StepController;
  contextPolicy?: ContextPolicy;
  completionPolicy?: CompletionPolicy;
  /** Explicit opt-in to new tool effects in completion revisions. */
  allowRevisionEffects?: boolean;
  sessionStore?: HarnessSessionStore;
  resources?: HarnessResourcePool;
  eventCapacity?: number;
}
export interface HarnessStartOptions {
  identity: HarnessIdentity;
  sessionId: string;
  parentRunId?: string;
  rootRunId?: string;
  signal?: AbortSignal;
  deadline?: number;
  grants?: HarnessGrants;
  runMode?: RunMode;
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
    for (const value of Object.values(config.budgets ?? {}))
      if (!Number.isInteger(value) || value < 0) throw new Error("Harness budgets must be nonnegative integers");
    this.config = {
      ...config,
      projectRoot: resolve(config.projectRoot ?? process.cwd()),
      requirements: config.requirements && Object.freeze([...config.requirements]),
      budgets: { ...config.budgets },
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
    const controller = new AbortController();
    const runId = randomUUID();
    const request: HarnessRunRequest = Object.freeze({
      input: structuredClone(input),
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
    const generateObserved = async (provider: ModelProvider, messages: ChatMessage[], supplied: ModelConfig) => {
      const end = observeModel(provider);
      try {
        const response = await provider.generate(messages, supplied);
        end(!controller.signal.aborted, response.usage);
        return response;
      } catch (error) {
        end(false);
        throw error;
      }
    };
    let terminal = false;
    const inbox: Array<{ input: MessageContent; mode: HarnessSendMode }> = [];
    const cancel = (reason = "Run cancelled") => {
      if (!terminal && !controller.signal.aborted) {
        events.append({ type: "control", operation: "cancel", reason });
        controller.abort(new Error(reason));
      }
    };
    const onAbort = () => cancel("Caller cancelled the run");
    const callerSignal = options.signal;
    callerSignal?.addEventListener("abort", onAbort, { once: true });
    if (callerSignal?.aborted) onAbort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleDeadline = () => {
      if (request.deadline === undefined || controller.signal.aborted) return;
      const remaining = request.deadline - Date.now();
      if (remaining <= 0) cancel("Run deadline exceeded");
      else timer = setTimeout(scheduleDeadline, Math.min(remaining, 2_147_483_647));
    };
    scheduleDeadline();
    const result = Promise.resolve().then(async (): Promise<HarnessResult> => {
      let lease: Awaited<ReturnType<HarnessSessionStore["acquire"]>> | undefined;
      let bound: Awaited<ReturnType<typeof bindHarness>> | undefined;
      const releases: Array<() => Promise<void>> = [];
      const usage = zero();
      let modelCalls = 0;
      let reservedTokens = 0;
      const cleanupDiagnostics: string[] = [];
      let toolCalls = 0;
      let revision = 0;
      let currentRole = "main";
      let prepareDefaults: StepOverrides = {};
      let final: HarnessDriverOutput = { text: "", status: "failed" };
      let canonical: ChatMessage[] = [];
      let conversations: Record<string, ChatMessage[]> = {};
      let state: Record<string, unknown> = {};
      let replayable = true;
      let committed = false;
      let acceptingOperations = true;
      const owned = new Set<Promise<unknown>>();
      const streams = new Set<AsyncGenerator<StreamChunk>>();
      const track = <T>(operation: Promise<T>): Promise<T> => {
        owned.add(operation);
        operation.then(
          () => owned.delete(operation),
          () => owned.delete(operation),
        );
        return operation;
      };
      const ensureActive = () => {
        if (request.deadline !== undefined && Date.now() >= request.deadline) cancel("Run deadline exceeded");
        controller.signal.throwIfAborted();
        if (!acceptingOperations) throw new Error("Run has finished accepting operations");
      };
      const activeTools = new Map<string, readonly string[]>();
      try {
        ensureActive();
        lease = await this.sessions.acquire(request.identity, request.sessionId);
        ensureActive();
        const snapshot = lease.read();
        canonical = snapshot.history;
        conversations = snapshot.conversations ?? {};
        state = snapshot.state;
        replayable = snapshot.replayable;
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
          runMode: request.runMode,
          eventBus: new EventBus(),
          sessionState: state,
          metadata: { parentRunId: request.parentRunId, rootRunId: request.rootRunId },
        });
        Object.defineProperty(ctx, "executionServices", { get: () => services, configurable: false });
        policy = {
          decide: async (call, callCtx) => {
            ensureActive();
            if (
              !request.grants.toolIds.includes(call.toolName) ||
              (activeTools.has(callCtx.runId) && !activeTools.get(callCtx.runId)!.includes(call.toolName))
            )
              return { action: "deny", reason: "Tool is outside the effective grants" };
            if (revision > 0 && !config.allowRevisionEffects)
              return { action: "deny", reason: "Completion revisions cannot execute effects without host opt-in" };
            if (toolCalls >= (config.budgets?.maxToolCalls ?? Infinity))
              return { action: "deny", reason: "Aggregate tool budget exhausted" };
            toolCalls++;
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
        const executor = new ToolExecutor(tools, { approvalManager: config.approvalManager, executionPolicy: policy });
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
          ensureActive();
          if (
            modelCalls >= (config.budgets?.maxModelCalls ?? Infinity) ||
            usage.totalTokens >= (config.budgets?.maxTokens ?? Infinity)
          )
            throw new HarnessBudgetError("Aggregate model/token budget exhausted");
          const index = modelCalls++;
          const next = config.controller?.prepareStep
            ? await observeControl("prepareStep", () =>
                config.controller!.prepareStep!({ index, tools: supplied.tools ?? [] }, callCtx),
              )
            : undefined;
          const overrides = { ...prepareDefaults, ...next };
          if (overrides.stop) throw new HarnessBudgetError(overrides.stop.reason);
          const role = overrides.modelRole ?? "main";
          if (!request.grants.modelRoles.includes(role)) throw new Error("Controller selected an ungranted model role");
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
          const composed = [...prompts, ...sources.messages, ...messages];
          const transformed = await runBeforeModel(middleware, composed, callCtx);
          const projection = await projectHarnessContext(
            overrides.contextPolicy ?? config.contextPolicy,
            transformed,
            callCtx,
            entries,
          );
          ensureActive();
          const remaining = (config.budgets?.maxTokens ?? Infinity) - usage.totalTokens - reservedTokens;
          if (remaining <= 0)
            throw new HarnessBudgetError("Aggregate token budget exhausted or reserved by another call");
          for (const value of [supplied.maxTokens, overrides.options?.maxTokens]) {
            if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
              throw new HarnessUnsupportedError("maxTokens must be a finite positive integer");
          }
          const options = {
            ...supplied,
            ...overrides.options,
            signal: controller.signal,
            tools: supplied.tools?.filter((tool) => active.includes(tool.name)),
            ...(Number.isFinite(remaining)
              ? {
                  maxTokens: Math.min(
                    supplied.maxTokens ?? Infinity,
                    overrides.options?.maxTokens ?? Infinity,
                    remaining,
                  ),
                }
              : {}),
          };
          activeTools.set(callCtx.runId, active);
          const reservation = Number.isFinite(remaining) ? (options.maxTokens ?? remaining) : 0;
          reservedTokens += reservation;
          return { provider: selected, messages: projection.messages, options, reservation };
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
        services = {
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
          approvalManager: config.approvalManager,
          state,
          sessionKey: harnessSessionKey(request.identity, request.sessionId),
          get history() {
            return structuredClone(canonical);
          },
          controlModel: (role, messages, options = {}) =>
            track(
              (async () => {
                ensureActive();
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
                const remaining = (config.budgets?.maxTokens ?? Infinity) - usage.totalTokens - reservedTokens;
                if (modelCalls >= (config.budgets?.maxModelCalls ?? Infinity) || remaining <= 0)
                  throw new HarnessBudgetError("Aggregate model/token budget exhausted");
                const maxTokens = Math.min(options.maxTokens ?? Infinity, remaining);
                const reservation = Number.isFinite(maxTokens) ? maxTokens : 0;
                modelCalls++;
                reservedTokens += reservation;
                try {
                  ensureActive();
                  const response = await generateObserved(binding.provider, projection, {
                    ...options,
                    ...(Number.isFinite(maxTokens) ? { maxTokens } : {}),
                    signal: controller.signal,
                  });
                  account(binding.provider, response.usage);
                  ensureActive();
                  if (response.finishReason !== "stop" || response.message.toolCalls?.length)
                    throw new Error("Control model must return a complete tool-free response");
                  return response;
                } finally {
                  reservedTokens -= reservation;
                }
              })(),
            ),
          model: (provider, messages, options, callCtx) =>
            track(
              (async () => {
                const call = await prepare(provider, messages, options, callCtx);
                try {
                  ensureActive();
                  const response = await generateObserved(call.provider, call.messages, call.options);
                  account(call.provider, response.usage);
                  ensureActive();
                  await runAfterModel(middleware, response, callCtx ?? ctx);
                  return response;
                } finally {
                  reservedTokens -= call.reservation;
                }
              })(),
            ),
          streamModel: (provider, messages, options, callCtx) => {
            let finishLifetime!: () => void;
            track(
              new Promise<void>((resolve) => {
                finishLifetime = resolve;
              }),
            );
            const implementation = (async function* (): AsyncGenerator<StreamChunk> {
              const call = await prepare(provider, messages, options, callCtx);
              const endObservation = observeModel(call.provider);
              let stream: AsyncGenerator<StreamChunk> | undefined;
              let succeeded = false;
              let text = "";
              let finished = false;
              let amount = zero();
              let reason = "stop";
              let extras: Record<string, unknown> | undefined;
              const calls: Array<{ id: string; name: string; args: string }> = [];
              try {
                ensureActive();
                stream = call.provider.stream(call.messages, call.options);
                while (true) {
                  const next = await stream.next();
                  if (!next.done && next.value.type === "finish") {
                    if (finished) throw new Error("Provider emitted duplicate terminal usage");
                    finished = true;
                    reason = next.value.finishReason;
                    extras = next.value.providerExtras;
                    amount = next.value.usage ?? zero();
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
                if (!finished) throw new Error("Provider stream ended without a terminal response");
                const response: ModelResponse = {
                  message: {
                    role: "assistant",
                    content: text || null,
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
                };
                await runAfterModel(middleware, response, callCtx ?? ctx);
                succeeded = true;
              } finally {
                endObservation(succeeded, finished ? amount : undefined);
                reservedTokens -= call.reservation;
                await stream?.return(undefined);
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
          },
          runOwned: (operation) =>
            track(
              (async () => {
                ensureActive();
                return operation();
              })(),
            ),
          observeTool: async (result, callCtx) => {
            ensureActive();
            await runAfterTool(middleware, result, callCtx ?? ctx);
            services.emit({
              type: "tool.complete",
              toolName: result.toolName,
              toolCallId: result.toolCallId,
              denied: Boolean(result.error),
            });
          },
          dispatch: (call) =>
            track(
              (async () => {
                ensureActive();
                const [result] = await executor.executeAll([call], ctx);
                ensureActive();
                await runAfterTool(middleware, result, ctx);
                services.emit({
                  type: "tool.complete",
                  toolName: call.name,
                  toolCallId: call.id,
                  denied: Boolean(result.error),
                });
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
                  executionPolicy: policy,
                });
                const [result] = await effectExecutor.executeAll([{ id: randomUUID(), name, arguments: args }], ctx);
                ensureActive();
                await runAfterTool(middleware, result, ctx);
                services.emit({
                  type: "tool.complete",
                  toolName: name,
                  toolCallId: result.toolCallId,
                  denied: Boolean(result.error),
                });
                if (result.error) throw new Error(result.error);
                return value as never;
              })(),
            ),
          recordConversation: (executionId, messages) => {
            ensureActive();
            const combined = [...(conversations[executionId] ?? []), ...structuredClone(messages)];
            validateHarnessMessages(combined, combined);
            conversations[executionId] = combined;
            if (executionId === request.runId) canonical.push(...structuredClone(messages));
          },
          append: (messages) => {
            ensureActive();
            canonical.push(...structuredClone(messages));
          },
          emit: (payload) => {
            ensureActive();
            const bytes = Buffer.byteLength(JSON.stringify(payload));
            if (bytes > 65536) throw new Error("Generic event exceeds 64KB; store an artifact reference instead");
            events.append(payload);
          },
          takeInput: () => {
            ensureActive();
            const index = inbox.findIndex((item) => item.mode === "steer");
            return index < 0 ? undefined : inbox.splice(index, 1)[0];
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
        prepareDefaults =
          (config.controller?.prepareRun
            ? await observeControl("prepareRun", () => config.controller!.prepareRun!(ctx))
            : undefined) ?? {};
        if (prepareDefaults.stop) throw new HarnessBudgetError(prepareDefaults.stop.reason);
        events.append({ type: "run.started", driverId: config.driver.id });
        let current = request;
        while (true) {
          ensureActive();
          final = await config.driver.start(current, services);
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
          const decision = config.completionPolicy
            ? await observeControl("completion", () =>
                config.completionPolicy!.evaluate({ text: final.text, structured: final.structured, revision }, ctx),
              )
            : undefined;
          if (decision) {
            services.emit({ type: "completion", action: decision.action, reason: decision.reason });
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
          current = { ...request, input: inbox.splice(followUp, 1)[0].input };
        }
        const operations = await Promise.allSettled([...owned]);
        const rejected = operations.find((entry) => entry.status === "rejected");
        if (rejected?.status === "rejected") throw rejected.reason;
        ensureActive();
        lease.commit({ history: canonical, conversations, state, replayable });
        committed = true;
      } catch (error) {
        final = {
          text: "",
          status: controller.signal.aborted ? "cancelled" : error instanceof HarnessBudgetError ? "stopped" : "failed",
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
        acceptingOperations = false;
        await Promise.allSettled([...streams].map((stream) => stream.return(undefined)));
        await Promise.allSettled([...owned]);
        if (lease && !committed) {
          try {
            lease.commit({ history: canonical, conversations, state, replayable: false });
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
          lease?.release();
        } catch {
          cleanupDiagnostics.push("session_release_failed");
        }
        if (timer) clearTimeout(timer);
        callerSignal?.removeEventListener("abort", onAbort);
      }
      if (controller.signal.aborted)
        final = { ...final, status: "cancelled", reason: { code: "cancelled", message: "Cancellation acknowledged" } };
      const terminalResult: HarnessResult = {
        status: final.status ?? "completed",
        text: final.text,
        ...(final.structured !== undefined ? { structured: final.structured } : {}),
        ...(final.reason ? { reason: final.reason } : {}),
        ...(final.artifacts ? { artifacts: final.artifacts } : {}),
        usage: modelCalls ? usage : (final.usage ?? usage),
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
      runId,
      events: (options) => events.events(options),
      result: () => result.then((value) => structuredClone(value)),
      cancel,
      send: async (input, options) => {
        if (terminal || controller.signal.aborted) throw new Error("Run is no longer active");
        if (!config.driver.capabilities.controls.includes(options.mode))
          throw new HarnessUnsupportedError(options.mode);
        if (inbox.length >= 32) throw new Error("Run input queue is full");
        inbox.push({ input: structuredClone(input), mode: options.mode });
        events.append({ type: "control", operation: options.mode });
      },
    };
  }
}
