import type {
  BudgetReservation,
  BudgetScopeBalance,
  CostAllocation,
  CostAssessment,
  CostQueryResult,
  UsageObservation,
  UsagePage,
  UsageQuery,
  UsageRevision,
} from "./accounting-types.js";
/** Guarantees offered by an accounting backend; durable and shared are independent. */
export interface StoreCapabilities {
  durable: boolean;
  atomicSettlement: boolean;
  sharedReservations: boolean;
  cursorPagination: boolean;
}
export interface AssessmentSelection {
  tenantId: string;
  targetKind: CostAssessment["targetKind"];
  targetId: string;
  view: string;
  assessmentId: string;
  revision: number;
}
export interface BudgetProjection {
  key: string;
  amount: string;
  unknown: boolean;
  currency: string;
}
export interface CommitAssessmentInput {
  assessment: CostAssessment;
  view: string;
  expectedSelectionRevision: number;
  reservationId?: string;
  projections?: BudgetProjection[];
  usageRevision?: UsageRevision;
}
/** Persistent usage evidence and selected cost views. Implementations must preserve tenant isolation and replay identity. */
export interface UsageStore {
  readonly capabilities: StoreCapabilities;
  appendObservation(observation: UsageObservation): Promise<"inserted" | "duplicate">;
  appendUsageRevision(revision: UsageRevision): Promise<"inserted" | "duplicate">;
  queryUsage(query: UsageQuery): Promise<UsagePage<UsageObservation>>;
  queryAssessments(query: UsageQuery & { selected?: boolean; targetId?: string }): Promise<UsagePage<CostAssessment>>;
  getAssessment(tenantId: string, assessmentId: string): Promise<CostAssessment | null>;
  getSelection(
    tenantId: string,
    targetKind: CostAssessment["targetKind"],
    targetId: string,
    view: string,
  ): Promise<AssessmentSelection | null>;
  commitAssessmentsAndSettle(inputs: CommitAssessmentInput[]): Promise<Array<"committed" | "duplicate">>;
  commitAssessmentAndSettle(input: CommitAssessmentInput): Promise<"committed" | "duplicate">;
  saveAllocations(allocations: CostAllocation[]): Promise<void>;
  queryAllocations(query: UsageQuery): Promise<UsagePage<CostAllocation>>;
  queryCosts(query: UsageQuery): Promise<CostQueryResult>;
  flush(): Promise<void>;
  close?(): Promise<void>;
}
export interface BudgetStore {
  reserve(reservation: BudgetReservation): Promise<{ accepted: boolean; balances: BudgetScopeBalance[] }>;
  balances(
    tenantId: string,
    scopes: Array<{ key: string; limit: string; currency: string }>,
  ): Promise<BudgetScopeBalance[]>;
  releaseReservation(tenantId: string, reservationId: string, confirmedNotAccepted: boolean): Promise<void>;
  getReservation(tenantId: string, reservationId: string): Promise<BudgetReservation | null>;
}
/** Use one transactional store for usage, selected charges, and budget reservations. */
export type AccountingStore = UsageStore & BudgetStore;
/** An immutable ID was reused or a selected revision changed. No provider request should be retried for this error. */
export class AccountingConflictError extends Error {
  readonly code = "ACCOUNTING_CONFLICT";
  constructor(message: string) {
    super(
      `${message}. Reuse an ID only for identical content; reload the selected revision before retrying an accounting update.`,
    );
    this.name = "AccountingConflictError";
  }
}
/** An accounting write failed. Retry the write with its original IDs, not the provider operation. */
export class AccountingPersistenceError extends Error {
  readonly code = "ACCOUNTING_PERSISTENCE";
  constructor(message: string, options?: ErrorOptions) {
    super(
      `${message}. Retry or flush accounting writes with the same IDs; do not repeat the provider request.`,
      options,
    );
    this.name = "AccountingPersistenceError";
  }
}
export interface StoredDocument {
  tenantId: string;
  kind: string;
  id: string;
  payload: unknown;
  runId?: string;
  rootRunId?: string;
  sessionId?: string;
  userId?: string;
  operationId?: string;
  attemptId?: string;
  targetId?: string;
  currency?: string;
  providerId?: string;
  modelId?: string;
  occurredAt?: string;
}
export interface DocumentQuery {
  tenantId: string;
  kind: string;
  runId?: string;
  rootRunId?: string;
  sessionId?: string;
  userId?: string;
  operationId?: string;
  attemptId?: string;
  targetId?: string;
  currency?: string;
  providerId?: string;
  modelId?: string;
  since?: string;
  until?: string;
  after?: string;
  limit?: number;
}
export interface AccountingTransaction {
  get<T>(kind: string, id: string): Promise<T | null>;
  put(document: Omit<StoredDocument, "tenantId">): Promise<void>;
  list<T>(query: Omit<DocumentQuery, "tenantId">): Promise<Array<{ id: string; value: T }>>;
}
export interface AccountingBackend {
  capabilities: StoreCapabilities;
  transaction<T>(tenantId: string, operation: (transaction: AccountingTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
