import {
  type ChatMessage,
  countConversationTokens,
  countTokens,
  type ModelProvider,
  type TokenUsage,
  type ToolDefinition,
} from "@agentium/core";
import { z } from "zod";

export class HarnessBudgetError extends Error {
  readonly code = "budget_exhausted";
  constructor(message: string) {
    super(message);
  }
}
export interface HarnessBudgets {
  maxModelCalls?: number;
  maxToolCalls?: number;
  /** Aggregate prompt + completion tokens for this run, including independent control/finishing calls. */
  maxTokens?: number;
  maxRevisions?: number;
  /** Protected portion of maxTokens, not an additional allowance. */
  finishingTokens?: number;
  /** Protected portion of maxModelCalls. Finishing operations are tool-free. */
  finishingModelCalls?: number;
}
export interface HarnessResourceSnapshot {
  /** null means unlimited. All other quantities use this resource's units. */
  limit: number | null;
  used: number;
  reserved: number;
  remaining: number | null;
  finishingReserved: number;
  ordinaryRemaining: number | null;
}
export interface HarnessBudgetSnapshot {
  tokens: HarnessResourceSnapshot;
  /** Logical calls, not HTTP attempts or SDK retries. */
  modelCalls: HarnessResourceSnapshot;
  toolCalls: HarnessResourceSnapshot;
  /** Calls charged at their projection because complete provider usage was unavailable. */
  unknownUsageCalls: number;
}
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const budgetStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    limits: z
      .object({
        maxModelCalls: counter.optional(),
        maxToolCalls: counter.optional(),
        maxTokens: counter.optional(),
        maxRevisions: counter.optional(),
        finishingTokens: counter.optional(),
        finishingModelCalls: counter.optional(),
      })
      .strict(),
    usedTokens: counter,
    reservedTokens: counter,
    usedCalls: counter,
    reservedCalls: counter,
    usedTools: counter,
    activeCalls: counter,
    finishingTokens: counter,
    finishingCalls: counter,
    pendingFinishingTokens: counter,
    pendingFinishingCalls: counter,
    unknownUsageCalls: counter,
    toolAdmissionIds: z.array(z.string().min(1)).refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();
export type HarnessBudgetState = z.infer<typeof budgetStateSchema>;
export function parseHarnessBudgetState(value: unknown): HarnessBudgetState {
  return budgetStateSchema.parse(value);
}
function limitsKey(limits: HarnessBudgets): string {
  return JSON.stringify(
    Object.entries(limits)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}
export type InputTokenEstimator = (input: {
  provider: ModelProvider;
  messages: readonly ChatMessage[];
  tools: readonly ToolDefinition[];
}) => number;
/** Advisory projection; use a conservative host estimator for a hard provider-specific bound. */
export const estimateInputTokens: InputTokenEstimator = ({ messages, tools }) =>
  countConversationTokens([...messages]) + (tools.length ? countTokens(JSON.stringify(tools)) : 0);

export function validateHarnessBudgets(limits: HarnessBudgets): void {
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value < 0)
      throw new TypeError("Harness budgets must be nonnegative safe integers");
  for (const [reserve, total] of [
    [limits.finishingTokens, limits.maxTokens],
    [limits.finishingModelCalls, limits.maxModelCalls],
  ])
    if (reserve && (total === undefined || reserve > total))
      throw new TypeError("Finishing capacity must fit within a finite total budget");
}
function resource(
  limit: number | undefined,
  used: number,
  reserved: number,
  protectedAmount = 0,
): HarnessResourceSnapshot {
  const remaining = limit === undefined ? null : Math.max(0, limit - used - reserved);
  const finishingReserved = Math.min(protectedAmount, remaining ?? Infinity);
  return {
    limit: limit ?? null,
    used,
    reserved,
    remaining,
    finishingReserved,
    ordinaryRemaining: remaining === null ? null : Math.max(0, remaining - finishingReserved),
  };
}
/** All admission and settlement mutations are synchronous; one ledger is shared by every run operation. */
export class HarnessBudgetLedger {
  private usedTokens = 0;
  private reservedTokens = 0;
  private usedCalls = 0;
  private reservedCalls = 0;
  private usedTools = 0;
  private finishingTokens = 0;
  private finishingCalls = 0;
  private pendingFinishingTokens = 0;
  private pendingFinishingCalls = 0;
  private unknownUsageCalls = 0;
  private activeCalls = 0;
  private activeReservedTokens = 0;
  private activeFinishingTokens = 0;
  private toolAdmissionIds = new Set<string>();
  constructor(
    private limits: HarnessBudgets = {},
    restored?: HarnessBudgetState,
  ) {
    validateHarnessBudgets(limits);
    if (restored) {
      const state = parseHarnessBudgetState(restored);
      if (limitsKey(limits) !== limitsKey(state.limits)) throw new Error("Durable budget limits changed");
      // An interrupted reservation may have been billed. Never replenish it on recovery.
      this.usedTokens = state.usedTokens + state.reservedTokens;
      this.usedCalls = state.usedCalls + state.reservedCalls;
      this.usedTools = state.usedTools;
      this.finishingTokens = state.finishingTokens + state.pendingFinishingTokens;
      this.finishingCalls = state.finishingCalls + state.pendingFinishingCalls;
      this.unknownUsageCalls = state.unknownUsageCalls + state.activeCalls + state.reservedCalls;
      this.toolAdmissionIds = new Set(state.toolAdmissionIds);
      for (const value of [
        this.usedTokens,
        this.usedCalls,
        this.finishingTokens,
        this.finishingCalls,
        this.unknownUsageCalls,
      ])
        if (!Number.isSafeInteger(value)) throw new Error("Durable budget counter overflow");
    }
  }
  exportState(): HarnessBudgetState {
    return parseHarnessBudgetState({
      schemaVersion: 1,
      limits: this.limits,
      usedTokens: this.usedTokens,
      reservedTokens: this.reservedTokens,
      usedCalls: this.usedCalls,
      reservedCalls: this.reservedCalls,
      usedTools: this.usedTools,
      activeCalls: this.activeCalls,
      finishingTokens: this.finishingTokens,
      finishingCalls: this.finishingCalls,
      pendingFinishingTokens: this.pendingFinishingTokens,
      pendingFinishingCalls: this.pendingFinishingCalls,
      unknownUsageCalls: this.unknownUsageCalls,
      toolAdmissionIds: [...this.toolAdmissionIds],
    });
  }
  /** Native journal submission persists after start and before provider I/O.
   * Unstarted admission reservations cannot have been billed and are reconstructed
   * by replay; only active physical requests need conservative recovery charges. */
  exportStartedState(): HarnessBudgetState {
    return {
      ...this.exportState(),
      reservedTokens: this.activeReservedTokens,
      reservedCalls: 0,
      pendingFinishingCalls: 0,
      pendingFinishingTokens: this.activeFinishingTokens,
    };
  }
  snapshot(): HarnessBudgetSnapshot {
    return {
      tokens: resource(
        this.limits.maxTokens,
        this.usedTokens,
        this.reservedTokens,
        Math.max(0, (this.limits.finishingTokens ?? 0) - this.finishingTokens - this.pendingFinishingTokens),
      ),
      modelCalls: resource(
        this.limits.maxModelCalls,
        this.usedCalls,
        this.reservedCalls,
        Math.max(0, (this.limits.finishingModelCalls ?? 0) - this.finishingCalls - this.pendingFinishingCalls),
      ),
      toolCalls: resource(this.limits.maxToolCalls, this.usedTools, 0),
      unknownUsageCalls: this.unknownUsageCalls,
    };
  }
  admitTool(logicalId?: string): boolean {
    if (logicalId && this.toolAdmissionIds.has(logicalId)) return true;
    if (this.usedTools >= (this.limits.maxToolCalls ?? Infinity)) return false;
    this.usedTools++;
    if (logicalId) this.toolAdmissionIds.add(logicalId);
    return true;
  }
  reserveCall(finishing = false) {
    const snapshot = this.snapshot().modelCalls;
    const remaining = finishing ? snapshot.remaining : snapshot.ordinaryRemaining;
    if (remaining !== null && remaining < 1)
      throw new HarnessBudgetError("Aggregate model/token budget exhausted or reserved by another call");
    this.reservedCalls++;
    if (finishing) this.pendingFinishingCalls++;
    let started = false;
    let released = false;
    return {
      start: () => {
        if (started || released) return;
        started = true;
        this.reservedCalls--;
        this.usedCalls++;
        if (finishing) {
          this.pendingFinishingCalls--;
          this.finishingCalls++;
        }
      },
      release: () => {
        if (released) return;
        released = true;
        if (!started) {
          this.reservedCalls--;
          if (finishing) this.pendingFinishingCalls--;
        }
      },
    };
  }
  reserve(
    inputTokens: number,
    requestedOutput: number | undefined,
    finishing = false,
    callReservation?: ReturnType<HarnessBudgetLedger["reserveCall"]>,
  ) {
    if (!Number.isSafeInteger(inputTokens) || inputTokens < 0)
      throw new TypeError("Input token estimate must be a nonnegative safe integer");
    if (requestedOutput !== undefined && (!Number.isSafeInteger(requestedOutput) || requestedOutput <= 0))
      throw new TypeError("maxTokens must be a positive safe integer");
    const snapshot = this.snapshot();
    const calls = finishing ? snapshot.modelCalls.remaining : snapshot.modelCalls.ordinaryRemaining;
    const remaining = finishing ? snapshot.tokens.remaining : snapshot.tokens.ordinaryRemaining;
    if ((!callReservation && calls !== null && calls < 1) || (remaining !== null && remaining <= inputTokens))
      throw new HarnessBudgetError("Aggregate model/token budget exhausted or reserved by another call");
    const maxTokens = Math.min(requestedOutput ?? Infinity, remaining === null ? Infinity : remaining - inputTokens);
    const projected = inputTokens + (Number.isFinite(maxTokens) ? maxTokens : 0);
    if (!Number.isSafeInteger(projected)) throw new TypeError("Projected token reservation exceeds safe integer range");
    const call = callReservation ?? this.reserveCall(finishing);
    this.reservedTokens += projected;
    if (finishing) this.pendingFinishingTokens += projected;
    let started = false;
    let settled = false;
    return {
      maxTokens: Number.isFinite(maxTokens) ? maxTokens : undefined,
      start: () => {
        if (started || settled) return;
        started = true;
        this.activeCalls++;
        this.activeReservedTokens += projected;
        if (finishing) this.activeFinishingTokens += projected;
        call.start();
      },
      settle: (usage?: TokenUsage) => {
        if (settled) return;
        if (
          usage &&
          ([usage.promptTokens, usage.completionTokens, usage.totalTokens].some(
            (value) => !Number.isSafeInteger(value) || value < 0,
          ) ||
            usage.totalTokens < usage.promptTokens + usage.completionTokens)
        )
          throw new Error("Provider returned invalid token usage");
        settled = true;
        this.reservedTokens -= projected;
        call.release();
        if (finishing) this.pendingFinishingTokens -= projected;
        if (!started) return;
        this.activeCalls--;
        this.activeReservedTokens -= projected;
        if (finishing) this.activeFinishingTokens -= projected;
        // Normalized missing accounting counters must not masquerade as known zero usage.
        const known =
          usage &&
          (!usage.accounting ||
            (usage.accounting.tokens &&
              usage.accounting.tokens.input.total !== null &&
              usage.accounting.tokens.output.total !== null &&
              usage.accounting.tokens.total !== null));
        const amount = known ? usage.totalTokens : Math.max(projected, usage?.totalTokens ?? 0);
        if (!known) this.unknownUsageCalls++;
        this.usedTokens += amount;
        if (finishing) this.finishingTokens += amount;
      },
    };
  }
}
