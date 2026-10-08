import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { mergeBillingContext } from "../models/billing-context.js";
import type { TokenUsage } from "../models/types.js";
import type {
  AccountingScope,
  AllocationMember,
  BillingContext,
  BudgetDecision,
  BudgetPolicy,
  CostAllocation,
  CostAssessment,
  NormalizedUsage,
  PricingCatalog,
  ReportedCostInput,
  UsageObservation,
  UsageQuery,
  UsageRecordInput,
} from "./accounting-types.js";
import { budgetProjections, budgetScopes, decideBudget, validateBudget } from "./budget.js";
import { allocateGroupAmount, calculateCharges, sumMeasurements } from "./calculator.js";
import { validateCatalog } from "./catalog.js";
import { REVIEWED_PRICING_CATALOG } from "./catalog-data/reviewed.js";
import { Decimal, nonnegativeDecimal, sumDecimals } from "./decimal.js";
import {
  AccountingConflictError,
  AccountingPersistenceError,
  type AccountingStore,
  type CommitAssessmentInput,
} from "./store.js";
import { stableJson } from "./stores/base.js";
import { InMemoryUsageStore } from "./stores/in-memory.js";
import { retainRawUsage, validateNormalizedUsage } from "./usage.js";
export interface LedgerConfig {
  catalog?: PricingCatalog;
  store?: AccountingStore;
  budget?: BudgetPolicy;
  currency?: string;
}
function usageStatus(usage: NormalizedUsage): "complete" | "partial" | "unknown" | "invalid" {
  if (
    usage.issues.some((issue) => /invalid|partition_mismatch|subset_mismatch|canonical_total_mismatch/.test(issue.code))
  )
    return "invalid";
  if (!usage.measurements.length || usage.measurements.every((m) => m.quantity === null)) return "unknown";
  if (usage.measurements.some((m) => m.quantity === null) || usage.coverage.unsupportedFeatures.length)
    return "partial";
  return "complete";
}
function mergeDeltas(base: NormalizedUsage | undefined, deltas: NormalizedUsage[]): NormalizedUsage {
  const usages = [...(base ? [base] : []), ...deltas];
  const first = structuredClone(usages[0]);
  if (!first) throw new TypeError("No usage observations");
  first.measurements = sumMeasurements(usages.flatMap((usage) => usage.measurements));
  first.coverage = {
    requiredMeters: [...new Set(usages.flatMap((usage) => usage.coverage.requiredMeters))],
    unsupportedFeatures: [...new Set(usages.flatMap((usage) => usage.coverage.unsupportedFeatures))],
  };
  first.issues = usages.flatMap((usage) => usage.issues);
  // Counts are statistics only. Billing uses the merged measurements.
  if (usages.every((usage) => usage.tokens !== null)) {
    const counts = (select: (usage: NormalizedUsage) => number | null | undefined) => {
      const values = usages.map(select);
      if (values.some((value) => value === null || value === undefined)) return null;
      const total = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
      return Number.isSafeInteger(total) ? total : null;
    };
    first.tokens = {
      input: {
        total: counts((u) => u.tokens?.input.total),
        ordinary: counts((u) => u.tokens?.input.ordinary),
        cacheRead: counts((u) => u.tokens?.input.cacheRead),
        cacheWrite: counts((u) => u.tokens?.input.cacheWrite),
        cacheWriteByTTL: [],
      },
      output: { total: counts((u) => u.tokens?.output.total), reasoning: counts((u) => u.tokens?.output.reasoning) },
      total: counts((u) => u.tokens?.total),
      providerReportedTotal: counts((u) => u.tokens?.providerReportedTotal),
    };
  } else first.tokens = null;
  first.context = {};
  for (const usage of usages) first.context = mergeBillingContext(first.context, usage.context);
  if (first.tokens?.input.total !== null && first.tokens?.input.total !== undefined)
    first.context.inputTokens = first.tokens.input.total;
  return first;
}
export function selectedObservationUsage(observations: UsageObservation[]): {
  usage: NormalizedUsage;
  observationIds: string[];
  latest: UsageObservation;
} {
  const ordered = [...observations].sort(
    (a, b) => a.sequence - b.sequence || a.observationId.localeCompare(b.observationId),
  );
  const latest = ordered.at(-1);
  if (!latest) throw new TypeError("No usage observations");
  const snapshots = ordered.filter((item) => item.observationKind === "snapshot");
  const snapshot = snapshots.at(-1);
  const deltas = ordered.filter(
    (item) => item.observationKind === "delta" && (!snapshot || item.sequence > snapshot.sequence),
  );
  const included = [...(snapshot ? [snapshot] : []), ...deltas];
  return {
    usage: deltas.length
      ? mergeDeltas(
          snapshot?.usage,
          deltas.map((item) => item.usage),
        )
      : structuredClone(latest.usage),
    observationIds: included.map((item) => item.observationId),
    latest,
  };
}
export class UsageLedger {
  readonly store: AccountingStore;
  readonly catalog: PricingCatalog;
  readonly budget: BudgetPolicy | undefined;
  readonly currency: string;
  private readonly ownsStore: boolean;
  private readonly active = new Map<string, { done: Promise<void>; finish: () => void }>();
  private readonly pending = new Map<string, UsageRecordInput>();
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(config: LedgerConfig = {}) {
    this.store = config.store ?? new InMemoryUsageStore();
    this.ownsStore = config.store === undefined;
    this.catalog = structuredClone(config.catalog ?? REVIEWED_PRICING_CATALOG);
    this.budget = config.budget;
    this.currency = config.currency ?? "USD";
    validateCatalog(this.catalog);
    if (this.budget) validateBudget(this.budget);
    if (this.budget?.mode === "reservation" && !this.store.capabilities.atomicSettlement)
      throw new TypeError("Reservation budgets require one atomic accounting backend for usage and budget settlement");
  }
  beginPendingAttempt(attemptId: string): void {
    if (!this.active.has(attemptId)) {
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      this.active.set(attemptId, { done, finish });
    }
  }
  endPendingAttempt(attemptId: string): void {
    this.active.get(attemptId)?.finish();
    this.active.delete(attemptId);
  }
  async startAttempt(
    input: AccountingScope & {
      attemptId: string;
      operationId: string;
      context: BillingContext;
      attemptVisibility?: "physical" | "opaque";
    },
  ): Promise<void> {
    await this.store.appendObservation({
      ...input,
      tenantId: input.tenantId ?? "local",
      observationId: `${input.attemptId}:start`,
      observedAt: input.context.occurredAt,
      sequence: 0,
      observationKind: "snapshot",
      executionStatus: "started",
      usage: {
        schemaVersion: 1,
        normalizerId: "agentium.start-intent",
        normalizerVersion: "1",
        tokens: null,
        measurements: [],
        coverage: { requiredMeters: ["operation.unknown"], unsupportedFeatures: [] },
        issues: [],
      },
    });
    this.beginPendingAttempt(JSON.stringify([input.tenantId ?? "local", input.attemptId]));
  }
  async recordUsage(input: UsageRecordInput): Promise<CostAssessment> {
    const immutableInput = structuredClone({
      ...input,
      observationId: input.observationId ?? `${input.attemptId}:terminal`,
      observedAt: input.observedAt ?? input.context.occurredAt,
    });
    const key = JSON.stringify([input.tenantId ?? "local", input.attemptId]);
    const result = (this.queues.get(key) ?? Promise.resolve()).then(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.record(immutableInput);
        } catch (error) {
          if (
            !(error instanceof AccountingConflictError) ||
            attempt >= 4 ||
            !error.message.includes("Stale assessment selection")
          )
            throw error;
        }
      }
    });
    const queued = result.catch(() => {});
    this.queues.set(key, queued);
    try {
      const assessment = await result;
      this.pending.delete(`${key}:${immutableInput.observationId}`);
      return assessment;
    } catch (error) {
      if (
        error instanceof TypeError ||
        error instanceof RangeError ||
        (error instanceof AccountingConflictError && !error.message.includes("Stale assessment selection"))
      )
        throw error;
      this.pending.set(`${key}:${immutableInput.observationId}`, immutableInput);
      throw new AccountingPersistenceError(
        "Usage could not be committed; flush retries accounting without another provider request",
        { cause: error },
      );
    } finally {
      this.endPendingAttempt(JSON.stringify([input.tenantId ?? "local", input.attemptId]));
      if (this.queues.get(key) === queued) this.queues.delete(key);
    }
  }
  private async observations(query: UsageQuery): Promise<UsageObservation[]> {
    const result: UsageObservation[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.store.queryUsage({ ...query, cursor, limit: 1000 });
      result.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return result;
  }
  private async record(input: UsageRecordInput): Promise<CostAssessment> {
    const tenantId = input.tenantId ?? "local";
    const observation: UsageObservation = {
      ...input,
      tenantId,
      observationId: input.observationId ?? `${input.attemptId}:terminal`,
      observedAt: input.observedAt ?? input.context.occurredAt,
      sequence: input.sequence ?? 1,
      observationKind: input.observationKind ?? "snapshot",
      context: mergeBillingContext(input.context, input.usage.context),
      usage: validateNormalizedUsage(input.usage),
    };
    if (!Number.isSafeInteger(observation.sequence) || observation.sequence < 1)
      throw new TypeError("Usage observation sequences start at 1; zero is reserved for start intent");
    await this.store.appendObservation(observation);
    const all = (await this.observations({ tenantId, attemptId: input.attemptId })).filter(
      (item) => item.executionStatus !== "started",
    );
    const chosen = selectedObservationUsage(all);
    const selection = await this.store.getSelection(tenantId, "attempt", input.attemptId, "original");
    const existing = selection
      ? (await this.store.queryAssessments({ tenantId, attemptId: input.attemptId, limit: 1000 })).items.find(
          (item) => item.assessmentId === selection.assessmentId,
        )
      : undefined;
    const signature = `assessment:${createHash("sha256")
      .update(stableJson([tenantId, input.attemptId, "original", chosen.observationIds]))
      .digest("hex")}`;
    if (existing?.assessmentId === signature) {
      const groups = await this.billingGroupInputs(existing, chosen.latest);
      await this.store.commitAssessmentsAndSettle(groups);
      return existing;
    }
    const revision = (selection?.revision ?? 0) + 1;
    const usageRevision = {
      tenantId,
      attemptId: input.attemptId,
      revision,
      observationIds: chosen.observationIds,
      usage: chosen.usage,
      createdAt: chosen.latest.observedAt,
    };
    const assessment = calculateCharges({
      ...chosen.latest,
      purpose: "original",
      usage: chosen.usage,
      catalog: this.catalog,
      context: mergeBillingContext(chosen.latest.context, chosen.usage.context),
      currency: this.currency,
      assessmentId: signature,
      usageRevision: revision,
      usageStatus: input.usageStatus ?? usageStatus(chosen.usage),
      finality: chosen.latest.finality ?? (chosen.latest.executionStatus === "succeeded" ? "final" : "provisional"),
    });
    const groups = await this.billingGroupInputs(assessment, chosen.latest);
    if (existing) {
      const oldGroups = await this.billingGroupInputs(existing, {
        ...chosen.latest,
        context: existing.context,
        sessionId: existing.sessionId,
      });
      for (const group of oldGroups)
        if (!groups.some((current) => current.assessment.targetId === group.assessment.targetId)) groups.push(group);
    }
    await this.store.commitAssessmentsAndSettle([
      {
        assessment,
        view: "original",
        expectedSelectionRevision: selection?.revision ?? 0,
        reservationId: input.reservationId,
        usageRevision,
        projections: budgetProjections(this.budget, assessment),
      },
      ...groups,
    ]);
    return assessment;
  }
  private async billingGroupInputs(
    assessment: CostAssessment,
    observation: UsageObservation,
    catalog = this.catalog,
    view = "original",
  ): Promise<CommitAssessmentInput[]> {
    const commits: CommitAssessmentInput[] = [];
    const contributions = assessment.charges.filter((charge) => charge.inclusion === "contribution" && charge.rule);
    for (const contribution of contributions) {
      const rule = contribution.rule!;
      const groupScope =
        rule.scope === "session" ? observation.sessionId : observation.context.dimensions?.billingPeriod;
      if (!groupScope) continue;
      const groupKey = stableJson([
        assessment.tenantId,
        observation.context.accountId ?? observation.context.resourceId ?? "local",
        rule.id,
        rule.version,
        rule.effectiveFrom ?? rule.verifiedAt,
        rule.effectiveUntil ?? null,
        groupScope,
        ...(rule.groupBy ?? []).map(
          (key) =>
            contribution.dimensions[key] ??
            observation.context.dimensions?.[key] ??
            (observation.context as unknown as Record<string, unknown>)[key] ??
            null,
        ),
      ]);
      const groupId = `group:${createHash("sha256").update(groupKey).digest("hex")}`;
      contribution.billingGroupId = groupId;
      const records = (
        await this.observations({
          tenantId: assessment.tenantId,
          ...(rule.scope === "session" ? { sessionId: observation.sessionId } : {}),
        })
      ).filter((item) => item.executionStatus !== "started");
      const byAttempt = new Map<string, UsageObservation[]>();
      for (const item of records) {
        const values = byAttempt.get(item.attemptId) ?? [];
        values.push(item);
        byAttempt.set(item.attemptId, values);
      }
      const memberships: string[] = [];
      const groupMembers: NonNullable<CostAssessment["groupMembers"]> = [];
      const measurements = [];
      for (const values of byAttempt.values()) {
        const chosen = selectedObservationUsage(
          (await this.observations({ tenantId: assessment.tenantId, attemptId: values[0].attemptId })).filter(
            (item) => item.executionStatus !== "started",
          ),
        );
        if (rule.scope === "session" && chosen.latest.sessionId !== groupScope) continue;
        if (rule.scope === "account_period" && chosen.latest.context.dimensions?.billingPeriod !== groupScope) continue;
        if (
          (chosen.latest.context.accountId ?? chosen.latest.context.resourceId ?? "local") !==
          (observation.context.accountId ?? observation.context.resourceId ?? "local")
        )
          continue;
        const compatible = calculateCharges({
          ...chosen.latest,
          purpose: "original",
          usage: chosen.usage,
          catalog,
          currency: this.currency,
        });
        for (const charge of compatible.charges)
          if (
            charge.rule?.id === rule.id &&
            charge.rule?.version === rule.version &&
            (rule.groupBy ?? []).every(
              (key) =>
                (charge.dimensions[key] ??
                  chosen.latest.context.dimensions?.[key] ??
                  (chosen.latest.context as unknown as Record<string, unknown>)[key]) ===
                (contribution.dimensions[key] ??
                  observation.context.dimensions?.[key] ??
                  (observation.context as unknown as Record<string, unknown>)[key]),
            )
          ) {
            const measurement = chosen.usage.measurements.find((m) => m.id === charge.measurementId);
            if (measurement) {
              measurements.push(measurement);
              const member = groupMembers.find((item) => item.attemptId === chosen.latest.attemptId);
              if (member) member.measurementIds.push(measurement.id);
              else
                groupMembers.push({
                  attemptId: chosen.latest.attemptId,
                  observationIds: chosen.observationIds,
                  measurementIds: [measurement.id],
                });
              memberships.push(...chosen.observationIds.map((id) => `${chosen.latest.attemptId}:${id}`));
            }
          }
      }
      const selection = await this.store.getSelection(assessment.tenantId, "billing_group", groupId, view);
      const groupUsage: NormalizedUsage = {
        schemaVersion: 1,
        normalizerId: "agentium.billing-group",
        normalizerVersion: "1",
        tokens: null,
        measurements: [
          {
            id: contribution.measurementId,
            meter: contribution.meter,
            unit: contribution.unit,
            quantity: measurements.some((measurement) => measurement.quantity === null)
              ? null
              : sumDecimals(measurements.map((measurement) => measurement.quantity ?? "0")),
            dimensions: contribution.dimensions,
            source: "derived",
            evidencePaths: [...new Set(measurements.flatMap((measurement) => measurement.evidencePaths))],
          },
        ],
        coverage: { requiredMeters: [contribution.meter], unsupportedFeatures: [] },
        issues: [],
      };
      const groupAssessment = calculateCharges({
        tenantId: assessment.tenantId,
        sessionId: observation.sessionId,
        context: observation.context,
        usage: groupUsage,
        catalog,
        currency: this.currency,
        assessmentId: `group-assessment:${createHash("sha256")
          .update(stableJson([groupId, view, catalog.id, catalog.version, memberships.sort()]))
          .digest("hex")}`,
        targetKind: "billing_group",
        targetId: groupId,
        usageRevision: (selection?.revision ?? 0) + 1,
        usageStatus: usageStatus(groupUsage),
        finality: "provisional",
      });
      groupAssessment.groupMembers = groupMembers;
      if (measurements.length === 0) {
        groupAssessment.charges = [];
        groupAssessment.knownSubtotal = "0";
        groupAssessment.total = "0";
        groupAssessment.unpricedCount = 0;
        groupAssessment.pricingStatus = "complete";
      }
      if (selection?.assessmentId === groupAssessment.assessmentId) continue;
      commits.push({
        assessment: groupAssessment,
        view,
        expectedSelectionRevision: selection?.revision ?? 0,
        projections:
          this.budget && view === "original"
            ? budgetProjections(
                {
                  ...this.budget,
                  limits: this.budget.limits.filter((limit) => ["tenant", "session"].includes(limit.scope)),
                },
                groupAssessment,
              )
            : [],
      });
    }
    return commits;
  }
  async reprice(query: UsageQuery, catalog: PricingCatalog, view = "repriced"): Promise<CostAssessment[]> {
    validateCatalog(catalog);
    if (view === "original")
      throw new TypeError("Repricing must use a separate view; original assessments are immutable");
    const observations = await this.observations(query);
    const byAttempt = new Map<string, UsageObservation[]>();
    for (const observation of observations)
      if (observation.executionStatus !== "started") {
        const values = byAttempt.get(observation.attemptId) ?? [];
        values.push(observation);
        byAttempt.set(observation.attemptId, values);
      }
    const result: CostAssessment[] = [];
    for (const [attemptId, values] of byAttempt) {
      const chosen = selectedObservationUsage(values);
      const selection = await this.store.getSelection(chosen.latest.tenantId, "attempt", attemptId, view);
      const assessment = calculateCharges({
        ...chosen.latest,
        usage: chosen.usage,
        catalog,
        currency: this.currency,
        assessmentId: randomUUID(),
        usageRevision: (selection?.revision ?? 0) + 1,
        purpose: "reprice",
      });
      const groups = await this.billingGroupInputs(assessment, chosen.latest, catalog, view);
      if (selection) {
        const previous = await this.store.getAssessment(chosen.latest.tenantId, selection.assessmentId);
        if (previous) {
          const oldGroups = await this.billingGroupInputs(
            previous,
            { ...chosen.latest, context: previous.context, sessionId: previous.sessionId },
            catalog,
            view,
          );
          for (const group of oldGroups)
            if (!groups.some((current) => current.assessment.targetId === group.assessment.targetId))
              groups.push(group);
        }
      }
      await this.store.commitAssessmentsAndSettle([
        { assessment, view, expectedSelectionRevision: selection?.revision ?? 0 },
        ...groups,
      ]);
      result.push(assessment);
    }
    return result;
  }
  async recordReportedCost(input: ReportedCostInput, view: string = input.basis): Promise<CostAssessment> {
    if (view === "original")
      throw new TypeError("Reported and invoice costs require a separate view from list-price estimates");
    z.object({
      assessmentId: z.string().min(1).max(1024),
      targetId: z.string().min(1).max(1024),
      targetKind: z.enum(["attempt", "billing_group", "account_period"]),
      basis: z.enum(["provider_reported", "invoice"]),
      finality: z.enum(["provisional", "final"]),
      evidenceVersion: z.string().min(1).max(128),
      sourceUrl: z.url().max(4096),
      includedMeters: z.array(z.string().min(1).max(256)).min(1).max(1000),
    }).parse(input);
    if (
      (input.targetKind === "attempt" && input.attemptId !== input.targetId) ||
      (input.targetKind !== "attempt" && input.attemptId !== undefined)
    )
      throw new TypeError("Reported cost target and attempt identity disagree");
    if (
      !input.assessmentId ||
      !input.targetId ||
      !/^[A-Z]{3}$/.test(input.currency) ||
      !Number.isFinite(Date.parse(input.context.occurredAt))
    )
      throw new TypeError("Reported cost identity, currency and timestamp are required");
    const amount =
      input.basis === "invoice" ? Decimal.from(input.amount).toString() : nonnegativeDecimal(input.amount).toString();
    const tenantId = input.tenantId ?? "local";
    const selection = await this.store.getSelection(tenantId, input.targetKind, input.targetId, view);
    const { evidence: _rawEvidence, ...safeInput } = input;
    const assessment: CostAssessment = {
      ...safeInput,
      tenantId,
      createdAt: input.context.occurredAt,
      usageRevision: (selection?.revision ?? 0) + 1,
      catalogId: input.basis,
      catalogVersion: input.evidenceVersion,
      charges: [
        {
          id: `${input.assessmentId}:reported`,
          measurementId: "reported",
          meter: "money.reported",
          unit: input.currency,
          quantity: "1",
          billedQuantity: "1",
          dimensions: {},
          currency: input.currency,
          amount,
          amountBeforeAdjustments: amount,
          catalogId: input.basis,
          catalogVersion: input.evidenceVersion,
          source: "provider",
          evidencePaths: input.includedMeters,
          inclusion: "payable",
        },
      ],
      knownSubtotal: amount,
      total: amount,
      unpricedCount: 0,
      pricingStatus: "complete",
      usageStatus: "unknown",
      executionStatus: "unknown",
      purpose: "reconcile",
      arithmeticPolicy: "rational-36-half-up-v1",
      reportedEvidence: {
        includedMeters: [...input.includedMeters],
        sourceUrl: input.sourceUrl,
        evidenceVersion: input.evidenceVersion,
        ...(input.evidence ? { raw: retainRawUsage(input.evidence).rawUsage } : {}),
      },
    };
    // A repeated immutable monetary record uses its original revision as well as its original ID.
    const existing = await this.store.getAssessment(tenantId, input.assessmentId);
    if (existing) assessment.usageRevision = existing.usageRevision;
    await this.store.commitAssessmentAndSettle({
      assessment,
      view,
      expectedSelectionRevision: selection?.revision ?? 0,
    });
    return assessment;
  }
  async allocate(
    assessmentId: string,
    members: AllocationMember[],
    options: { tenantId?: string; policyVersion: string; view?: string },
  ): Promise<CostAllocation[]> {
    const tenantId = options.tenantId ?? "local";
    const assessment = await this.store.getAssessment(tenantId, assessmentId);
    if (!assessment || assessment.total === null || assessment.targetKind === "attempt")
      throw new TypeError("Allocation requires a complete group or account assessment");
    const shares = allocateGroupAmount(assessment.total, members);
    const allocations: CostAllocation[] = shares.map((share) => {
      const member = members.find((item) => item.operationId === share.operationId)!;
      return {
        ...member,
        tenantId,
        allocationId: JSON.stringify([
          assessmentId,
          options.view ?? "original",
          options.policyVersion,
          member.operationId,
        ]),
        assessmentId,
        targetKind: assessment!.targetKind as "billing_group" | "account_period",
        targetId: assessment!.targetId,
        operationId: member.operationId,
        policyVersion: options.policyVersion,
        view: options.view ?? "original",
        amount: share.amount,
        currency: assessment!.currency,
        context: assessment!.context,
      };
    });
    await this.store.saveAllocations(allocations);
    return allocations;
  }
  async finalizeGroup(
    targetId: string,
    options: { tenantId?: string; view?: string; confirmedFinal: true },
  ): Promise<CostAssessment> {
    if (options.confirmedFinal !== true)
      throw new TypeError("Group finality requires an explicit confirmed final billing interval");
    const tenantId = options.tenantId ?? "local";
    const view = options.view ?? "original";
    const current = (await this.store.queryAssessments({ tenantId, targetId, view, limit: 1000 })).items.find(
      (item) => item.targetKind === "billing_group",
    );
    if (!current) throw new TypeError("Selected billing group was not found");
    const selection = await this.store.getSelection(tenantId, "billing_group", targetId, view);
    const assessmentId = randomUUID();
    const assessment: CostAssessment = {
      ...current,
      assessmentId,
      charges: current.charges.map((charge) => ({ ...charge, id: `${assessmentId}:${charge.measurementId}` })),
      finality: "final",
      usageRevision: current.usageRevision + 1,
    };
    await this.store.commitAssessmentAndSettle({
      assessment,
      view,
      expectedSelectionRevision: selection?.revision ?? 0,
      projections:
        this.budget && view === "original"
          ? budgetProjections(
              {
                ...this.budget,
                limits: this.budget.limits.filter((limit) => ["tenant", "session"].includes(limit.scope)),
              },
              assessment,
            )
          : [],
    });
    return assessment;
  }
  async checkBudgetAfterUsage(scope: AccountingScope): Promise<BudgetDecision> {
    if (this.budget?.mode !== "reservation") return decideBudget(this.store, this.budget, scope);
    // The accepted stream already owns its reservation. Do not add that full bound
    // to usage from the same still-running request when deciding whether to stop it.
    const balances = await this.store.balances(scope.tenantId ?? "local", budgetScopes(this.budget, scope));
    const exceeded = balances.some((balance) => Decimal.from(balance.spent).compare(Decimal.from(balance.limit)) >= 0);
    if (exceeded)
      return { status: this.budget.onExceeded === "warn" ? "warned" : "blocked", reason: "limit", scopes: balances };
    if (balances.some((balance) => balance.unknownCount > 0))
      return {
        status: this.budget.onUnknown === "warn" ? "warned" : "blocked",
        reason: "unknown_cost",
        scopes: balances,
      };
    return { status: "allowed", scopes: balances };
  }
  async checkBudget(
    scope: AccountingScope & { attemptId?: string; currency?: string },
    bound?: string,
  ): Promise<BudgetDecision> {
    return decideBudget(this.store, this.budget, scope, bound);
  }
  async queryRunUsage(scope: AccountingScope): Promise<TokenUsage> {
    const observations = await this.observations(scope);
    const attempts = new Map<string, UsageObservation[]>();
    for (const observation of observations)
      if (observation.executionStatus !== "started") {
        const values = attempts.get(observation.attemptId) ?? [];
        values.push(observation);
        attempts.set(observation.attemptId, values);
      }
    const counts = [...attempts.values()].map((values) => selectedObservationUsage(values).usage.tokens);
    return {
      promptTokens: Number(sumDecimals(counts.map((token) => String(token?.input.total ?? 0)))),
      completionTokens: Number(sumDecimals(counts.map((token) => String(token?.output.total ?? 0)))),
      totalTokens: Number(sumDecimals(counts.map((token) => String(token?.total ?? 0)))),
      cachedTokens: Number(sumDecimals(counts.map((token) => String(token?.input.cacheRead ?? 0)))),
      cacheWriteTokens: Number(sumDecimals(counts.map((token) => String(token?.input.cacheWrite ?? 0)))),
      reasoningTokens: Number(sumDecimals(counts.map((token) => String(token?.output.reasoning ?? 0)))),
    };
  }
  async close(): Promise<void> {
    await this.flush();
    if (this.ownsStore) await this.store.close?.();
  }
  async flush(): Promise<void> {
    while (this.active.size) await Promise.all([...this.active.values()].map((item) => item.done));
    await Promise.all(this.queues.values());
    for (const input of [...this.pending.values()]) await this.recordUsage(input);
    await this.store.flush();
  }
}
