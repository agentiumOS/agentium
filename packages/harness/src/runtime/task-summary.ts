import type { RunContext } from "@agentium/core";
import { z } from "zod/v3";
import type { HistoryArchiveReference } from "./history.js";
import type { EvidenceExcerpt, EvidenceReference, RecallCycle, RecallDiagnostic, RecallScope } from "./recall.js";
import {
  archiveReferenceSchema,
  evidenceReferenceSchema,
  recallDiagnostic,
  recallScopeSchema,
  referencesEqual,
  scopesEqual,
  serializedBytes,
} from "./recall.js";

export type TaskSummaryDraft = { text: string; evidenceIds: readonly string[]; uncertainties: readonly string[] };
export type TaskSummaryCoverage = {
  conversationId: string;
  throughArchiveOrdinal: number;
  throughArchiveId: string;
  throughArchiveDigest: string;
  throughMessage: number;
};
export type TaskSummaryRecord = {
  contractVersion: 1;
  id: string;
  revision: number;
  policyId: string;
  policyVersion: number;
  recordedAt: number;
  trust: "source";
  draft: TaskSummaryDraft;
  evidence: readonly { id: string; reference: EvidenceReference }[];
  coverage: TaskSummaryCoverage;
  previousRevision?: number;
  sourceViewRevision: string;
  scope: RecallScope;
};
export interface TaskSummaryPolicy {
  id: string;
  version: number;
  update(
    input: { previous?: TaskSummaryRecord; additions: readonly EvidenceExcerpt[] },
    ctx: RunContext,
  ): Promise<TaskSummaryDraft>;
}
export type TaskSummaryConfig = {
  policy: TaskSummaryPolicy;
  maxInputBytes: number;
  maxSummaryBytes: number;
  maxSummaryTokens: number;
  maxEvidenceReferences: number;
  maxRecordBytes: number;
  maxSummaryRecords: number;
};
export type TaskSummaryBatch = {
  additions: EvidenceExcerpt[];
  coverage?: TaskSummaryCoverage;
  diagnostics: RecallDiagnostic[];
};
const nonempty = z
  .string()
  .min(1)
  .refine((value) => Boolean(value.trim()));
const positive = z.number().int().positive().safe();
const natural = z.number().int().nonnegative().safe();
export const taskSummaryDraftSchema = z
  .object({ text: nonempty, evidenceIds: z.array(nonempty), uncertainties: z.array(nonempty) })
  .strict();
const coverageSchema = z
  .object({
    conversationId: nonempty,
    throughArchiveOrdinal: natural,
    throughArchiveId: nonempty,
    throughArchiveDigest: nonempty,
    throughMessage: positive,
  })
  .strict();
const recordSchema = z
  .object({
    contractVersion: z.literal(1),
    id: nonempty,
    revision: positive,
    policyId: nonempty,
    policyVersion: positive,
    recordedAt: natural,
    trust: z.literal("source"),
    draft: taskSummaryDraftSchema,
    evidence: z.array(z.object({ id: nonempty, reference: evidenceReferenceSchema }).strict()),
    coverage: coverageSchema,
    previousRevision: positive.optional(),
    sourceViewRevision: nonempty,
    scope: recallScopeSchema,
  })
  .strict();

export function validateTaskSummaryConfiguration(
  config: TaskSummaryConfig,
  hasResidentHistory = true,
  hasRecallReader = true,
): void {
  if (!hasResidentHistory || !hasRecallReader)
    throw new TypeError("Incremental task summaries require resident history and bounded canonical recall");
  if (
    !config.policy?.id?.trim() ||
    !Number.isSafeInteger(config.policy.version) ||
    config.policy.version <= 0 ||
    typeof config.policy.update !== "function"
  )
    throw new TypeError("Invalid task summary policy");
  for (const value of [
    config.maxInputBytes,
    config.maxSummaryBytes,
    config.maxSummaryTokens,
    config.maxEvidenceReferences,
    config.maxRecordBytes,
    config.maxSummaryRecords,
  ])
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new TypeError("Task summary bounds must be positive safe integers");
}
function canonicalArchives(
  archives: readonly HistoryArchiveReference[],
  conversationId: string,
): HistoryArchiveReference[] {
  return archives.filter((archive) => archive.conversationId === conversationId);
}
function validCoverage(coverage: TaskSummaryCoverage, archives: readonly HistoryArchiveReference[]): boolean {
  const archive = canonicalArchives(archives, coverage.conversationId)[coverage.throughArchiveOrdinal];
  return Boolean(
    archive &&
      archiveReferenceSchema.safeParse(archive).success &&
      archive.id === coverage.throughArchiveId &&
      archive.digest === coverage.throughArchiveDigest &&
      coverage.throughMessage > 0 &&
      coverage.throughMessage <= archive.messageCount,
  );
}
export function validateTaskSummaryRecord(
  raw: unknown,
  options: {
    scope: RecallScope;
    policy: TaskSummaryPolicy;
    archives: readonly HistoryArchiveReference[];
    config: TaskSummaryConfig;
    conversationId?: string;
    viewRevision?: string;
    estimateTokens?: (text: string) => number;
  },
): TaskSummaryRecord | undefined {
  try {
    if (serializedBytes(raw) > options.config.maxRecordBytes) return undefined;
    const result = recordSchema.safeParse(raw);
    if (!result.success) return undefined;
    const record = result.data;
    if (
      !scopesEqual(record.scope, options.scope) ||
      record.policyId !== options.policy.id ||
      record.policyVersion !== options.policy.version ||
      (options.viewRevision !== undefined && record.sourceViewRevision !== options.viewRevision) ||
      (options.conversationId !== undefined && record.coverage.conversationId !== options.conversationId) ||
      !validCoverage(record.coverage, options.archives)
    )
      return undefined;
    if (record.revision === 1 ? record.previousRevision !== undefined : record.previousRevision !== record.revision - 1)
      return undefined;
    if (
      Buffer.byteLength(JSON.stringify(record.draft)) > options.config.maxSummaryBytes ||
      (options.estimateTokens ?? ((text) => Math.ceil(Buffer.byteLength(text) / 4)))(JSON.stringify(record.draft)) >
        options.config.maxSummaryTokens ||
      record.evidence.length > options.config.maxEvidenceReferences ||
      record.draft.evidenceIds.length !== record.evidence.length ||
      new Set(record.draft.evidenceIds).size !== record.draft.evidenceIds.length ||
      new Set(record.evidence.map((item) => item.id)).size !== record.evidence.length
    )
      return undefined;
    const allowed = new Set(record.evidence.map((item) => item.id));
    if (record.draft.evidenceIds.some((id) => !allowed.has(id))) return undefined;
    const archives = canonicalArchives(options.archives, record.coverage.conversationId);
    for (const { reference } of record.evidence) {
      const ordinal = archives.findIndex((item) => item.id === reference.archive?.id);
      const archive = archives[ordinal];
      if (
        !archive ||
        !reference.archive ||
        !reference.messageRange ||
        archive.digest !== reference.archive.digest ||
        archive.messageCount !== reference.archive.messageCount ||
        ordinal > record.coverage.throughArchiveOrdinal ||
        (ordinal === record.coverage.throughArchiveOrdinal &&
          reference.messageRange.end > record.coverage.throughMessage)
      )
        return undefined;
    }
    return structuredClone(record);
  } catch {
    return undefined;
  }
}

/** Calculate the exact prefix from attested groups. The model never chooses coverage. */
export function advanceTaskSummaryCoverage(
  previous: TaskSummaryRecord | undefined,
  additions: readonly EvidenceExcerpt[],
  archives: readonly HistoryArchiveReference[],
  conversationId: string,
): TaskSummaryCoverage | undefined {
  const canonical = canonicalArchives(archives, conversationId);
  if (previous && (previous.coverage.conversationId !== conversationId || !validCoverage(previous.coverage, archives)))
    return undefined;
  let ordinal = previous?.coverage.throughArchiveOrdinal ?? 0;
  let cursor = previous?.coverage.throughMessage ?? 0;
  let coverage = previous?.coverage;
  for (const excerpt of additions) {
    let archive = canonical[ordinal];
    if (archive && cursor === archive.messageCount) {
      ordinal++;
      cursor = 0;
      archive = canonical[ordinal];
    }
    const { reference } = excerpt;
    if (
      !archive ||
      !reference.archive ||
      !reference.messageRange ||
      !excerpt.completeGroup ||
      excerpt.completeness !== "complete" ||
      excerpt.omissions.length ||
      !evidenceReferenceSchema.safeParse(reference).success ||
      reference.archive.id !== archive.id ||
      reference.archive.digest !== archive.digest ||
      reference.archive.conversationId !== conversationId ||
      reference.archive.messageCount !== archive.messageCount ||
      reference.messageRange.start !== cursor
    )
      return undefined;
    cursor = reference.messageRange.end;
    coverage = {
      conversationId,
      throughArchiveOrdinal: ordinal,
      throughArchiveId: archive.id,
      throughArchiveDigest: archive.digest,
      throughMessage: cursor,
    };
  }
  return coverage;
}

export async function readTaskSummaryAdditions(
  cycle: RecallCycle,
  options: {
    previous?: TaskSummaryRecord;
    archives: readonly HistoryArchiveReference[];
    conversationId: string;
    maxInputBytes: number;
  },
): Promise<TaskSummaryBatch> {
  const batch: TaskSummaryBatch = { additions: [], diagnostics: [] };
  const canonical = canonicalArchives(options.archives, options.conversationId);
  if (
    options.previous &&
    (options.previous.coverage.conversationId !== options.conversationId ||
      !validCoverage(options.previous.coverage, options.archives))
  ) {
    batch.diagnostics.push(recallDiagnostic("invalid_response", "summary"));
    return batch;
  }
  let ordinal = options.previous?.coverage.throughArchiveOrdinal ?? 0;
  let cursor = options.previous?.coverage.throughMessage ?? 0;
  while (ordinal < canonical.length) {
    const archive = canonical[ordinal];
    if (!archive) break;
    if (cursor === archive.messageCount) {
      ordinal++;
      cursor = 0;
      continue;
    }
    const reference: EvidenceReference = {
      sourceId: archive.id,
      sourceRevision: archive.digest,
      locator: `archive:${archive.id}:messages:${cursor}-${archive.messageCount}`,
      archive,
      messageRange: { start: cursor, end: archive.messageCount },
    };
    const excerpt = await cycle.read(reference, { completeGroup: true });
    if (!excerpt) {
      batch.diagnostics.push(recallDiagnostic("unavailable_coverage", "summary"));
      break;
    }
    const next = [...batch.additions, excerpt];
    if (serializedBytes({ previous: options.previous, additions: next }) > options.maxInputBytes) {
      batch.diagnostics.push(recallDiagnostic("pending_summary", "summary"));
      break;
    }
    const coverage = advanceTaskSummaryCoverage(options.previous, next, options.archives, options.conversationId);
    if (!coverage) {
      batch.diagnostics.push(recallDiagnostic("unavailable_coverage", "summary"));
      break;
    }
    batch.additions.push(excerpt);
    batch.coverage = coverage;
    cursor = coverage.throughMessage;
  }
  return batch;
}

export type UpdateTaskSummaryOptions = {
  previous?: TaskSummaryRecord;
  additions: readonly EvidenceExcerpt[];
  coverage: TaskSummaryCoverage;
  archives: readonly HistoryArchiveReference[];
  scope: RecallScope;
  config: TaskSummaryConfig;
  ctx: RunContext;
  cycle: RecallCycle;
  taskTokenFloor: number;
  remainingTokens: number;
  recordCount?: number;
  estimateTokens?: (text: string) => number;
};
export type TaskSummaryUpdateResult = { record?: TaskSummaryRecord; diagnostics: RecallDiagnostic[]; updated: boolean };
export async function updateTaskSummary(options: UpdateTaskSummaryOptions): Promise<TaskSummaryUpdateResult> {
  const { config, ctx, cycle } = options;
  ctx.signal?.throwIfAborted();
  const unchanged = (code: RecallDiagnostic["code"]): TaskSummaryUpdateResult => ({
    record: options.previous,
    diagnostics: [recallDiagnostic(code, "summary")],
    updated: false,
  });
  if (!options.additions.length) return { record: options.previous, diagnostics: [], updated: false };
  const coverage = advanceTaskSummaryCoverage(
    options.previous,
    options.additions,
    options.archives,
    options.coverage.conversationId,
  );
  if (
    !coverage ||
    coverage.conversationId !== options.coverage.conversationId ||
    coverage.throughArchiveOrdinal !== options.coverage.throughArchiveOrdinal ||
    coverage.throughArchiveId !== options.coverage.throughArchiveId ||
    coverage.throughArchiveDigest !== options.coverage.throughArchiveDigest ||
    coverage.throughMessage !== options.coverage.throughMessage ||
    !cycle.viewRevision
  )
    return unchanged("invalid_response");
  if (
    options.previous &&
    !validateTaskSummaryRecord(options.previous, {
      scope: options.scope,
      policy: config.policy,
      archives: options.archives,
      config,
      conversationId: options.coverage.conversationId,
      viewRevision: cycle.viewRevision,
    })
  )
    return { diagnostics: [recallDiagnostic("revision_changed", "summary")], updated: false };
  if (!options.previous && (options.recordCount ?? 0) >= config.maxSummaryRecords) return unchanged("pending_summary");
  const input = { ...(options.previous ? { previous: options.previous } : {}), additions: options.additions };
  const inputBytes = serializedBytes(input);
  // Explicit advisory floor; provider ledger still performs final admission.
  if (
    !Number.isSafeInteger(options.taskTokenFloor) ||
    options.taskTokenFloor < 0 ||
    options.remainingTokens < 0 ||
    inputBytes > config.maxInputBytes ||
    options.taskTokenFloor + inputBytes + 1024 + config.maxSummaryTokens > options.remainingTokens
  )
    return unchanged("pending_summary");
  try {
    const raw = await config.policy.update(structuredClone(input), ctx);
    ctx.signal?.throwIfAborted();
    const previousReferences = options.previous?.evidence ?? [];
    const references = [
      ...previousReferences.map((item) => item.reference),
      ...options.additions.map((item) => item.reference),
    ];
    const validity = await cycle.validate(references);
    if (!validity.valid)
      return { diagnostics: [recallDiagnostic(validity.code ?? "backend_failure", "summary")], updated: false };
    const draft = taskSummaryDraftSchema.parse(raw);
    const mapping = new Map(previousReferences.map((item) => [item.id, item.reference]));
    for (const item of options.additions) {
      const existing = mapping.get(item.id);
      if (existing && !referencesEqual(existing, item.reference)) return unchanged("invalid_response");
      mapping.set(item.id, item.reference);
    }
    const evidence: { id: string; reference: EvidenceReference }[] = [];
    for (const id of draft.evidenceIds) {
      const reference = mapping.get(id);
      if (!reference) return unchanged("invalid_response");
      evidence.push({ id, reference });
    }
    const record: TaskSummaryRecord = {
      contractVersion: 1,
      id: options.previous?.id ?? `task-summary:${options.coverage.conversationId}`,
      revision: (options.previous?.revision ?? 0) + 1,
      policyId: config.policy.id,
      policyVersion: config.policy.version,
      recordedAt: Date.now(),
      trust: "source",
      draft,
      evidence,
      coverage,
      ...(options.previous ? { previousRevision: options.previous.revision } : {}),
      sourceViewRevision: cycle.viewRevision,
      scope: structuredClone(options.scope),
    };
    const valid = validateTaskSummaryRecord(record, {
      scope: options.scope,
      policy: config.policy,
      archives: options.archives,
      config,
      viewRevision: cycle.viewRevision,
      estimateTokens: options.estimateTokens,
    });
    return valid ? { record: valid, diagnostics: [], updated: true } : unchanged("invalid_response");
  } catch {
    ctx.signal?.throwIfAborted();
    return unchanged("backend_failure");
  }
}
