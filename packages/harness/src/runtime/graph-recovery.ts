import {
  type ChatMessage,
  type DurableAction,
  DurableActionLedger,
  DurableConflictError,
  type DurableGraphJournal,
  DurableGraphJournalError,
  type DurableJSON,
  DurableRecoveryRequiredError,
  durableDigest,
  type ExecutionServices,
  type ModelConfig,
  type ModelResponse,
  type RootExecutionController,
  RootExecutionError,
  type RootExecutionLease,
  RunContext,
  type ToolDef,
  type ToolDefinition,
  ToolExecutor,
  type ToolResult,
} from "@agentium/core";
import { z } from "zod/v3";
import { type HarnessExecutionServices, HarnessUnsupportedError } from "./driver.js";
import type { GraphBinding, GraphToolBinding } from "./graph-contracts.js";

/** Host-only bindings. Provider handles and executable callbacks never enter the journal. */
export interface GraphRecoveryPorts {
  invokeTool: NonNullable<ExecutionServices["invokeTool"]>;
  readonly rootExecution: RootExecutionController;
  readonly catalog: readonly GraphBinding[];
}
function invalid(message: string): never {
  throw new DurableGraphJournalError(message);
}

/** Copy finite data without invoking getters, accepting exotic objects or dropping undefined. */
function json(value: unknown, ancestors = new Set<object>(), depth = 0): DurableJSON {
  if (depth > 128) return invalid("Graph evidence exceeds the supported JSON depth");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || !value) return invalid("Graph evidence requires finite JSON");
  if (ancestors.has(value)) return invalid("Graph evidence cannot contain circular values");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length) return invalid("Graph evidence cannot contain symbol fields");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(descriptors).some((key) => key !== "length" && !/^(0|[1-9]\d*)$/.test(key)))
        return invalid("Graph arrays cannot contain extra fields");
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = descriptors[index];
        if (!descriptor || !("value" in descriptor)) return invalid("Graph arrays require concrete JSON values");
        return json(descriptor.value, ancestors, depth + 1);
      });
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      return invalid("Graph evidence cannot contain host objects");
    const output: Record<string, DurableJSON> = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (["__proto__", "constructor", "prototype"].includes(key) || !("value" in descriptor) || !descriptor.enumerable)
        return invalid("Graph evidence contains an unsafe field");
      output[key] = json(descriptor.value, ancestors, depth + 1);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}
function jsonObject(value: unknown): Record<string, DurableJSON> {
  const copied = json(value);
  if (!copied || typeof copied !== "object" || Array.isArray(copied)) return invalid("Expected a JSON object");
  return copied;
}
function defined(value: object): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) return invalid("Model evidence cannot contain accessors");
    if (descriptor.value !== undefined) result[key] = descriptor.value;
  }
  return result;
}
const jsonValue = z.unknown().transform((value) => json(value));
const jsonRecord = z.unknown().transform((value) => jsonObject(value));
const identifier = z.string().trim().min(1).max(512);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const probability = z.number().finite().min(0).max(1);
const toolCall = z.object({ id: identifier, name: identifier, arguments: jsonRecord }).strict();
const content = z.union([
  z.string(),
  z.null(),
  z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string() }).strict(),
      z
        .object({
          type: z.literal("image"),
          data: z.string(),
          mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]).optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("audio"),
          data: z.string(),
          mimeType: z.enum(["audio/mp3", "audio/wav", "audio/ogg", "audio/webm"]).optional(),
        })
        .strict(),
      z
        .object({ type: z.literal("file"), data: z.string(), mimeType: z.string(), filename: z.string().optional() })
        .strict(),
    ]),
  ),
]);
const extras = z
  .object({
    responsesReplay: z
      .object({
        version: z.literal(1),
        owner: identifier.refine((owner) => {
          try {
            const url = new URL(owner);
            return !url.username && !url.password && !url.search && !url.hash;
          } catch {
            return false;
          }
        }, "Replay ownership must exclude credentials and query strings"),
        model: identifier.optional(),
        items: z.array(jsonValue),
      })
      .strict()
      .optional(),
    responsesReasoning: z.array(jsonValue).optional(),
    anthropicContent: z.array(jsonValue).optional(),
    googleParts: z.array(jsonValue).optional(),
    reasoningContent: z.string().optional(),
    harnessContext: jsonRecord.optional(),
  })
  .strict();
const messageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content,
    phase: z.enum(["commentary", "final"]).optional(),
    toolCalls: z.array(toolCall).optional(),
    toolCallId: identifier.optional(),
    name: identifier.optional(),
    providerExtras: extras.optional(),
  })
  .strict();
const tokenCount = count.nullable();
const strings = z.record(z.string());
const billingContext = z
  .object({
    providerId: z.string().optional(),
    billingProviderId: z.string().optional(),
    modelId: z.string().optional(),
    api: z.string().optional(),
    occurredAt: z.string().optional(),
    requestedModelId: z.string().optional(),
    resourceId: z.string().optional(),
    accountId: z.string().optional(),
    contractId: z.string().optional(),
    region: z.string().optional(),
    requestedServiceTier: z.string().optional(),
    actualServiceTier: z.string().optional(),
    reasoningMode: z.string().optional(),
    reasoningEffort: z.string().optional(),
    inputTokens: count.optional(),
    providerRequestId: z.string().optional(),
    dimensions: strings.optional(),
    provenance: z
      .record(z.enum(["response", "request", "documented_default", "configured_contract", "unknown"]))
      .optional(),
  })
  .strict();
const accountingSchema = z
  .object({
    schemaVersion: z.literal(1),
    normalizerId: identifier,
    normalizerVersion: identifier,
    tokens: z
      .object({
        input: z
          .object({
            total: tokenCount,
            ordinary: tokenCount,
            cacheRead: tokenCount,
            cacheWrite: tokenCount,
            cacheWriteByTTL: z.array(z.object({ ttlSeconds: count, tokens: count }).strict()),
          })
          .strict(),
        output: z.object({ total: tokenCount, reasoning: tokenCount }).strict(),
        total: tokenCount,
        providerReportedTotal: tokenCount,
      })
      .strict()
      .nullable(),
    measurements: z.array(
      z
        .object({
          id: identifier,
          meter: identifier,
          unit: identifier,
          quantity: z.string().nullable(),
          dimensions: strings,
          source: z.enum(["provider", "derived", "measured", "estimated"]),
          evidencePaths: z.array(z.string()),
        })
        .strict(),
    ),
    coverage: z.object({ requiredMeters: z.array(z.string()), unsupportedFeatures: z.array(z.string()) }).strict(),
    issues: z.array(z.object({ code: z.string(), path: z.string().optional(), message: z.string() }).strict()),
    rawUsage: jsonValue.optional(),
    rawUsageTruncated: z.boolean().optional(),
    context: billingContext.optional(),
  })
  .strict();
const usageSchema = z
  .object({
    promptTokens: count,
    completionTokens: count,
    totalTokens: count,
    reasoningTokens: count.optional(),
    cachedTokens: count.optional(),
    cacheWriteTokens: count.optional(),
    audioInputTokens: count.optional(),
    audioOutputTokens: count.optional(),
    accounting: accountingSchema.optional(),
    providerMetrics: jsonRecord.optional(),
    pricingKey: z.string().optional(),
  })
  .strict()
  .superRefine((usage, context) => {
    if (
      usage.totalTokens < usage.promptTokens + usage.completionTokens ||
      (usage.reasoningTokens ?? 0) > usage.completionTokens ||
      (usage.cachedTokens ?? 0) + (usage.cacheWriteTokens ?? 0) > usage.promptTokens
    )
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Incoherent normalized model usage" });
  });
const answerBase = { name: z.string().nullable() };
const choiceValue = z.union([z.string(), z.boolean()]);
const decisionSchema = z.discriminatedUnion("type", [
  z.object({ ...answerBase, type: z.literal("predicate"), probability }).strict(),
  z
    .object({
      ...answerBase,
      type: z.literal("choice"),
      choice: choiceValue,
      confidence: probability,
      probabilities: z.array(z.object({ value: choiceValue, probability }).strict()),
    })
    .strict(),
  z
    .object({
      ...answerBase,
      type: z.literal("score"),
      score: z.number().finite().nonnegative(),
      confidence: probability,
      probabilities: z.array(z.object({ value: count, label: z.string(), probability }).strict()),
    })
    .strict(),
  z.object({ ...answerBase, type: z.literal("refusal") }).strict(),
]);
const responseSchema = z
  .object({
    message: messageSchema,
    usage: usageSchema,
    finishReason: z.enum(["stop", "tool_calls", "length", "content_filter"]),
    publicMessages: z
      .array(
        z
          .object({ id: identifier, phase: z.enum(["commentary", "final", "reasoning_summary"]), text: z.string() })
          .strict(),
      )
      .optional(),
    decisions: z.array(decisionSchema).optional(),
  })
  .strict()
  .superRefine((response, context) => {
    const calls = response.message.toolCalls ?? [];
    if (
      response.message.role !== "assistant" ||
      (response.finishReason === "tool_calls") !== calls.length > 0 ||
      new Set(calls.map((call) => call.id)).size !== calls.length ||
      response.message.toolCallId !== undefined
    )
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Incomplete or inconsistent assistant/tool response" });
  });
const resultSchema = z
  .object({
    content: z.string(),
    artifacts: z
      .array(z.object({ type: z.string(), data: jsonValue, mimeType: z.string().optional() }).strict())
      .optional(),
  })
  .strict();
function toolResult(value: unknown): string | ToolResult {
  if (typeof value === "string") return value;
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) return invalid("Recorded tool result is not a supported ToolResult");
  return parsed.data;
}
function domainResult(value: DurableJSON): string | ToolResult {
  if (typeof value === "string") return value;
  const native = resultSchema.safeParse(value);
  if (native.success) return native.data;
  return { content: JSON.stringify(value) };
}
function equivalentTool(approved: ToolDef, supplied: ToolDef): boolean {
  return (
    approved.name === supplied.name &&
    approved.execute === supplied.execute &&
    approved.parameters === supplied.parameters &&
    approved.requiresApproval === supplied.requiresApproval &&
    equivalentConfig(approved.sandbox, supplied.sandbox) &&
    approved.toModelOutput === supplied.toModelOutput &&
    equivalentConfig(approved.rawJsonSchema, supplied.rawJsonSchema) &&
    equivalentConfig(approved.cache, supplied.cache) &&
    approved.strict === supplied.strict
  );
}
function equivalentConfig(approved: unknown, supplied: unknown): boolean {
  if (approved === undefined || supplied === undefined) return approved === supplied;
  try {
    return durableDigest(json(approved)) === durableDigest(json(supplied));
  } catch {
    return false;
  }
}

const effectOriginSchema = z
  .object({
    type: z.literal("effect.origin"),
    schemaVersion: z.literal(1),
    actionId: identifier,
    nodeId: identifier,
    toolCallId: identifier,
    bindingId: identifier,
    bindingVersion: identifier,
    catalogDigest: identifier,
    definitionHash: identifier,
    manifestHash: identifier,
    inputDigest: identifier,
    connectorVersion: identifier,
    destination: identifier,
    preparedHash: identifier,
    idempotencyKey: identifier,
  })
  .strict();
function graphToolOperationId(nodeId: string, callId: string, binding: GraphToolBinding): string {
  return `${durableDigest(nodeId)}/tool/${durableDigest([callId, binding.id, binding.version]).slice(7)}`;
}
function origins(evidence: readonly DurableJSON[], actionId: string): DurableJSON[] {
  return evidence.filter(
    (row) =>
      row !== null &&
      typeof row === "object" &&
      !Array.isArray(row) &&
      row.type === "effect.origin" &&
      row.actionId === actionId,
  );
}

/** Resolve only the operation recorded before its ledger intent. Shared destinations
 * and connector versions do not identify an executable binding. */
export async function resolveGraphEffectBinding(
  journal: DurableGraphJournal,
  action: Readonly<DurableAction>,
  catalog: readonly GraphBinding[],
): Promise<GraphToolBinding> {
  json(action);
  action = structuredClone(action);
  const state = await journal.snapshot();
  const task = await journal.store.get(journal.key);
  const records = origins(state.evidence, action.id);
  if (!task || records.length !== 1) return invalid("Durable graph effect requires one persisted origin");
  const parsed = effectOriginSchema.safeParse(records[0]);
  if (!parsed.success) return invalid("Corrupt durable graph effect origin");
  const origin = parsed.data;
  const candidates = catalog.filter(
    (binding) => binding.id === origin.bindingId && binding.version === origin.bindingVersion,
  );
  const binding = candidates[0];
  if (candidates.length !== 1 || binding?.kind !== "tool" || !binding.recovery || binding.recovery === "pure")
    return invalid("Durable graph effect originating binding is missing or changed");
  const stored = task.actions[action.id];
  const preparedHash = durableDigest({
    connectorVersion: action.connectorVersion,
    destination: action.destination,
    args: json(action.args),
    policyRevision: action.policyRevision,
    grantRefs: action.grantRefs,
    identity: task.identity,
  });
  const idempotencyKey = durableDigest([task.identity.tenantId, task.id, action.id, preparedHash]);
  if (
    origin.actionId !== graphToolOperationId(origin.nodeId, origin.toolCallId, binding) ||
    origin.catalogDigest !== state.definition.catalogDigest ||
    origin.definitionHash !== state.definitionHash ||
    origin.manifestHash !== task.manifestHash ||
    origin.inputDigest !== durableDigest(json(action.args)) ||
    origin.connectorVersion !== action.connectorVersion ||
    origin.connectorVersion !== binding.recovery.connector.version ||
    origin.destination !== action.destination ||
    origin.destination !== binding.recovery.destination ||
    origin.preparedHash !== preparedHash ||
    action.preparedHash !== preparedHash ||
    origin.idempotencyKey !== idempotencyKey ||
    action.idempotencyKey !== idempotencyKey ||
    !stored ||
    stored.preparedHash !== preparedHash ||
    stored.idempotencyKey !== idempotencyKey ||
    durableDigest(json(stored.args)) !== origin.inputDigest
  )
    return invalid("Durable graph effect origin, input or catalog identity mismatch");
  return binding;
}

async function retainEffectOrigin(
  journal: DurableGraphJournal,
  nodeId: string,
  callId: string,
  binding: GraphToolBinding,
  input: Record<string, DurableJSON>,
): Promise<void> {
  if (!binding.recovery || binding.recovery === "pure") return invalid("Effect requires its host recovery binding");
  const task = await journal.store.get(journal.key);
  if (!task) return invalid("Durable graph effect task does not exist");
  const actionId = graphToolOperationId(nodeId, callId, binding);
  const preparedHash = durableDigest({
    connectorVersion: binding.recovery.connector.version,
    destination: binding.recovery.destination,
    args: input,
    policyRevision: task.policyRevision,
    grantRefs: task.grantRefs,
    identity: task.identity,
  });
  const originFields = {
    type: "effect.origin",
    schemaVersion: 1,
    actionId,
    nodeId,
    toolCallId: callId,
    bindingId: binding.id,
    bindingVersion: binding.version,
    catalogDigest: journal.definition.catalogDigest,
    manifestHash: task.manifestHash,
    inputDigest: durableDigest(input),
    connectorVersion: binding.recovery.connector.version,
    destination: binding.recovery.destination,
    preparedHash,
    idempotencyKey: durableDigest([task.identity.tenantId, task.id, actionId, preparedHash]),
  };
  await journal.mutate((state) => {
    const origin = json(effectOriginSchema.parse({ ...originFields, definitionHash: state.definitionHash }));
    const existing = origins(state.evidence, actionId);
    if (existing.length > 1 || (existing.length === 1 && durableDigest(existing[0]) !== durableDigest(origin)))
      return invalid("Durable graph effect originating binding changed");
    if (!existing.length) state.evidence.push(origin);
  });
}

/** Parse raw content first, so a string schema preserves numeric-looking strings.
 * JSON content is decoded only when the host output schema requires another type.
 * Returns domain output; the port stores raw results so transforms are never composed. */
export function graphToolOutput(binding: GraphToolBinding, result: string | ToolResult): DurableJSON {
  const raw = typeof result === "string" ? result : result.content;
  try {
    return json(binding.output.parse(raw));
  } catch (original) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      throw original;
    }
    return json(binding.output.parse(decoded));
  }
}

export function createGraphRecoveryPorts(
  journal: DurableGraphJournal,
  root: RootExecutionController,
  catalog: readonly GraphBinding[],
): GraphRecoveryPorts {
  return {
    rootExecution: root,
    catalog: [...catalog],
    async invokeTool(tool, call, args, context, execute) {
      const nodeId = identifier.parse(context.metadata.executionGraphNodeId);
      if (context.rootExecution !== root) return invalid("Graph tool does not share its root controller");
      const candidates = catalog.filter(
        (binding): binding is GraphToolBinding => binding.kind === "tool" && equivalentTool(binding.tool, tool),
      );
      if (candidates.length !== 1) return invalid("Tool is not an unambiguous approved catalog binding");
      const binding = candidates[0];
      binding.input.parse(call.arguments);
      const input = jsonObject(args);
      const operationId = graphToolOperationId(nodeId, call.id, binding);
      if (binding.recovery === "pure") {
        const raw = await journal.node(
          operationId,
          { id: binding.id, version: binding.version, kind: "tool" },
          input,
          async () => {
            const result = toolResult(await execute());
            graphToolOutput(binding, result);
            return json(result);
          },
        );
        const result = toolResult(raw);
        graphToolOutput(binding, result);
        return result;
      }
      if (!binding.recovery) return invalid("Graph tools require an approved recovery binding");
      const recovery = binding.recovery;
      await retainEffectOrigin(journal, nodeId, call.id, binding, input);
      const signal = context.signal ? AbortSignal.any([root.signal, context.signal]) : root.signal;
      const ledger = new DurableActionLedger(journal.store, journal.key, journal.fence, signal);
      const actionInput = {
        id: operationId,
        connectorVersion: recovery.connector.version,
        destination: recovery.destination,
        args: input,
      };
      let action = await ledger.prepare(actionInput);
      await resolveGraphEffectBinding(journal, action, catalog);
      if (["executing", "unknown"].includes(action.state)) {
        try {
          action = await ledger.reconcile(operationId, recovery.connector);
        } catch (error) {
          if (
            error instanceof DurableConflictError ||
            error instanceof DurableRecoveryRequiredError ||
            error instanceof RootExecutionError ||
            (error instanceof Error && error.name === "AbortError")
          )
            throw error;
          const unresolved = new DurableRecoveryRequiredError();
          unresolved.cause = error;
          throw unresolved;
        }
      }
      if (["executing", "unknown"].includes(action.state)) throw new DurableRecoveryRequiredError();
      let lease: RootExecutionLease | undefined;
      try {
        // Admission denial/cancellation leaves a prepared action known not dispatched.
        // Confirmed replay and reconciliation own no remote dispatch permit.
        if (action.state === "prepared") lease = await root.acquire("tool", operationId, signal);
        const settle = () =>
          journal.effect(
            actionInput,
            {
              version: recovery.connector.version,
              reconcile: recovery.connector.reconcile?.bind(recovery.connector),
              dispatch: (current, dispatchSignal) => {
                if (!lease) return invalid("Durable graph effect dispatch requires prior root admission");
                return recovery.connector.dispatch(current, dispatchSignal ?? signal);
              },
            },
            async (reference) => {
              const raw = json(await recovery.resolveResult(reference));
              const result = domainResult(raw);
              graphToolOutput(binding, result);
              return json(result);
            },
            signal,
          );
        const result = lease ? await lease.run(settle) : await settle();
        const raw = toolResult(result);
        graphToolOutput(binding, raw);
        return raw;
      } finally {
        await lease?.release();
      }
    },
  };
}

const allowedOptions = new Set([
  "deadline",
  "callTimeoutMs",
  "billingContext",
  "temperature",
  "maxTokens",
  "topP",
  "stop",
  "responseFormat",
  "reasoning",
  "providerOptions",
  "questions",
  "tools",
]);
function modelRequest(
  provider: { providerId: string; modelId: string },
  messages: readonly ChatMessage[],
  options: ModelConfig & { tools?: ToolDefinition[] },
): DurableJSON {
  const safe = defined(options);
  delete safe.apiKey;
  delete safe.signal;
  if (Object.keys(safe).some((key) => !allowedOptions.has(key))) return invalid("Unsupported durable model option");
  const normalized = messages.map((message) => messageSchema.parse(defined(message)));
  return json({
    providerId: identifier.parse(provider.providerId),
    modelId: identifier.parse(provider.modelId),
    messages: normalized,
    options: safe,
  });
}
function normalizeResponse(response: ModelResponse): DurableJSON {
  const normalized = responseSchema.parse({
    message: defined(response.message),
    usage: defined(response.usage),
    finishReason: response.finishReason,
    ...(response.publicMessages !== undefined ? { publicMessages: response.publicMessages } : {}),
    ...(response.decisions !== undefined ? { decisions: response.decisions } : {}),
  });
  return json(normalized);
}

/** One instance per node attempt; model indexes reproduce the recorded decision sequence. */
export function scopeGraphServices(
  base: HarnessExecutionServices,
  nodeId: string,
  approvedToolBindingIds: readonly string[],
  ports: GraphRecoveryPorts,
  journal: DurableGraphJournal,
): HarnessExecutionServices {
  identifier.parse(nodeId);
  if (new Set(approvedToolBindingIds).size !== approvedToolBindingIds.length)
    return invalid("Duplicate approved graph tool binding");
  const tools = approvedToolBindingIds.map((id) => {
    const binding = ports.catalog.find((binding) => binding.id === id);
    if (binding?.kind !== "tool") return invalid("Unknown approved graph tool binding");
    return binding.tool;
  });
  let modelIndex = 0;
  let executor: ToolExecutor;
  const scoped: HarnessExecutionServices & { ctx: RunContext } = {
    ...base,
    ctx: base.ctx,
    rootExecution: ports.rootExecution,
    tools,
    get budget() {
      return base.budget;
    },
    get history() {
      return base.history;
    },
    get archivedHistory() {
      return base.archivedHistory;
    },
    invokeTool: async (tool, call, args, context, execute) => {
      if (context.metadata.executionGraphNodeId !== nodeId || !tools.some((approved) => equivalentTool(approved, tool)))
        return invalid("Tool is outside its graph node scope");
      // The host bridge persists admission and budget reservations before it
      // delegates to these journal ports. Calling the port directly loses that fence.
      return base.invokeTool
        ? base.invokeTool(tool, call, args, context, execute)
        : ports.invokeTool(tool, call, args, context, execute);
    },
    async model(provider, messages, options = {}, context) {
      const callContext = context ?? scoped.ctx;
      if (callContext.metadata.executionGraphNodeId !== nodeId) return invalid("Model is outside its graph node scope");
      const request = modelRequest(provider, messages, options);
      const id = `${nodeId}/model/${modelIndex++}`;
      const saved = await journal.model(id, request, async () =>
        normalizeResponse(await base.model(provider, messages, options, callContext)),
      );
      const response = responseSchema.parse(saved);
      return { ...response, raw: { graphJournal: id } };
    },
    // biome-ignore lint/correctness/useYield: This unsupported port must reject before opening a provider stream.
    async *streamModel() {
      throw new HarnessUnsupportedError("Agent graph streaming requires complete recorded model decisions");
    },
    dispatch: (call) =>
      base.runOwned(async () => {
        const [result] = await executor.executeAll([call], scoped.ctx);
        await base.observeTool(result, scoped.ctx);
        return result;
      }),
  };
  const metadata = Object.freeze({ ...base.ctx.metadata, executionGraphNodeId: nodeId });
  scoped.ctx = new RunContext({
    ...base.ctx,
    runId: nodeId,
    metadata,
    rootExecution: ports.rootExecution,
    executionServices: scoped,
  });
  executor = new ToolExecutor(tools, {
    executionPolicy: scoped.ctx.executionPolicy,
    approvalManager: base.approvalManager,
  });
  return scoped;
}
