import type {
  AccountingScope,
  BudgetReservation,
  BudgetScopeBalance,
  CostAllocation,
  CostAssessment,
  CostQueryResult,
  UsageObservation,
  UsagePage,
  UsageQuery,
  UsageRevision,
} from "../accounting-types.js";
import { Decimal, nonnegativeDecimal, sumDecimals } from "../decimal.js";
import type {
  AccountingBackend,
  AccountingStore,
  AccountingTransaction,
  AssessmentSelection,
  BudgetProjection,
  CommitAssessmentInput,
  DocumentQuery,
  StoreCapabilities,
  StoredDocument,
} from "../store.js";
import { AccountingConflictError } from "../store.js";
export function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}
const selectionId = (kind: string, id: string, view: string) => stableJson([kind, id, view]);
function indexes(item: UsageObservation | CostAssessment): Partial<StoredDocument> {
  return {
    runId: item.runId,
    rootRunId: item.rootRunId,
    sessionId: item.sessionId,
    userId: item.userId,
    operationId: item.operationId,
    attemptId: item.attemptId,
    targetId: "targetId" in item ? item.targetId : undefined,
    currency: "currency" in item ? item.currency : undefined,
    providerId: item.context.providerId,
    modelId: item.context.modelId,
    occurredAt: "observedAt" in item ? item.observedAt : item.context.occurredAt,
  };
}
function pageQuery(query: UsageQuery & { targetId?: string }, kind: string): DocumentQuery {
  const limit = query.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new RangeError("Query limit must be an integer between 1 and 1000");
  let after: string | undefined;
  if (query.cursor) {
    const decoded = JSON.parse(Buffer.from(query.cursor, "base64url").toString()) as {
      tenantId: string;
      kind: string;
      after: string;
      filter: string;
    };
    if (
      decoded.filter !== stableJson({ ...query, cursor: undefined, limit: undefined }) ||
      decoded.tenantId !== (query.tenantId ?? "local") ||
      decoded.kind !== kind
    )
      throw new TypeError("Cursor belongs to another query scope");
    after = decoded.after;
  }
  return {
    tenantId: query.tenantId ?? "local",
    kind,
    runId: query.runId,
    rootRunId: query.rootRunId,
    sessionId: query.sessionId,
    userId: query.userId,
    operationId: query.operationId,
    attemptId: query.attemptId,
    targetId: query.targetId,
    currency: query.currency,
    providerId: query.providerId,
    modelId: query.modelId,
    since: query.since,
    until: query.until,
    after,
    limit: limit + 1,
  };
}
function page<T>(rows: Array<{ id: string; value: T }>, query: DocumentQuery, originalQuery: UsageQuery): UsagePage<T> {
  const limit = (query.limit ?? 101) - 1;
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  return {
    items: items.map((item) => item.value),
    nextCursor: more
      ? Buffer.from(
          JSON.stringify({
            tenantId: query.tenantId,
            kind: query.kind,
            after: items.at(-1)?.id,
            filter: stableJson({ ...originalQuery, cursor: undefined, limit: undefined }),
          }),
        ).toString("base64url")
      : null,
  };
}
interface ProjectionRow {
  spent: string;
  reserved: string;
  unknownCount: number;
  currency: string;
}
async function balance(tx: AccountingTransaction, key: string, currency: string): Promise<ProjectionRow> {
  const row = await tx.get<ProjectionRow>("balance", key);
  if (row && row.currency !== currency) throw new AccountingConflictError("Budget scope currency differs");
  return row ?? { spent: "0", reserved: "0", unknownCount: 0, currency };
}
async function authoritativeBalance(tx: AccountingTransaction, key: string, currency: string): Promise<ProjectionRow> {
  const row = await balance(tx, key, currency);
  let parts: unknown;
  try {
    parts = JSON.parse(key);
  } catch {
    return row;
  }
  if (!Array.isArray(parts) || parts.length !== 6 || parts[5] !== currency) return row;
  const [, scope, id, start, end] = parts as string[];
  const fields = {
    run: "runId",
    rootRun: "rootRunId",
    session: "sessionId",
    user: "userId",
    operation: "operationId",
  } as const;
  if (scope !== "tenant" && !(scope in fields)) return row;
  const filter = scope === "tenant" ? {} : { [fields[scope as keyof typeof fields]]: id };
  let after: string | undefined;
  let spent = "0";
  let unknownCount = 0;
  const observedAttempts = new Set<string>();
  const groups = new Set<string>();
  const contributions: Array<{ groupId: string; operationId?: string }> = [];
  do {
    const records = await tx.list<CostAssessment>({
      kind: "selected:original",
      ...filter,
      currency,
      since: start,
      until: end,
      after,
      limit: 1000,
    });
    for (const { value: assessment } of records) {
      if (assessment.attemptId) observedAttempts.add(assessment.attemptId);
      spent = sumDecimals([spent, assessment.knownSubtotal]);
      unknownCount += assessment.unpricedCount;
      if (assessment.targetKind !== "attempt" && assessment.total !== null) groups.add(assessment.targetId);
      for (const charge of assessment.charges)
        if (charge.inclusion === "contribution" && charge.billingGroupId)
          contributions.push({ groupId: charge.billingGroupId, operationId: assessment.operationId });
    }
    after = records.length === 1000 ? records.at(-1)?.id : undefined;
  } while (after);
  const allocated = new Set<string>();
  let allocationAfter: string | undefined;
  do {
    const rows = await tx.list<CostAllocation>({
      kind: "allocation:original",
      ...filter,
      currency,
      since: start,
      until: end,
      after: allocationAfter,
      limit: 1000,
    });
    for (const { value: allocation } of rows) {
      if (allocation.view !== "original") continue;
      const selected = await tx.get<AssessmentSelection>(
        "selection",
        selectionId(allocation.targetKind, allocation.targetId, "original"),
      );
      const policy = await tx.get<string>("allocation_policy", JSON.stringify([allocation.assessmentId, "original"]));
      if (selected?.assessmentId !== allocation.assessmentId || policy !== allocation.policyVersion) continue;
      allocated.add(JSON.stringify([allocation.targetId, allocation.operationId]));
      if (!groups.has(allocation.targetId)) spent = sumDecimals([spent, allocation.amount]);
    }
    allocationAfter = rows.length === 1000 ? rows.at(-1)?.id : undefined;
  } while (allocationAfter);
  for (const contribution of contributions)
    if (
      groups.has(contribution.groupId) ||
      allocated.has(JSON.stringify([contribution.groupId, contribution.operationId]))
    )
      unknownCount--;
  let intentAfter: string | undefined;
  do {
    const rows = await tx.list<UsageObservation>({
      kind: "observation",
      ...filter,
      since: start,
      until: end,
      after: intentAfter,
      limit: 1000,
    });
    for (const { value: intent } of rows)
      if (intent.executionStatus === "started" && !observedAttempts.has(intent.attemptId)) {
        observedAttempts.add(intent.attemptId);
        const reservation = await tx.get<BudgetReservation>("reservation", `${intent.attemptId}:reservation`);
        if (!reservation || reservation.status === "released") unknownCount++;
      }
    intentAfter = rows.length === 1000 ? rows.at(-1)?.id : undefined;
  } while (intentAfter);
  return { ...row, spent, unknownCount };
}
async function immutable(
  tx: AccountingTransaction,
  kind: string,
  id: string,
  payload: unknown,
  extra: Partial<StoredDocument> = {},
): Promise<"inserted" | "duplicate"> {
  const existing = await tx.get(kind, id);
  if (existing !== null) {
    if (stableJson(existing) !== stableJson(payload))
      throw new AccountingConflictError(`Conflicting immutable ${kind}: ${id}`);
    return "duplicate";
  }
  await tx.put({ ...extra, kind, id, payload });
  return "inserted";
}
interface RunLineage {
  rootRunId: string;
  parentRunId?: string;
  ancestorRunIds: string[];
}
async function retainRunLineage(tx: AccountingTransaction, scope: AccountingScope): Promise<void> {
  if (!scope.runId) return;
  const rootRunId = scope.rootRunId ?? scope.ancestorRunIds?.[0] ?? scope.parentRunId ?? scope.runId;
  const ancestors = [
    ...new Set([
      ...(rootRunId !== scope.runId ? [rootRunId] : []),
      ...(scope.ancestorRunIds ?? []),
      ...(scope.parentRunId ? [scope.parentRunId] : []),
    ]),
  ].filter((id) => id !== scope.runId);
  const path = [...ancestors, scope.runId];
  for (let index = 0; index < path.length; index++) {
    const id = path[index];
    const known = await tx.get<RunLineage>("run_lineage", id);
    if (known && known.rootRunId !== rootRunId)
      throw new AccountingConflictError("Run ID belongs to another root; use a new run ID");
    const next: RunLineage = {
      rootRunId,
      parentRunId: index ? path[index - 1] : undefined,
      ancestorRunIds: path.slice(0, index),
    };
    // An ancestor inferred from an incomplete legacy path must not erase a richer path.
    if (!known || next.ancestorRunIds.length > known.ancestorRunIds.length)
      await tx.put({ kind: "run_lineage", id, payload: next, runId: id, rootRunId });
  }
}
export class TransactionalAccountingStore implements AccountingStore {
  readonly capabilities: StoreCapabilities;
  constructor(protected readonly backend: AccountingBackend) {
    this.capabilities = backend.capabilities;
  }
  async appendObservation(observation: UsageObservation): Promise<"inserted" | "duplicate"> {
    return this.backend.transaction(observation.tenantId, async (tx) => {
      await retainRunLineage(tx, observation);
      return immutable(
        tx,
        "observation",
        JSON.stringify([observation.attemptId, observation.observationId]),
        observation,
        indexes(observation),
      );
    });
  }
  async appendUsageRevision(revision: UsageRevision): Promise<"inserted" | "duplicate"> {
    return this.backend.transaction(revision.tenantId, (tx) =>
      immutable(tx, "usage_revision", JSON.stringify([revision.attemptId, revision.revision]), revision),
    );
  }
  async queryUsage(query: UsageQuery): Promise<UsagePage<UsageObservation>> {
    const q = pageQuery(query, "observation");
    return this.backend.transaction(q.tenantId, async (tx) => {
      const rows = await tx.list<UsageObservation>(q);
      const filtered = query.attemptId ? rows.filter((row) => row.value.attemptId === query.attemptId) : rows;
      return page(filtered, q, query);
    });
  }
  async queryAssessments(
    query: UsageQuery & { selected?: boolean; targetId?: string },
  ): Promise<UsagePage<CostAssessment>> {
    const selected = query.selected ?? true;
    const q = pageQuery(query, selected ? `selected:${query.view ?? "original"}` : "assessment");
    return this.backend.transaction(q.tenantId, async (tx) => {
      const rows = await tx.list<CostAssessment>(q);
      return page(
        rows.filter(
          (row) =>
            (!query.attemptId || row.value.attemptId === query.attemptId) &&
            (!query.targetId || row.value.targetId === query.targetId) &&
            (!query.currency || row.value.currency === query.currency),
        ),
        q,
        query,
      );
    });
  }
  async getAssessment(tenantId: string, assessmentId: string): Promise<CostAssessment | null> {
    return this.backend.transaction(tenantId, (tx) => tx.get("assessment", assessmentId));
  }
  async getSelection(
    tenantId: string,
    targetKind: CostAssessment["targetKind"],
    targetId: string,
    view: string,
  ): Promise<AssessmentSelection | null> {
    return this.backend.transaction(tenantId, (tx) => tx.get("selection", selectionId(targetKind, targetId, view)));
  }
  async commitAssessmentAndSettle(input: CommitAssessmentInput): Promise<"committed" | "duplicate"> {
    return (await this.commitAssessmentsAndSettle([input]))[0];
  }
  async commitAssessmentsAndSettle(inputs: CommitAssessmentInput[]): Promise<Array<"committed" | "duplicate">> {
    if (!inputs.length) return [];
    const tenantId = inputs[0].assessment.tenantId;
    if (inputs.some((input) => input.assessment.tenantId !== tenantId))
      throw new TypeError("Atomic assessment batch must belong to one tenant");
    return this.backend.transaction(tenantId, async (tx) => {
      for (const input of inputs) await retainRunLineage(tx, input.assessment);
      const results: Array<"committed" | "duplicate"> = [];
      for (const input of inputs) results.push(await this.commit(tx, input));
      for (const input of inputs)
        if (input.reservationId && input.assessment.usageStatus === "complete") {
          const reservation = await tx.get<BudgetReservation>("reservation", input.reservationId);
          if (reservation?.status !== "uncertain") continue;
          let covered = true;
          for (const charge of input.assessment.charges)
            if (charge.amount === null) {
              if (!charge.billingGroupId) {
                covered = false;
                break;
              }
              const group = await tx.get<CostAssessment>(
                `selected:${input.view}`,
                selectionId("billing_group", charge.billingGroupId, input.view),
              );
              if (!group || group.total === null) {
                covered = false;
                break;
              }
              for (const scope of reservation.scopes) {
                let parsed: unknown;
                try {
                  parsed = JSON.parse(scope.key);
                } catch {
                  covered = false;
                  continue;
                }
                if (
                  !Array.isArray(parsed) ||
                  !(parsed[1] === "tenant" || (parsed[1] === "session" && parsed[2] === group.sessionId))
                )
                  covered = false;
              }
            }
          if (covered) {
            for (const scope of reservation.scopes) {
              const row = await balance(tx, scope.key, reservation.currency);
              row.reserved = Decimal.from(row.reserved).subtract(Decimal.from(reservation.amount)).toString();
              await tx.put({ kind: "balance", id: scope.key, payload: row });
            }
            reservation.status = "settled";

            await tx.put({ kind: "reservation", id: reservation.reservationId, payload: reservation });
          }
        }
      return results;
    });
  }
  private async commit(tx: AccountingTransaction, input: CommitAssessmentInput): Promise<"committed" | "duplicate"> {
    const { assessment, view } = input;
    const key = selectionId(assessment.targetKind, assessment.targetId, view);
    const current = await tx.get<AssessmentSelection>("selection", key);
    const existing = await tx.get<CostAssessment>("assessment", assessment.assessmentId);
    if (existing && stableJson(existing) !== stableJson(assessment))
      throw new AccountingConflictError("Assessment ID was reused with different content");
    if (current?.assessmentId === assessment.assessmentId) return "duplicate";
    if ((current?.revision ?? 0) !== input.expectedSelectionRevision)
      throw new AccountingConflictError("Stale assessment selection revision");
    if (input.usageRevision)
      await immutable(
        tx,
        "usage_revision",
        JSON.stringify([input.usageRevision.attemptId, input.usageRevision.revision]),
        input.usageRevision,
      );
    await immutable(tx, "assessment", assessment.assessmentId, assessment, indexes(assessment));
    const previous = (await tx.get<BudgetProjection[]>("selection_projections", key)) ?? [];
    const next = input.projections ?? [];
    const scopeKeys = new Set([...previous.map((p) => p.key), ...next.map((p) => p.key)]);
    for (const scopeKey of scopeKeys) {
      const old = previous.find((p) => p.key === scopeKey);
      const replacement = next.find((p) => p.key === scopeKey);
      const row = await balance(tx, scopeKey, replacement?.currency ?? old?.currency ?? assessment.currency);
      row.spent = Decimal.from(row.spent)
        .subtract(Decimal.from(old?.amount ?? "0"))
        .add(Decimal.from(replacement?.amount ?? "0"))
        .toString();
      row.unknownCount += Number(replacement?.unknown ?? false) - Number(old?.unknown ?? false);
      await tx.put({ kind: "balance", id: scopeKey, payload: row });
    }
    if (input.reservationId) {
      const reservation = await tx.get<BudgetReservation>("reservation", input.reservationId);
      if (!reservation || reservation.attemptId !== assessment.attemptId)
        throw new AccountingConflictError("Assessment reservation does not match its attempt");
      if (reservation.status === "reserved" || reservation.status === "uncertain") {
        if (assessment.total === null || assessment.executionStatus === "unknown") reservation.status = "uncertain";
        else {
          for (const scope of reservation.scopes) {
            const row = await balance(tx, scope.key, reservation.currency);
            row.reserved = Decimal.from(row.reserved).subtract(Decimal.from(reservation.amount)).toString();
            await tx.put({ kind: "balance", id: scope.key, payload: row });
          }
          reservation.status = "settled";
        }
        await tx.put({ kind: "reservation", id: reservation.reservationId, payload: reservation });
      }
    }
    await tx.put({ kind: "selection_projections", id: key, payload: next });
    await tx.put({
      kind: "selection",
      id: key,
      payload: {
        tenantId: assessment.tenantId,
        targetKind: assessment.targetKind,
        targetId: assessment.targetId,
        view,
        assessmentId: assessment.assessmentId,
        revision: (current?.revision ?? 0) + 1,
      } satisfies AssessmentSelection,
    });
    await tx.put({ ...indexes(assessment), kind: `selected:${view}`, id: key, payload: assessment });
    return "committed";
  }
  async saveAllocations(allocations: CostAllocation[]): Promise<void> {
    if (!allocations.length) throw new TypeError("Allocation members are required");
    const first = allocations[0];
    await this.backend.transaction(first.tenantId, async (tx) => {
      const assessment = await tx.get<CostAssessment>("assessment", first.assessmentId);
      if (!assessment || assessment.total === null || assessment.targetKind === "attempt")
        throw new TypeError("Only complete group or account assessments can be allocated");
      const operations = new Set<string>();
      for (const item of allocations) {
        if (
          item.tenantId !== first.tenantId ||
          item.assessmentId !== first.assessmentId ||
          item.currency !== assessment.currency ||
          item.targetId !== assessment.targetId ||
          item.policyVersion !== first.policyVersion ||
          item.view !== first.view ||
          operations.has(item.operationId)
        )
          throw new AccountingConflictError("Allocation members have conflicting scope or identity");
        operations.add(item.operationId);
      }
      if (
        Decimal.from(sumDecimals(allocations.map((item) => item.amount))).compare(Decimal.from(assessment.total)) !== 0
      )
        throw new AccountingConflictError("Allocation shares must sum exactly to the assessment amount");
      for (const item of allocations)
        await immutable(tx, "allocation", item.allocationId, item, {
          runId: item.runId,
          rootRunId: item.rootRunId,
          sessionId: item.sessionId,
          userId: item.userId,
          operationId: item.operationId,
          providerId: item.context.providerId,
          modelId: item.context.modelId,
          currency: item.currency,
          occurredAt: item.context.occurredAt,
          targetId: item.targetId,
        });
      for (const item of allocations)
        await tx.put({
          kind: `allocation:${item.view}`,
          id: item.allocationId,
          payload: item,
          runId: item.runId,
          rootRunId: item.rootRunId,
          sessionId: item.sessionId,
          userId: item.userId,
          operationId: item.operationId,
          providerId: item.context.providerId,
          modelId: item.context.modelId,
          currency: item.currency,
          occurredAt: item.context.occurredAt,
          targetId: item.targetId,
        });
      await tx.put({
        kind: "allocation_policy",
        id: JSON.stringify([first.assessmentId, first.view]),
        payload: first.policyVersion,
      });
    });
  }
  async queryAllocations(query: UsageQuery): Promise<UsagePage<CostAllocation>> {
    const q = pageQuery(query, `allocation:${query.view ?? "original"}`);
    return this.backend.transaction(q.tenantId, async (tx) => page(await tx.list<CostAllocation>(q), q, query));
  }
  async queryCosts(query: UsageQuery): Promise<CostQueryResult> {
    const currency = query.currency ?? "USD";
    const q = pageQuery(
      { ...query, runId: query.includeChildren ? undefined : query.runId, currency, limit: 1000, cursor: undefined },
      `selected:${query.view ?? "original"}`,
    );
    return this.backend.transaction(q.tenantId, async (tx) => {
      let includedRuns: Set<string> | undefined;
      if (query.includeChildren && query.runId) {
        const lineage = await tx.get<RunLineage>("run_lineage", query.runId);
        q.rootRunId = query.rootRunId ?? lineage?.rootRunId;
        // With no retained descendants, stay on the indexed leaf scope.
        if (!q.rootRunId) q.runId = query.runId;
        includedRuns = new Set([query.runId]);
        if (q.rootRunId) {
          let cursor: string | undefined;
          do {
            const rows = await tx.list<RunLineage>({
              kind: "run_lineage",
              rootRunId: q.rootRunId,
              after: cursor,
              limit: 1000,
            });
            for (const { id, value } of rows)
              if (id === query.runId || value.ancestorRunIds.includes(query.runId)) includedRuns.add(id);
            cursor = rows.length === 1000 ? rows.at(-1)?.id : undefined;
          } while (cursor);
        }
      }
      let subtotal = "0";
      let unpricedCount = 0;
      let count = 0;
      let unallocated = "0";
      let provisional = false;
      const groups = new Set<string>();
      const contributions = new Map<string, number>();
      const contributionOperations: Array<{ groupId: string; operationId?: string }> = [];
      const attempts = new Set<string>();
      const operations = new Set<string>();
      const runs = new Set<string>();
      let after: string | undefined;
      do {
        const rows = await tx.list<CostAssessment>({ ...q, after, limit: 1000 });
        for (const { value: item } of rows) {
          if (
            item.currency !== currency ||
            (query.attemptId && item.attemptId !== query.attemptId) ||
            (includedRuns && !includedRuns.has(item.runId ?? ""))
          )
            continue;
          subtotal = sumDecimals([subtotal, item.knownSubtotal]);
          unpricedCount += item.unpricedCount;
          count++;
          if (item.targetKind !== "attempt" && item.total !== null) groups.add(item.targetId);
          for (const charge of item.charges)
            if (charge.inclusion === "contribution" && charge.billingGroupId) {
              contributions.set(charge.billingGroupId, (contributions.get(charge.billingGroupId) ?? 0) + 1);
              contributionOperations.push({ groupId: charge.billingGroupId, operationId: item.operationId });
            }
          if (item.attemptId) attempts.add(item.attemptId);
          if (item.operationId) operations.add(item.operationId);
          if (item.runId) runs.add(item.runId);
          if (item.finality === "provisional") provisional = true;
          if (item.targetKind !== "attempt") unallocated = sumDecimals([unallocated, item.knownSubtotal]);
        }
        after = rows.length === 1000 ? rows.at(-1)?.id : undefined;
      } while (after);
      const allocatedOperations = new Set<string>();
      const allocatedGroups = new Map<string, "billing_group" | "account_period">();
      let allocationCursor: string | undefined;
      do {
        const allocations = await tx.list<CostAllocation>({
          ...q,
          kind: `allocation:${query.view ?? "original"}`,
          after: allocationCursor,
          limit: 1000,
        });
        for (const { value: allocation } of allocations) {
          if (
            allocation.view !== (query.view ?? "original") ||
            (includedRuns && !includedRuns.has(allocation.runId ?? ""))
          )
            continue;
          const selected = await tx.get<AssessmentSelection>(
            "selection",
            selectionId(allocation.targetKind, allocation.targetId, allocation.view),
          );
          const policy = await tx.get<string>(
            "allocation_policy",
            JSON.stringify([allocation.assessmentId, allocation.view]),
          );
          if (selected?.assessmentId !== allocation.assessmentId || policy !== allocation.policyVersion) continue;
          allocatedGroups.set(allocation.targetId, allocation.targetKind);
          allocatedOperations.add(JSON.stringify([allocation.targetId, allocation.operationId]));
          if (!groups.has(allocation.targetId)) subtotal = sumDecimals([subtotal, allocation.amount]);
        }
        allocationCursor = allocations.length === 1000 ? allocations.at(-1)?.id : undefined;
      } while (allocationCursor);
      for (const contribution of contributionOperations)
        if (
          groups.has(contribution.groupId) ||
          allocatedOperations.has(JSON.stringify([contribution.groupId, contribution.operationId]))
        )
          unpricedCount--;
      for (const [group, kind] of allocatedGroups)
        if (groups.has(group)) {
          const selectedGroup = await tx.get<CostAssessment>(
            `selected:${query.view ?? "original"}`,
            selectionId(kind, group, query.view ?? "original"),
          );
          if (selectedGroup)
            unallocated = Decimal.from(unallocated).subtract(Decimal.from(selectedGroup.knownSubtotal)).toString();
        }
      let intentCursor: string | undefined;
      do {
        const intents = await tx.list<UsageObservation>({
          ...q,
          kind: "observation",
          currency: undefined,
          after: intentCursor,
          limit: 1000,
        });
        for (const { value: intent } of intents)
          if (
            intent.executionStatus === "started" &&
            !attempts.has(intent.attemptId) &&
            (!includedRuns || includedRuns.has(intent.runId ?? ""))
          ) {
            attempts.add(intent.attemptId);
            unpricedCount++;
            provisional = true;
            if (intent.operationId) operations.add(intent.operationId);
            if (intent.runId) runs.add(intent.runId);
          }
        intentCursor = intents.length === 1000 ? intents.at(-1)?.id : undefined;
      } while (intentCursor);
      return {
        currency,
        knownSubtotal: subtotal,
        total: unpricedCount === 0 ? subtotal : null,
        pricingStatus: unpricedCount === 0 ? "complete" : subtotal !== "0" ? "partial" : "unpriced",
        unpricedCount,
        assessmentCount: count,
        attemptCount: attempts.size,
        operationCount: operations.size,
        runCount: runs.size,
        asOf: new Date().toISOString(),
        finality: provisional ? "provisional" : "final",
        unallocatedSubtotal: unallocated,
      };
    });
  }
  async reserve(reservation: BudgetReservation): Promise<{ accepted: boolean; balances: BudgetScopeBalance[] }> {
    nonnegativeDecimal(reservation.amount);
    if (
      reservation.status !== "reserved" ||
      new Set(reservation.scopes.map((scope) => scope.key)).size !== reservation.scopes.length
    )
      throw new TypeError("Reservation must have unique scope keys and reserved state");
    for (const scope of reservation.scopes) nonnegativeDecimal(scope.limit);
    return this.backend.transaction(reservation.tenantId, async (tx) => {
      const existing = await tx.get<BudgetReservation>("reservation", reservation.reservationId);
      if (existing) {
        if (
          stableJson({ ...existing, status: "reserved", createdAt: undefined }) !==
          stableJson({ ...reservation, createdAt: undefined })
        )
          throw new AccountingConflictError("Reservation ID conflict");
        return { accepted: existing.status !== "released", balances: [] };
      }
      const rows: Array<{ key: string; limit: string; row: ProjectionRow }> = [];
      for (const scope of reservation.scopes)
        rows.push({ ...scope, row: await authoritativeBalance(tx, scope.key, reservation.currency) });
      const balances = rows.map(({ key, limit, row }) => ({ key, limit, ...row }));
      if (
        rows.some(
          ({ limit, row }) =>
            row.unknownCount > 0 ||
            Decimal.from(row.spent)
              .add(Decimal.from(row.reserved))
              .add(Decimal.from(reservation.amount))
              .compare(Decimal.from(limit)) > 0,
        )
      )
        return { accepted: false, balances };
      for (const { key, row } of rows) {
        row.reserved = sumDecimals([row.reserved, reservation.amount]);
        await tx.put({ kind: "balance", id: key, payload: row });
      }
      await tx.put({ kind: "reservation", id: reservation.reservationId, payload: reservation });
      return { accepted: true, balances };
    });
  }
  async balances(
    tenantId: string,
    scopes: Array<{ key: string; limit: string; currency: string }>,
  ): Promise<BudgetScopeBalance[]> {
    return this.backend.transaction(tenantId, async (tx) => {
      const result: BudgetScopeBalance[] = [];
      for (const scope of scopes)
        result.push({
          key: scope.key,
          limit: scope.limit,
          ...(await authoritativeBalance(tx, scope.key, scope.currency)),
        });
      return result;
    });
  }
  async releaseReservation(tenantId: string, reservationId: string, confirmedNotAccepted: boolean): Promise<void> {
    if (!confirmedNotAccepted)
      throw new TypeError(
        "An accepted or uncertain request needs reconciliation; its reservation cannot expire automatically",
      );
    await this.backend.transaction(tenantId, async (tx) => {
      const reservation = await tx.get<BudgetReservation>("reservation", reservationId);
      if (!reservation || reservation.status === "released" || reservation.status === "settled") return;
      for (const scope of reservation.scopes) {
        const row = await balance(tx, scope.key, reservation.currency);
        row.reserved = Decimal.from(row.reserved).subtract(Decimal.from(reservation.amount)).toString();
        await tx.put({ kind: "balance", id: scope.key, payload: row });
      }
      reservation.status = "released";
      await tx.put({ kind: "reservation", id: reservationId, payload: reservation });
    });
  }
  async getReservation(tenantId: string, reservationId: string): Promise<BudgetReservation | null> {
    return this.backend.transaction(tenantId, (tx) => tx.get("reservation", reservationId));
  }
  async flush(): Promise<void> {}
  async close(): Promise<void> {
    await this.backend.close();
  }
}
