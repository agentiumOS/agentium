import { randomUUID } from "node:crypto";
import { configuredBillingContext, mergeBillingContext } from "../models/billing-context.js";
import type { ModelProvider } from "../models/provider.js";
import type {
  ChatMessage,
  ModelConfig,
  ModelResponse,
  StreamChunk,
  TokenUsage,
  ToolDefinition,
} from "../models/types.js";
import { normalizeLegacyUsage, projectTokenUsage } from "../models/usage-normalizers.js";
import type {
  BillingContext,
  ExecutionStatus,
  NormalizedUsage,
  RunCostSnapshot,
  UsageObservation,
} from "./accounting-types.js";
import {
  type AccountingContext,
  getAccountingContext,
  type UsageEvidence,
  withAccountingContext,
  withUsageEvidence,
} from "./context.js";

import { selectedObservationUsage } from "./ledger.js";

type ModelOptions = ModelConfig & { tools?: ToolDefinition[] };

/** A denied admission is not a retryable model failure. */
export class AccountingBudgetError extends Error {
  readonly retryable = false;
  readonly code = "ACCOUNTING_BUDGET_EXCEEDED";
  constructor(readonly reason?: string) {
    super(`Cost budget blocked this request${reason ? `: ${reason}` : ""}`);
    this.name = "AccountingBudgetError";
  }
}

/** Unknown usage is retained as unknown, including for failures before a response. */
export function unknownUsage(reason = "provider_usage_missing"): NormalizedUsage {
  return {
    schemaVersion: 1,
    normalizerId: "agentium.unknown",
    normalizerVersion: "1",
    tokens: null,
    measurements: [],
    coverage: { requiredMeters: ["operation.unknown"], unsupportedFeatures: [reason] },
    issues: [{ code: reason, message: "The adapter did not supply complete billing evidence." }],
  };
}

/** A run snapshot never retries provider work when accounting storage is unavailable. */
export async function getRunCostSnapshot(scope: AccountingContext): Promise<RunCostSnapshot> {
  try {
    return {
      status: "available",
      ...(await scope.tracker.queryCosts({
        tenantId: scope.tenantId,
        runId: scope.runId,
        rootRunId: scope.rootRunId,
        includeChildren: true,
      })),
    };
  } catch (error) {
    reportAccountingError(scope, `run:${scope.runId ?? "unknown"}:snapshot`, error);
    return {
      status: "unavailable",
      currency: scope.tracker.currency,
      total: null,
      knownSubtotal: null,
      reason: "accounting_unavailable",
    };
  }
}

/** Legacy custom adapters expose display counts only; cache and billing semantics remain unspecified. */
function normalizedUsage(usage?: TokenUsage, providerId = "custom", modelId = "unknown"): NormalizedUsage {
  if (usage?.accounting) return usage.accounting;
  if (usage) return normalizeLegacyUsage(usage, providerId, modelId);
  return unknownUsage("adapter_normalizer_missing");
}

function usageFromError(error: unknown): TokenUsage | undefined {
  if (!error || typeof error !== "object" || !("usage" in error)) return;
  const usage = error.usage;
  if (
    usage &&
    typeof usage === "object" &&
    "promptTokens" in usage &&
    "completionTokens" in usage &&
    "totalTokens" in usage &&
    typeof usage.promptTokens === "number" &&
    typeof usage.completionTokens === "number" &&
    typeof usage.totalTokens === "number"
  )
    return usage as TokenUsage;
}

function reportAccountingError(scope: AccountingContext, attemptId: string, error: unknown): void {
  scope.eventBus?.emit("accounting.error", { runId: scope.runId, attemptId, error });
  try {
    scope.onAccountingError?.(error);
  } catch {
    /* Observers cannot change provider execution. */
  }
}

async function admit(
  scope: AccountingContext,
  attemptId: string,
  context: BillingContext,
  visibility: "physical" | "opaque" = "opaque",
) {
  const decision = await scope.tracker.checkBudget({ ...scope, attemptId });
  scope.eventBus?.emit("budget.checked", { runId: scope.runId, attemptId, decision });
  if (decision.status === "blocked") throw new AccountingBudgetError(decision.reason);
  try {
    await scope.tracker.startAttempt({
      tenantId: scope.tenantId,
      runId: scope.runId,
      rootRunId: scope.rootRunId,
      parentRunId: scope.parentRunId,
      ancestorRunIds: scope.ancestorRunIds,
      sessionId: scope.sessionId,
      userId: scope.userId,
      agentName: scope.agentName,
      operationId: scope.operationId ?? attemptId,
      parentOperationId: scope.parentOperationId,
      attemptId,
      context,
      attemptVisibility: visibility,
    });
  } catch (error) {
    if (decision.reservationId)
      await scope.tracker.releaseReservation(scope.tenantId ?? "local", decision.reservationId, true);
    throw error;
  }
  return decision.reservationId;
}

async function settle(
  scope: AccountingContext,
  attemptId: string,
  context: BillingContext,
  usage: NormalizedUsage,
  status: ExecutionStatus,
  visibility: "physical" | "opaque",
  reservationId?: string,
  observation?: { id: string; sequence: number; kind: "snapshot" | "delta"; finality: "provisional" | "final" },
): Promise<void> {
  try {
    const assessment = await scope.tracker.recordUsage({
      tenantId: scope.tenantId,
      runId: scope.runId,
      rootRunId: scope.rootRunId,
      parentRunId: scope.parentRunId,
      ancestorRunIds: scope.ancestorRunIds,
      sessionId: scope.sessionId,
      userId: scope.userId,
      agentName: scope.agentName,
      operationId: scope.operationId ?? attemptId,
      parentOperationId: scope.parentOperationId,
      attemptId,
      context: mergeBillingContext(context, usage.context),
      usage,
      executionStatus: status,
      attemptVisibility: visibility,
      observationId: observation?.id ?? `${attemptId}:terminal`,
      sequence: observation?.sequence,
      observationKind: observation?.kind,
      finality: observation?.finality,
      purpose: scope.purpose,
      reservationId,
    });
    scope.eventBus?.emit("usage.recorded", {
      runId: scope.runId,
      attemptId,
      operationId: scope.operationId ?? attemptId,
      usageRevision: assessment.usageRevision,
      usageStatus: assessment.usageStatus,
    });
    scope.eventBus?.emit("cost.assessed", { runId: scope.runId, assessment });
    if (scope.runId && scope.agentName) {
      const total = await scope.tracker.queryCosts({ tenantId: scope.tenantId, runId: scope.runId });
      if (total.total !== null && total.currency === "USD")
        scope.eventBus?.emit("cost.tracked", {
          runId: scope.runId,
          agentName: scope.agentName,
          modelId: context.modelId,
          usage: await scope.tracker.queryRunUsage({ tenantId: scope.tenantId, runId: scope.runId }),
          cost: Number(total.total),
        });
    }
  } catch (error) {
    // A successful provider call must never be repeated because accounting failed.
    reportAccountingError(scope, attemptId, error);
  }
}

function operationScope(parent: AccountingContext, purpose?: string, operationId?: string): AccountingContext {
  return {
    ...parent,
    operationId: operationId ?? randomUUID(),
    parentOperationId: parent.operationId,
    purpose: purpose ?? parent.purpose ?? "model",
  };
}

async function startModelAttempt(scope: AccountingContext, context: BillingContext, visibility: "physical" | "opaque") {
  let attemptId = randomUUID();
  let reservationId = await admit(scope, attemptId, context, visibility);
  let open = true;
  let sequence = 0;
  let lastPayload: string | undefined;
  let cumulativeUsage: TokenUsage | undefined;
  let observations: UsageObservation[] = [];
  const delivered = new Map<string, string>();
  const lifecycleId = `model-lifecycle:${scope.tenantId ?? "local"}:${attemptId}`;
  scope.tracker.beginPendingAttempt(lifecycleId);
  const evidence: UsageEvidence = {};
  const terminal = (status: ExecutionStatus) =>
    settle(
      scope,
      attemptId,
      context,
      normalizedUsage(evidence.usage, context.providerId, context.modelId),
      status,
      visibility,
      reservationId,
      {
        id: `${attemptId}:terminal`,
        sequence: ++sequence,
        kind: "snapshot",
        finality: status === "succeeded" ? "final" : "provisional",
      },
    );
  evidence.onRetry = async (error) => {
    if (!open) return;
    evidence.usage = usageFromError(error) ?? evidence.usage;
    await terminal("failed");
    open = false;
    evidence.usage = undefined;
    observations = [];
    delivered.clear();
    lastPayload = undefined;
    cumulativeUsage = undefined;
    sequence = 0;
    const nextId = randomUUID();
    context = { ...context, occurredAt: new Date().toISOString() };
    const nextReservation = await admit(scope, nextId, context, visibility);
    attemptId = nextId;
    reservationId = nextReservation;
    open = true;
  };
  return {
    evidence,
    observe: async (
      value: TokenUsage,
      metadata?: { kind: "snapshot" | "delta"; id: string; sequence: number },
    ): Promise<TokenUsage> => {
      const normalized = normalizedUsage(value, context.providerId, context.modelId);
      const usage = { ...normalized, context: mergeBillingContext(context, normalized.context) };
      const payload = JSON.stringify(usage);
      if (!metadata && payload === lastPayload) {
        evidence.usage = cumulativeUsage ?? value;
        return evidence.usage;
      }
      const kind = metadata?.kind ?? "snapshot";
      if (metadata && (!metadata.id || !Number.isSafeInteger(metadata.sequence) || metadata.sequence < 1))
        throw Object.assign(new Error("Invalid stream usage observation identity"), { retryable: false });
      const eventId = metadata?.id ?? `snapshot:${sequence + 1}`;
      const previous = delivered.get(eventId);
      if (previous !== undefined) {
        if (previous !== JSON.stringify([metadata?.sequence, kind, payload]))
          throw Object.assign(new Error("Conflicting stream usage observation"), { retryable: false });
        evidence.usage = cumulativeUsage ?? value;
        return evidence.usage;
      }
      const nextSequence = metadata?.sequence ?? sequence + 1;
      sequence = Math.max(sequence, nextSequence);
      const id = `${attemptId}:${eventId}`;
      delivered.set(eventId, JSON.stringify([metadata?.sequence, kind, payload]));
      lastPayload = payload;
      observations.push({
        tenantId: scope.tenantId ?? "local",
        attemptId,
        operationId: scope.operationId ?? attemptId,
        context,
        usage,
        executionStatus: "unknown",
        observationId: id,
        sequence: nextSequence,
        observationKind: kind,
        observedAt: context.occurredAt,
      });
      cumulativeUsage = { ...value, ...projectTokenUsage(selectedObservationUsage(observations).usage) };
      evidence.usage = cumulativeUsage;
      // Keep the reservation intact while usage is provisional. The terminal observation settles it.
      await settle(scope, attemptId, context, usage, "unknown", visibility, undefined, {
        id,
        sequence: nextSequence,
        kind,
        finality: "provisional",
      });
      const decision = await scope.tracker.checkBudgetAfterUsage(scope);
      scope.eventBus?.emit("budget.checked", { runId: scope.runId, attemptId, decision });
      if (decision.status === "blocked") throw new AccountingBudgetError(decision.reason);
      return evidence.usage;
    },
    finish: async (status: ExecutionStatus) => {
      try {
        if (open) await terminal(status);
      } finally {
        scope.tracker.endPendingAttempt(lifecycleId);
      }
    },
  };
}

/** Meter an adapter invocation. Built-in composites meter their leaves, never their summary. */
export async function meteredGenerate(
  provider: ModelProvider,
  messages: ChatMessage[],
  options?: ModelOptions,
  purpose?: string,
  operationId?: string,
): Promise<ModelResponse> {
  const defaults = configuredBillingContext(options?.billingContext);
  const parent = getAccountingContext();
  if (!parent) return provider.generate(messages, options);
  if (provider.accountingRole === "composite")
    return withAccountingContext(operationScope(parent, purpose, operationId), () =>
      provider.generate(messages, options),
    );
  const scope = operationScope(parent, purpose, operationId);
  let status: ExecutionStatus = "failed";
  const context: BillingContext = {
    providerId: provider.providerId,
    billingProviderId: provider.providerId,
    modelId: provider.modelId,
    requestedModelId: provider.modelId,
    api: "unknown",
    occurredAt: new Date().toISOString(),
    reasoningMode: options?.reasoning?.mode,
    reasoningEffort: options?.reasoning?.effort,
    ...defaults,
  };
  options?.signal?.throwIfAborted();
  const attempt = await startModelAttempt(scope, context, provider.attemptVisibility ?? "opaque");
  const evidence = attempt.evidence;
  try {
    const response = await withAccountingContext(scope, () =>
      withUsageEvidence(evidence, () => provider.generate(messages, options)),
    );
    const accountedResponse = response.usage.accounting
      ? {
          ...response,
          usage: {
            ...response.usage,
            accounting: {
              ...response.usage.accounting,
              context: mergeBillingContext(context, response.usage.accounting.context),
            },
          },
        }
      : response;
    evidence.usage = accountedResponse.usage;
    status = options?.signal?.aborted ? "cancelled" : "succeeded";
    return accountedResponse;
  } catch (error) {
    evidence.usage = usageFromError(error) ?? evidence.usage;
    status = options?.signal?.aborted ? "cancelled" : "failed";
    throw error;
  } finally {
    await attempt.finish(status);
  }
}

/** Read through transport close: content finish is not authoritative final usage. */
export async function* meteredStream(
  provider: ModelProvider,
  messages: ChatMessage[],
  options?: ModelOptions,
  purpose?: string,
): AsyncGenerator<StreamChunk> {
  const defaults = configuredBillingContext(options?.billingContext);
  const parent = getAccountingContext();
  if (!parent) {
    yield* provider.stream(messages, options);
    return;
  }
  const scope = operationScope(parent, purpose);
  if (provider.accountingRole === "composite") {
    const iterator = provider.stream(messages, options);
    try {
      while (true) {
        const next = await withAccountingContext(scope, () => iterator.next());
        if (next.done) return;
        yield next.value;
      }
    } finally {
      await withAccountingContext(scope, () => iterator.return(undefined));
    }
  }
  const context: BillingContext = {
    providerId: provider.providerId,
    billingProviderId: provider.providerId,
    modelId: provider.modelId,
    requestedModelId: provider.modelId,
    api: "unknown",
    occurredAt: new Date().toISOString(),
    reasoningMode: options?.reasoning?.mode,
    reasoningEffort: options?.reasoning?.effort,
    ...defaults,
  };
  options?.signal?.throwIfAborted();
  const attempt = await startModelAttempt(scope, context, provider.attemptVisibility ?? "opaque");
  const evidence = attempt.evidence;
  let status: ExecutionStatus = "cancelled";
  const iterator = provider.stream(messages, options);
  let originalFailure: unknown;
  let failed = false;
  const close = async () => {
    try {
      await withAccountingContext(scope, () => withUsageEvidence(evidence, () => iterator.return(undefined)));
    } catch (error) {
      status = options?.signal?.aborted ? "cancelled" : "failed";
      if (failed)
        throw new AggregateError([originalFailure, error], "Model stream and cleanup failed", {
          cause: originalFailure,
        });
      throw error;
    } finally {
      await attempt.finish(status);
    }
  };
  try {
    while (true) {
      const next = await withAccountingContext(scope, () => withUsageEvidence(evidence, () => iterator.next()));
      if (next.done) {
        status = options?.signal?.aborted ? "cancelled" : "succeeded";
        break;
      }
      if (next.value.type === "finish" && next.value.usage) {
        const cumulative = await attempt.observe(next.value.usage, next.value.usageObservation);
        yield { ...next.value, usage: cumulative, usageObservation: undefined };
      } else yield next.value;
    }
  } catch (error) {
    originalFailure = error;
    failed = true;
    evidence.usage = usageFromError(error) ?? evidence.usage;
    status = options?.signal?.aborted ? "cancelled" : "failed";
    throw error;
  } finally {
    await close();
  }
}

export interface MeteredOperationOptions {
  context: BillingContext;
  accounting?: AccountingContext;
  purpose?: string;
  attemptVisibility?: "physical" | "opaque";
  signal?: AbortSignal;
}

/** Record embeddings, reranking and paid custom tools without changing their return shape.
 * Call capture before local parsing. Uncaptured usage remains visibly unpriced.
 */
export async function meteredOperation<T>(
  options: MeteredOperationOptions,
  execute: (capture: (usage: NormalizedUsage) => void) => Promise<T>,
): Promise<T> {
  const parent = options.accounting ?? getAccountingContext();
  if (!parent) return execute(() => {});
  const scope = operationScope(parent, options.purpose ?? options.context.api);
  const attemptId = randomUUID();
  const reservationId = await admit(scope, attemptId, options.context, options.attemptVisibility);
  let usage = unknownUsage();
  let status: ExecutionStatus = "failed";
  try {
    const result = await withAccountingContext(scope, () =>
      execute((value) => {
        usage = value;
      }),
    );
    status = options.signal?.aborted ? "cancelled" : "succeeded";
    return result;
  } catch (error) {
    status = options.signal?.aborted ? "cancelled" : "failed";
    throw error;
  } finally {
    await settle(
      scope,
      attemptId,
      options.context,
      usage,
      status,
      options.attemptVisibility ?? "opaque",
      reservationId,
    );
  }
}

/** Purpose-tagged invocation for auxiliary work such as compaction or memory extraction. */
export function meteredGenerateFor(
  purpose: string,
  provider: ModelProvider,
  messages: ChatMessage[],
  options?: ModelOptions,
): Promise<ModelResponse> {
  return meteredGenerate(provider, messages, options, purpose);
}

/** Record usage emitted by a provider-owned realtime operation. Admission must precede submission. */
export async function recordObservedUsage(
  scope: AccountingContext,
  context: BillingContext,
  usage: TokenUsage,
  options: { attemptId?: string; executionStatus?: ExecutionStatus } = {},
): Promise<void> {
  const attemptId = options.attemptId ?? randomUUID();
  await settle(
    { ...scope, operationId: scope.operationId ?? attemptId },
    attemptId,
    context,
    normalizedUsage(usage, context.providerId, context.modelId),
    options.executionStatus ?? "succeeded",
    "opaque",
  );
}

/** Keep an attempt open for a streaming resource. Finish it once on close, failure, or cancellation. */
export async function beginMeteredOperation(
  options: MeteredOperationOptions,
): Promise<{ capture: (usage: NormalizedUsage) => void; finish: (status?: ExecutionStatus) => Promise<void> }> {
  const parent = options.accounting ?? getAccountingContext();
  if (!parent) return { capture: () => {}, finish: async () => {} };
  const scope = operationScope(parent, options.purpose ?? options.context.api);
  const attemptId = randomUUID();
  const reservationId = await admit(scope, attemptId, options.context, options.attemptVisibility);
  let usage = unknownUsage();
  let finished = false;
  return {
    capture: (value) => {
      if (!finished) usage = value;
    },
    finish: async (status = "succeeded") => {
      if (finished) return;
      finished = true;
      await settle(
        scope,
        attemptId,
        options.context,
        usage,
        status,
        options.attemptVisibility ?? "opaque",
        reservationId,
      );
    },
  };
}

/** Give host execution services a metered provider without mutating the shared adapter. */
export function createMeteredProvider(provider: ModelProvider, purpose?: string): ModelProvider {
  return {
    providerId: provider.providerId,
    modelId: provider.modelId,
    accountingRole: "composite",
    communicationCapabilities: provider.communicationCapabilities,
    generate: (messages, options) =>
      meteredGenerate(provider, messages, options, purpose, getAccountingContext()?.operationId),
    stream: (messages, options) => meteredStream(provider, messages, options, purpose),
  };
}
