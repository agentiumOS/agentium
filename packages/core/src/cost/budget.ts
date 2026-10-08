import type {
  AccountingScope,
  BudgetDecision,
  BudgetPolicy,
  BudgetReservation,
  CostAssessment,
} from "./accounting-types.js";
import { Decimal, nonnegativeDecimal } from "./decimal.js";
import type { AccountingStore, BudgetProjection } from "./store.js";
export class BudgetExceededError extends Error {
  readonly code = "COST_BUDGET_EXCEEDED";
  readonly retryable = false;
  constructor(readonly decision: BudgetDecision) {
    super(`Cost budget ${decision.reason ?? "limit"}: ${decision.status}`);
    this.name = "BudgetExceededError";
  }
}
export function validateBudget(policy: BudgetPolicy): void {
  const keys = new Set<string>();
  for (const limit of policy.limits) {
    const key = JSON.stringify([limit.scope, limit.period.start, limit.period.end, limit.currency]);
    if (keys.has(key)) throw new TypeError("Duplicate budget scope and period");
    keys.add(key);
    nonnegativeDecimal(limit.amount);
    if (!/^[A-Z]{3}$/.test(limit.currency)) throw new TypeError("Budget currency must be an ISO currency code");
    if (
      !Number.isFinite(Date.parse(limit.period.start)) ||
      !Number.isFinite(Date.parse(limit.period.end)) ||
      limit.period.start >= limit.period.end
    )
      throw new TypeError("Budget period must be a valid increasing UTC interval");
  }
  if (policy.conservativeBound !== undefined) nonnegativeDecimal(policy.conservativeBound);
}
export function budgetScopes(
  policy: BudgetPolicy,
  scope: AccountingScope,
  occurredAt = new Date().toISOString(),
): Array<{ key: string; limit: string; currency: string }> {
  const tenantId = scope.tenantId ?? "local";
  return policy.limits
    .filter((limit) => occurredAt >= limit.period.start && occurredAt < limit.period.end)
    .map((limit) => {
      const scopeId =
        limit.scope === "tenant"
          ? tenantId
          : limit.scope === "run"
            ? scope.runId
            : limit.scope === "rootRun"
              ? scope.rootRunId
              : limit.scope === "session"
                ? scope.sessionId
                : limit.scope === "user"
                  ? scope.userId
                  : scope.operationId;
      if (!scopeId) throw new TypeError(`Budget requires ${limit.scope} scope`);
      return {
        key: JSON.stringify([tenantId, limit.scope, scopeId, limit.period.start, limit.period.end, limit.currency]),
        limit: limit.amount,
        currency: limit.currency,
      };
    });
}
export function budgetProjections(policy: BudgetPolicy | undefined, assessment: CostAssessment): BudgetProjection[] {
  if (!policy) return [];
  return budgetScopes(policy, assessment, assessment.context.occurredAt)
    .filter((scope) => scope.currency === assessment.currency)
    .map((scope) => ({
      key: scope.key,
      currency: scope.currency,
      amount: assessment.knownSubtotal,
      unknown: assessment.total === null,
    }));
}
export async function decideBudget(
  store: AccountingStore,
  policy: BudgetPolicy | undefined,
  scope: AccountingScope & { attemptId?: string; currency?: string },
  bound?: string,
): Promise<BudgetDecision> {
  if (!policy) return { status: "allowed", scopes: [] };
  let keys: ReturnType<typeof budgetScopes>;
  try {
    keys = budgetScopes(policy, scope);
  } catch {
    return { status: "blocked", reason: "missing_scope", scopes: [] };
  }
  const balances = await store.balances(scope.tenantId ?? "local", keys);
  const warn = policy.onExceeded === "warn";
  if (
    balances.some(
      (row) => Decimal.from(row.spent).add(Decimal.from(row.reserved)).compare(Decimal.from(row.limit)) >= 0,
    ) &&
    !warn
  )
    return { status: "blocked", reason: "limit", scopes: balances };
  if (balances.some((row) => row.unknownCount > 0))
    return {
      status:
        (policy.onUnknown ?? (policy.mode === "reservation" ? "block" : "warn")) === "warn" ? "warned" : "blocked",
      reason: "unknown_cost",
      scopes: balances,
    };
  if (policy.mode === "threshold") {
    const exceeded = balances.some(
      (row) => Decimal.from(row.spent).add(Decimal.from(row.reserved)).compare(Decimal.from(row.limit)) >= 0,
    );
    return {
      status: exceeded ? (warn ? "warned" : "blocked") : "allowed",
      reason: exceeded ? "limit" : undefined,
      scopes: balances,
    };
  }
  const amount = bound ?? policy.conservativeBound;
  if (amount === undefined || !scope.attemptId) return { status: "blocked", reason: "missing_bound", scopes: balances };
  nonnegativeDecimal(amount);
  const currency = scope.currency ?? "USD";
  if (keys.some((key) => key.currency !== currency))
    throw new TypeError("Reservation bounds must be supplied in the budget currency");
  const reservation: BudgetReservation = {
    tenantId: scope.tenantId ?? "local",
    reservationId: `${scope.attemptId}:reservation`,
    attemptId: scope.attemptId,
    amount,
    currency,
    scopes: keys.map(({ key, limit }) => ({ key, limit })),
    status: "reserved",
    createdAt: new Date().toISOString(),
  };
  const result = await store.reserve(reservation);
  const unknownRejected = !result.accepted && result.balances.some((row) => row.unknownCount > 0);
  const limitRejected =
    !result.accepted &&
    result.balances.some(
      (row) =>
        Decimal.from(row.spent)
          .add(Decimal.from(row.reserved))
          .add(Decimal.from(amount))
          .compare(Decimal.from(row.limit)) > 0,
    );
  const mustBlock = (limitRejected && !warn) || (unknownRejected && (policy.onUnknown ?? "block") === "block");
  return {
    status: result.accepted ? "allowed" : mustBlock || (!unknownRejected && !limitRejected) ? "blocked" : "warned",
    reason: result.accepted ? undefined : unknownRejected && !(limitRejected && !warn) ? "unknown_cost" : "limit",
    scopes: result.balances,
    reservationId: result.accepted ? reservation.reservationId : undefined,
  };
}
