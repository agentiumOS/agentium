import { AsyncLocalStorage } from "node:async_hooks";
import type { EventBus } from "../events/event-bus.js";
import type { TokenUsage } from "../models/types.js";
import type { CostTracker } from "./cost-tracker.js";

/** Trusted scope for usage attribution. Never put credentials or prompts here. */
export interface AccountingContext {
  tracker: CostTracker;
  tenantId?: string;
  runId?: string;
  rootRunId?: string;
  parentRunId?: string;
  /** Run ancestors are kept even when an intermediate run makes no paid call. */
  ancestorRunIds?: string[];
  sessionId?: string;
  userId?: string;
  agentName?: string;
  operationId?: string;
  parentOperationId?: string;
  purpose?: string;
  eventBus?: EventBus;
  /** Called for an accounting failure after provider work. It must not retry provider work. */
  onAccountingError?: (error: unknown) => void;
}

const accountingScope = new AsyncLocalStorage<AccountingContext>();
export interface UsageEvidence {
  usage?: TokenUsage;
  onRetry?: (error: unknown) => Promise<void>;
}
const evidenceScope = new AsyncLocalStorage<UsageEvidence>();

export function getAccountingContext(): AccountingContext | undefined {
  return accountingScope.getStore();
}

function inheritRunLineage(context: AccountingContext): AccountingContext {
  const parent = accountingScope.getStore();
  const ancestors = [...(context.ancestorRunIds ?? []), ...(parent?.ancestorRunIds ?? [])];
  if (parent?.runId && parent.runId !== context.runId) ancestors.push(parent.runId);
  if (context.parentRunId && context.parentRunId !== context.runId) ancestors.push(context.parentRunId);
  return { ...context, ancestorRunIds: [...new Set(ancestors)].filter((id) => id !== context.runId) };
}

/** Scope propagates through promises, including background work, without mutating a shared provider. */
export function withAccountingContext<T>(context: AccountingContext, operation: () => T): T {
  return accountingScope.run(inheritRunLineage(context), operation);
}

/** Advance every generator step in its owning scope; generator creation alone does not bind async context. */
export async function* withAccountingStream<T>(
  context: AccountingContext,
  operation: () => AsyncGenerator<T>,
): AsyncGenerator<T> {
  context = inheritRunLineage(context);
  const iterator = withAccountingContext(context, operation);
  try {
    while (true) {
      const next = await withAccountingContext(context, () => iterator.next());
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await withAccountingContext(context, () => iterator.return(undefined));
  }
}

/** Adapters call this before parsing output so failure still preserves billed usage. */
export function captureUsage(usage: TokenUsage): void {
  const evidence = evidenceScope.getStore();
  if (evidence) evidence.usage = usage;
}

export function withUsageEvidence<T>(evidence: UsageEvidence, operation: () => T): T {
  return evidenceScope.run(evidence, operation);
}

/** A built-in retry owner calls this only after it decides to submit another request. */
export async function captureRetryFailure(error: unknown): Promise<void> {
  await evidenceScope.getStore()?.onRetry?.(error);
}
