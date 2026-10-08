/** JSON-safe evidence. Prompt text and authentication data must never be stored here. */
export type UsageJson = null | boolean | number | string | UsageJson[] | { [key: string]: UsageJson };
export type DecimalAmount = string;
export type TokenCount = number | null;
export interface CanonicalTokens {
  input: {
    total: TokenCount;
    ordinary: TokenCount;
    cacheRead: TokenCount;
    cacheWrite: TokenCount;
    cacheWriteByTTL: Array<{ ttlSeconds: number; tokens: number }>;
  };
  output: { total: TokenCount; reasoning: TokenCount };
  total: TokenCount;
  providerReportedTotal: TokenCount;
}
export interface Measurement {
  id: string;
  meter: string;
  unit: string;
  quantity: DecimalAmount | null;
  dimensions: Record<string, string>;
  source: "provider" | "derived" | "measured" | "estimated";
  evidencePaths: string[];
}
export interface UsageCoverage {
  requiredMeters: string[];
  unsupportedFeatures: string[];
}
export interface NormalizationIssue {
  code: string;
  path?: string;
  message: string;
}
export interface NormalizedUsage {
  schemaVersion: 1;
  normalizerId: string;
  normalizerVersion: string;
  tokens: CanonicalTokens | null;
  measurements: Measurement[];
  coverage: UsageCoverage;
  rawUsage?: UsageJson;
  rawUsageTruncated?: boolean;
  issues: NormalizationIssue[];
  context?: Partial<BillingContext>;
}
export interface BillingContext {
  providerId: string;
  billingProviderId: string;
  modelId: string;
  api: string;
  occurredAt: string;
  requestedModelId?: string;
  resourceId?: string;
  accountId?: string;
  contractId?: string;
  region?: string;
  requestedServiceTier?: string;
  actualServiceTier?: string;
  reasoningMode?: string;
  reasoningEffort?: string;
  inputTokens?: number;
  providerRequestId?: string;
  dimensions?: Record<string, string>;
  provenance?: Record<string, "response" | "request" | "documented_default" | "configured_contract" | "unknown">;
}
export interface AccountingScope {
  tenantId?: string;
  runId?: string;
  rootRunId?: string;
  parentRunId?: string;
  /** Ordered ancestors from root to parent, retained for nested orchestration queries. */
  ancestorRunIds?: string[];
  sessionId?: string;
  userId?: string;
  agentName?: string;
  operationId?: string;
  parentOperationId?: string;
}
export type ExecutionStatus = "started" | "succeeded" | "failed" | "cancelled" | "unknown";
export type UsageStatus = "complete" | "partial" | "unknown" | "invalid";
export type PricingStatus = "complete" | "partial" | "unpriced";
export interface UsageRecordInput extends AccountingScope {
  attemptId: string;
  operationId: string;
  context: BillingContext;
  usage: NormalizedUsage;
  executionStatus: ExecutionStatus;
  usageStatus?: UsageStatus;
  attemptVisibility?: "physical" | "opaque";
  kind?: string;
  purpose?: string;
  observedAt?: string;
  observationId?: string;
  sequence?: number;
  observationKind?: "snapshot" | "delta";
  finality?: "provisional" | "final";
  reservationId?: string;
}
export interface UsageObservation extends UsageRecordInput {
  tenantId: string;
  observationId: string;
  observedAt: string;
  sequence: number;
  observationKind: "snapshot" | "delta";
}
export interface UsageRevision {
  tenantId: string;
  attemptId: string;
  revision: number;
  observationIds: string[];
  usage: NormalizedUsage;
  createdAt: string;
}
export type RuleMatchValue = string | string[] | "*";
export interface PriceRule {
  id: string;
  version: string;
  meter: string;
  unit: string;
  currency: string;
  match: {
    providerId: RuleMatchValue;
    billingProviderId: RuleMatchValue;
    modelId: RuleMatchValue;
    api: RuleMatchValue;
    [key: string]: RuleMatchValue;
  };
  requiredContext?: string[];
  contextBand?: { field: "inputTokens"; above?: number; upTo?: number };
  effectiveFrom?: string;
  effectiveUntil?: string;
  verifiedAt: string;
  sourceUrl: string;
  precedence?: "contract" | "standard";
  scope?: "attempt" | "session" | "account_period";
  groupBy?: string[];
  rate:
    | { kind: "unit"; amount: DecimalAmount; per: DecimalAmount }
    | { kind: "fixed"; amount: DecimalAmount }
    | { kind: "tiered"; tiers: Array<{ upTo: DecimalAmount | null; amount: DecimalAmount; per: DecimalAmount }> };
  rounding?: { increment: DecimalAmount; mode: "ceil" | "floor" | "half_up"; minimum?: DecimalAmount };
  adjustments?: Array<{ id: string; kind: "multiply" | "add"; amount: DecimalAmount; sourceUrl: string }>;
}
export interface PricingCatalog {
  id: string;
  version: string;
  rules: PriceRule[];
  aliases?: Array<{ providerId: string; billingProviderId: string; api: string; from: string; to: string }>;
  validUntil?: string;
}
export type UnpricedReason =
  | "missing_usage"
  | "missing_rate"
  | "ambiguous_rate"
  | "missing_context"
  | "unsupported_rule"
  | "invalid_usage"
  | "unit_mismatch"
  | "stale_catalog"
  | "historical_rate_unknown"
  | "group_contribution";
export interface CostCharge {
  id: string;
  measurementId: string;
  meter: string;
  unit: string;
  quantity: DecimalAmount | null;
  billedQuantity: DecimalAmount | null;
  dimensions: Record<string, string>;
  currency: string;
  amount: DecimalAmount | null;
  amountBeforeAdjustments: DecimalAmount | null;
  reason?: UnpricedReason;
  rule?: PriceRule;
  catalogId: string;
  catalogVersion: string;
  source: Measurement["source"];
  evidencePaths: string[];
  inclusion: "payable" | "contribution";
  billingGroupId?: string;
}
export interface CostAssessment extends AccountingScope {
  tenantId: string;
  assessmentId: string;
  attemptId?: string;
  targetKind: "attempt" | "billing_group" | "account_period";
  targetId: string;
  usageRevision: number;
  createdAt: string;
  context: BillingContext;
  catalogId: string;
  catalogVersion: string;
  currency: string;
  charges: CostCharge[];
  knownSubtotal: DecimalAmount;
  total: DecimalAmount | null;
  unpricedCount: number;
  pricingStatus: PricingStatus;
  usageStatus: UsageStatus;
  executionStatus: ExecutionStatus;
  basis: "list_price" | "provider_reported" | "invoice";
  purpose: "original" | "reprice" | "reconcile";
  finality: "provisional" | "final";
  arithmeticPolicy: "rational-36-half-up-v1";
  /** Immutable source membership used for this group revision. */
  groupMembers?: Array<{ attemptId: string; observationIds: string[]; measurementIds: string[] }>;
  reportedEvidence?: { includedMeters: string[]; sourceUrl: string; evidenceVersion: string; raw?: UsageJson };
}
export interface UsageQuery extends AccountingScope {
  /** queryCosts only: include descendants linked by parentRunId. */
  includeChildren?: boolean;
  attemptId?: string;
  providerId?: string;
  modelId?: string;
  since?: string;
  until?: string;
  cursor?: string;
  limit?: number;
  view?: string;
  currency?: string;
}
export interface UsagePage<T> {
  items: T[];
  nextCursor: string | null;
}
export interface CostQueryResult {
  currency: string;
  knownSubtotal: DecimalAmount;
  total: DecimalAmount | null;
  pricingStatus: PricingStatus;
  unpricedCount: number;
  assessmentCount: number;
  attemptCount: number;
  operationCount: number;
  runCount: number;
  asOf: string;
  finality: "provisional" | "final";
  unallocatedSubtotal: DecimalAmount;
}
export interface BudgetLimit {
  scope: "tenant" | "run" | "rootRun" | "session" | "user" | "operation";
  amount: DecimalAmount;
  currency: string;
  period: { start: string; end: string };
}
export interface BudgetPolicy {
  mode: "threshold" | "reservation";
  limits: BudgetLimit[];
  onExceeded?: "throw" | "warn" | "stop";
  onUnknown?: "warn" | "block";
  conservativeBound?: DecimalAmount;
}
export interface BudgetScopeBalance {
  key: string;
  limit: DecimalAmount;
  currency: string;
  spent: DecimalAmount;
  reserved: DecimalAmount;
  unknownCount: number;
}
export interface BudgetDecision {
  status: "allowed" | "warned" | "blocked";
  reason?: "limit" | "unknown_cost" | "missing_bound" | "missing_scope";
  scopes: BudgetScopeBalance[];
  reservationId?: string;
}
export interface BudgetReservation {
  tenantId: string;
  reservationId: string;
  attemptId: string;
  amount: DecimalAmount;
  currency: string;
  scopes: Array<{ key: string; limit: DecimalAmount }>;
  status: "reserved" | "settled" | "uncertain" | "released";
  overrunAmount?: DecimalAmount;
  createdAt: string;
}

export interface ReportedCostInput extends AccountingScope {
  tenantId?: string;
  assessmentId: string;
  targetKind: CostAssessment["targetKind"];
  targetId: string;
  attemptId?: string;
  context: BillingContext;
  amount: DecimalAmount;
  currency: string;
  basis: "provider_reported" | "invoice";
  sourceUrl: string;
  evidenceVersion: string;
  includedMeters: string[];
  finality: CostAssessment["finality"];
  evidence?: UsageJson;
}
export interface CostAllocation extends AccountingScope {
  tenantId: string;
  allocationId: string;
  assessmentId: string;
  targetKind: "billing_group" | "account_period";
  targetId: string;
  operationId: string;
  policyVersion: string;
  view: string;
  amount: DecimalAmount;
  currency: string;
  context: BillingContext;
}
export interface AllocationMember extends AccountingScope {
  operationId: string;
  weight: DecimalAmount;
}

/** A run can succeed even when its accounting store is temporarily unavailable. */
export type RunCostSnapshot =
  | ({ status: "available" } & CostQueryResult)
  | {
      status: "unavailable";
      currency: string;
      total: null;
      knownSubtotal: null;
      reason: "accounting_unavailable";
    };
