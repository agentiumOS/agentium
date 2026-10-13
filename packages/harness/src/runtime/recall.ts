import type { ChatMessage, RunContext } from "@agentium/core";
import { z } from "zod/v3";
import type { HistoryArchiveReference } from "./history.js";
import type { HarnessIdentity } from "./session-bindings.js";

export type RecallScope = { identity: HarnessIdentity; sessionId: string; projectId?: string; repositoryId?: string };
export type EvidenceReference = {
  sourceId: string;
  sourceRevision: string;
  locator: string;
  archive?: HistoryArchiveReference;
  messageRange?: { start: number; end: number };
};
export type RecallBudget = {
  maxQueryBytes: number;
  maxQueries: number;
  maxCandidates: number;
  maxDiscoveryBytes: number;
  maxExcerpts: number;
  maxExcerptBytes: number;
  maxSourceBytes: number;
  maxEvidenceTokens: number;
  deadlineMs: number;
  validationDeadlineMs: number;
  maxValidationBytes: number;
};
export type RecallOperationLimits = {
  signal: AbortSignal;
  deadline: number;
  remainingBytes: number;
  remainingTokens: number;
};
export type RecallCandidate = { id: string; reference: EvidenceReference; rank: number };
export type EvidenceExcerpt = {
  id: string;
  reference: EvidenceReference;
  text: string;
  completeness: "complete" | "partial";
  omissions: readonly ("source_range" | "correction_context" | "negation_context")[];
  completeGroup: boolean;
};
export type RecallReadResult =
  | { status: "found"; excerpt: EvidenceExcerpt; viewRevision: string }
  | { status: "unavailable" | "revision_changed"; viewRevision: string };
export interface RecallSession {
  readonly scope: RecallScope;
  readonly viewRevision: string;
  discover(
    request: { query: string; maxCandidates: number; maxResponseBytes: number },
    limits: RecallOperationLimits,
  ): Promise<{ candidates: readonly RecallCandidate[]; partial: boolean; viewRevision: string }>;
  read(
    request: { reference: EvidenceReference; maxBytes: number; completeGroup?: boolean },
    limits: RecallOperationLimits,
  ): Promise<RecallReadResult>;
  validate(
    request: { expectedViewRevision: string; references: readonly EvidenceReference[] },
    limits: RecallOperationLimits,
  ): Promise<{ status: "valid" | "changed" | "unavailable"; viewRevision: string }>;
  close(): Promise<void>;
}
export interface RecallStore {
  readonly capabilities: {
    boundedDiscovery: boolean;
    boundedReads: boolean;
    revisionValidation: boolean;
    boundedCurrentValidation: boolean /** Explicit bounded canonical-group seek attestation; required for archival summaries. */;
    canonicalArchiveReads?: boolean;
  };
  open(scope: RecallScope, limits: RecallOperationLimits): Promise<RecallSession>;
}
export type RecallDiagnostic = {
  code:
    | "query_limit"
    | "candidate_limit"
    | "byte_limit"
    | "token_limit"
    | "deadline"
    | "backend_failure"
    | "revision_changed"
    | "partial_evidence"
    | "invalid_response"
    | "pending_summary"
    | "unavailable_coverage"
    | "clarification_limit";
  phase: "open" | "discovery" | "read" | "assembly" | "summary" | "validation";
  message: string;
};
export type RecallResult = {
  status: "complete" | "no_accessible_evidence" | "partial" | "failed";
  excerpts: readonly EvidenceExcerpt[];
  diagnostics: readonly RecallDiagnostic[];
  viewRevision: string | null;
  usage: { queries: number; candidates: number; bytes: number; estimatedTokens: number; elapsedMs: number };
};
export type RecallDecision =
  | { action: "continue" }
  | { action: "stop"; reason: string }
  | { action: "await_input"; question: string };
export interface RecallPolicy {
  id: string;
  query(input: { history: readonly ChatMessage[] }, ctx: RunContext): string | undefined;
  decide(result: RecallResult, ctx: RunContext): Promise<RecallDecision>;
}

const nonempty = z
  .string()
  .min(1)
  .refine((value) => Boolean(value.trim()));
const natural = z.number().int().nonnegative().safe();
export const recallScopeSchema = z
  .object({
    identity: z.object({ userId: nonempty, tenantId: nonempty }).strict(),
    sessionId: nonempty,
    projectId: nonempty.optional(),
    repositoryId: nonempty.optional(),
  })
  .strict();
export const archiveReferenceSchema = z
  .object({
    id: nonempty,
    conversationId: nonempty,
    messageCount: z.number().int().positive().safe(),
    digest: nonempty,
  })
  .strict();
export const evidenceReferenceSchema = z
  .object({
    sourceId: nonempty,
    sourceRevision: nonempty,
    locator: nonempty,
    archive: archiveReferenceSchema.optional(),
    messageRange: z.object({ start: natural, end: natural }).strict().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.archive || value.messageRange) {
      if (
        !value.archive ||
        !value.messageRange ||
        value.sourceId !== value.archive.id ||
        value.sourceRevision !== value.archive.digest ||
        value.messageRange.end <= value.messageRange.start ||
        value.messageRange.end > value.archive.messageCount
      )
        ctx.addIssue({ code: "custom", message: "Invalid canonical archive range" });
    }
  });
const excerptSchema = z
  .object({
    id: nonempty,
    reference: evidenceReferenceSchema,
    text: nonempty,
    completeness: z.enum(["complete", "partial"]),
    omissions: z.array(z.enum(["source_range", "correction_context", "negation_context"])),
    completeGroup: z.boolean(),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (
      (item.completeness === "complete" && item.omissions.length) ||
      (item.completeness === "partial" && !item.omissions.length) ||
      (item.completeGroup && (item.completeness !== "complete" || !item.reference.archive))
    )
      ctx.addIssue({ code: "custom", message: "Inconsistent evidence completeness" });
  });
const discoverySchema = z
  .object({
    candidates: z.array(
      z.object({ id: nonempty, reference: evidenceReferenceSchema, rank: z.number().finite() }).strict(),
    ),
    partial: z.boolean(),
    viewRevision: nonempty,
  })
  .strict();
const readSchema = z.union([
  z.object({ status: z.literal("found"), excerpt: excerptSchema, viewRevision: nonempty }).strict(),
  z.object({ status: z.enum(["unavailable", "revision_changed"]), viewRevision: nonempty }).strict(),
]);
const validationSchema = z
  .object({ status: z.enum(["valid", "changed", "unavailable"]), viewRevision: nonempty })
  .strict();

export function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
export function scopesEqual(a: RecallScope, b: RecallScope): boolean {
  return (
    a.identity.tenantId === b.identity.tenantId &&
    a.identity.userId === b.identity.userId &&
    a.sessionId === b.sessionId &&
    a.projectId === b.projectId &&
    a.repositoryId === b.repositoryId
  );
}
export function referencesEqual(a: EvidenceReference, b: EvidenceReference): boolean {
  return (
    a.sourceId === b.sourceId &&
    a.sourceRevision === b.sourceRevision &&
    a.locator === b.locator &&
    ((!a.messageRange && !b.messageRange) ||
      Boolean(
        a.messageRange &&
          b.messageRange &&
          a.messageRange.start === b.messageRange.start &&
          a.messageRange.end === b.messageRange.end,
      )) &&
    ((!a.archive && !b.archive) ||
      Boolean(
        a.archive &&
          b.archive &&
          a.archive.id === b.archive.id &&
          a.archive.digest === b.archive.digest &&
          a.archive.conversationId === b.archive.conversationId &&
          a.archive.messageCount === b.archive.messageCount,
      ))
  );
}
export function evidenceKey(reference: EvidenceReference): string {
  return JSON.stringify([reference.sourceId, reference.sourceRevision, reference.locator]);
}
export function recallDiagnostic(code: RecallDiagnostic["code"], phase: RecallDiagnostic["phase"]): RecallDiagnostic {
  return { code, phase, message: `Continuity ${phase}: ${code}` };
}
export function validateRecallConfiguration(config: {
  store: RecallStore;
  budget: RecallBudget;
  policy?: RecallPolicy;
  maxClarifications?: number;
}): void {
  const bounds = [
    "maxQueryBytes",
    "maxQueries",
    "maxCandidates",
    "maxDiscoveryBytes",
    "maxExcerpts",
    "maxExcerptBytes",
    "maxSourceBytes",
    "maxEvidenceTokens",
    "deadlineMs",
    "validationDeadlineMs",
    "maxValidationBytes",
  ] as const;
  for (const key of bounds)
    if (!Number.isSafeInteger(config.budget?.[key]) || config.budget[key] <= 0)
      throw new TypeError(`Recall ${key} must be a positive safe integer`);
  if (
    !config.store ||
    typeof config.store.open !== "function" ||
    ["boundedDiscovery", "boundedReads", "revisionValidation", "boundedCurrentValidation"].some(
      (key) => Reflect.get(config.store.capabilities ?? {}, key) !== true,
    )
  )
    throw new TypeError("Recall requires bounded discovery, reads and current revision validation");
  if (
    config.policy &&
    (!config.policy.id?.trim() ||
      typeof config.policy.query !== "function" ||
      typeof config.policy.decide !== "function")
  )
    throw new TypeError("Recall policy is invalid");
  if (
    config.maxClarifications !== undefined &&
    (!Number.isSafeInteger(config.maxClarifications) || config.maxClarifications < 0)
  )
    throw new TypeError("maxClarifications must be a nonnegative safe integer");
}

/** Clip query bytes at code point boundaries; source excerpts are never clipped. */
export function boundRecallQuery(query: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const point of query) {
    const next = Buffer.byteLength(point);
    if (bytes + next > maxBytes) break;
    result += point;
    bytes += next;
  }
  return result;
}

class RecallWindowError extends Error {}
/** Race for responsiveness. A conforming adapter must itself stop backend I/O on abort. */
async function withinWindow<T>(
  signal: AbortSignal,
  deadline: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  if (deadline <= Date.now()) throw new RecallWindowError("Continuity deadline");
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) controller.abort(new RecallWindowError("Continuity deadline"));
    else timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
  };
  schedule();
  try {
    const value = await Promise.race([operation(controller.signal), aborted]);
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw new RecallWindowError("Continuity deadline");
    return value;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
  }
}
export type RecallValidationOptions = {
  signal: AbortSignal;
  runDeadline?: number;
  validationDeadlineMs: number;
  maxValidationBytes: number;
};
export async function validateRecallView(
  session: RecallSession,
  expectedViewRevision: string,
  references: readonly EvidenceReference[],
  options: RecallValidationOptions,
): Promise<{ valid: boolean; code?: "deadline" | "backend_failure" | "invalid_response" | "revision_changed" }> {
  options.signal.throwIfAborted();
  if (
    !expectedViewRevision.trim() ||
    references.some((reference) => !evidenceReferenceSchema.safeParse(reference).success)
  )
    return { valid: false, code: "invalid_response" };
  const deadline = Math.min(Date.now() + options.validationDeadlineMs, options.runDeadline ?? Infinity);
  try {
    const raw = await withinWindow(options.signal, deadline, (signal) =>
      session.validate(
        { expectedViewRevision, references: structuredClone(references) },
        { signal, deadline, remainingBytes: options.maxValidationBytes, remainingTokens: 0 },
      ),
    );
    if (serializedBytes(raw) > options.maxValidationBytes) return { valid: false, code: "invalid_response" };
    const parsed = validationSchema.safeParse(raw);
    if (!parsed.success) return { valid: false, code: "invalid_response" };
    if (parsed.data.status === "unavailable") return { valid: false, code: "backend_failure" };
    return parsed.data.status === "valid" && parsed.data.viewRevision === expectedViewRevision
      ? { valid: true }
      : { valid: false, code: "revision_changed" };
  } catch (error) {
    options.signal.throwIfAborted();
    return { valid: false, code: error instanceof RecallWindowError ? "deadline" : "backend_failure" };
  }
}
export type RecallUsageState = {
  queries: number;
  candidates: number;
  bytes: number;
  estimatedTokens: number;
  discoveryBytes: number;
  sourceBytes: number;
  excerpts: number;
  elapsedMs: number;
};
export function createRecallUsage(): RecallUsageState {
  return {
    queries: 0,
    candidates: 0,
    bytes: 0,
    estimatedTokens: 0,
    discoveryBytes: 0,
    sourceBytes: 0,
    excerpts: 0,
    elapsedMs: 0,
  };
}
export type RecallCycleOptions = {
  store: RecallStore;
  scope: RecallScope;
  budget: RecallBudget;
  signal: AbortSignal;
  runDeadline?: number;
  estimateTokens?: (text: string) => number;
  usage?: RecallUsageState;
};
export interface RecallCycle {
  readonly cleanupFailed: boolean;
  readonly session: RecallSession | undefined;
  readonly viewRevision: string | null;
  readonly diagnostics: RecallDiagnostic[];
  readonly usage: RecallUsageState;
  read(
    reference: EvidenceReference,
    options?: { completeGroup?: boolean; expectedId?: string },
  ): Promise<EvidenceExcerpt | undefined>;
  query(query?: string): Promise<RecallResult>;
  result(excerpts?: readonly EvidenceExcerpt[]): RecallResult;
  validate(
    references: readonly EvidenceReference[],
    expectedViewRevision?: string,
  ): Promise<{ valid: boolean; code?: "deadline" | "backend_failure" | "invalid_response" | "revision_changed" }>;
  close(): Promise<void>;
}
export async function openRecallCycle(options: RecallCycleOptions): Promise<RecallCycle> {
  validateRecallConfiguration(options);
  const scope = recallScopeSchema.parse(options.scope);
  const { budget, signal } = options;
  signal.throwIfAborted();
  const start = Date.now();
  const deadline = Math.min(start + budget.deadlineMs, options.runDeadline ?? Infinity);
  const diagnostics: RecallDiagnostic[] = [];
  const usage = options.usage ?? createRecallUsage();
  const excerpts: EvidenceExcerpt[] = [];
  const readCache = new Map<string, EvidenceExcerpt>();
  let session: RecallSession | undefined;
  let viewRevision: string | null = null;
  let failed = false;
  let closed = false;
  let openAbandoned = false;
  let cleanupFailed = false;
  const add = (code: RecallDiagnostic["code"], phase: RecallDiagnostic["phase"], fatal = false) => {
    if (diagnostics.length < 32 && !diagnostics.some((item) => item.code === code && item.phase === phase))
      diagnostics.push(recallDiagnostic(code, phase));
    if (fatal) {
      failed = true;
      excerpts.length = 0;
    }
  };
  const limits = (operationSignal: AbortSignal, remainingBytes: number): RecallOperationLimits => ({
    signal: operationSignal,
    deadline,
    remainingBytes,
    remainingTokens: Math.max(0, budget.maxEvidenceTokens - usage.estimatedTokens),
  });
  const errorCode = (error: unknown) => (error instanceof RecallWindowError ? "deadline" : "backend_failure");
  const closeSession = async (value: RecallSession) => {
    try {
      await withinWindow(new AbortController().signal, Date.now() + budget.validationDeadlineMs, () => value.close());
    } catch {
      cleanupFailed = true;
      add("backend_failure", "validation");
    }
  };
  try {
    const opened = await withinWindow(signal, deadline, async (operationSignal) => {
      const value = await options.store.open(
        structuredClone(scope),
        limits(operationSignal, budget.maxValidationBytes),
      );
      if (openAbandoned) {
        await closeSession(value);
        throw new RecallWindowError("Abandoned recall open");
      }
      // Ownership precedes the deadline/cancellation acceptance check in withinWindow.
      session = value;
      return value;
    });
    // Register ownership before checking any untrusted metadata.
    session = opened;
    const metadata = z
      .object({ scope: recallScopeSchema, viewRevision: nonempty })
      .strict()
      .safeParse({ scope: opened?.scope, viewRevision: opened?.viewRevision });
    if (
      serializedBytes({ scope: opened?.scope, viewRevision: opened?.viewRevision }) > budget.maxValidationBytes ||
      !metadata.success ||
      !scopesEqual(metadata.data.scope, scope) ||
      [opened?.discover, opened?.read, opened?.validate, opened?.close].some((method) => typeof method !== "function")
    )
      add("invalid_response", "open", true);
    else viewRevision = metadata.data.viewRevision;
  } catch (error) {
    openAbandoned = true;
    if (session) {
      await closeSession(session);
      session = undefined;
    }
    signal.throwIfAborted();
    add(errorCode(error), "open", true);
  }
  const ensure = () => {
    signal.throwIfAborted();
    if (closed) throw new Error("Recall cycle has closed");
    if (session && !scopesEqual(session.scope, scope)) add("invalid_response", "validation", true);
    return session && !failed ? session : undefined;
  };
  const cycle: RecallCycle = {
    get cleanupFailed() {
      return cleanupFailed;
    },
    get session() {
      return session;
    },
    get viewRevision() {
      return viewRevision;
    },
    diagnostics,
    usage,
    async read(reference, readOptions = {}) {
      const active = ensure();
      if (!active) return undefined;
      if (!evidenceReferenceSchema.safeParse(reference).success) {
        add("invalid_response", "read", true);
        return undefined;
      }
      const cached = readCache.get(evidenceKey(reference));
      if (
        cached &&
        referencesEqual(cached.reference, reference) &&
        (!readOptions.expectedId || cached.id === readOptions.expectedId) &&
        (!readOptions.completeGroup || cached.completeGroup)
      )
        return structuredClone(cached);
      if (usage.excerpts >= budget.maxExcerpts) {
        add("candidate_limit", "read");
        return undefined;
      }
      const maxBytes = Math.min(budget.maxExcerptBytes, budget.maxSourceBytes - usage.sourceBytes);
      if (maxBytes <= 0) {
        add("byte_limit", "read");
        return undefined;
      }
      if (usage.estimatedTokens >= budget.maxEvidenceTokens) {
        add("token_limit", "read");
        return undefined;
      }
      try {
        const raw = await withinWindow(signal, deadline, (operationSignal) =>
          active.read(
            {
              reference: structuredClone(reference),
              maxBytes,
              ...(readOptions.completeGroup ? { completeGroup: true } : {}),
            },
            limits(operationSignal, maxBytes),
          ),
        );
        const bytes = serializedBytes(raw);
        usage.bytes += bytes;
        usage.sourceBytes += bytes;
        if (bytes > maxBytes) {
          add("byte_limit", "read", true);
          return undefined;
        }
        const parsed = readSchema.safeParse(raw);
        if (!parsed.success) {
          add("invalid_response", "read", true);
          return undefined;
        }
        const data = parsed.data;
        if (data.viewRevision !== viewRevision || data.status === "revision_changed") {
          add("revision_changed", "read", true);
          return undefined;
        }
        if (data.status !== "found") {
          add("partial_evidence", "read");
          return undefined;
        }
        const item = data.excerpt;
        const range = item.reference.messageRange;
        const requestedRange = reference.messageRange;
        const groupMatch =
          readOptions.completeGroup &&
          item.completeGroup &&
          item.reference.archive &&
          reference.archive &&
          range &&
          requestedRange &&
          item.reference.sourceId === reference.sourceId &&
          item.reference.sourceRevision === reference.sourceRevision &&
          item.reference.archive.id === reference.archive.id &&
          item.reference.archive.digest === reference.archive.digest &&
          item.reference.archive.conversationId === reference.archive.conversationId &&
          item.reference.archive.messageCount === reference.archive.messageCount &&
          range.start === requestedRange.start &&
          range.end <= requestedRange.end;
        if (
          (!referencesEqual(item.reference, reference) && !groupMatch) ||
          (readOptions.expectedId && item.id !== readOptions.expectedId) ||
          (readOptions.completeGroup && !groupMatch)
        ) {
          add("invalid_response", "read", true);
          return undefined;
        }
        const tokens = (options.estimateTokens ?? ((text) => Math.ceil(Buffer.byteLength(text) / 4)))(
          JSON.stringify(item),
        );
        if (!Number.isSafeInteger(tokens) || tokens < 0) throw new TypeError("Invalid evidence token estimate");
        if (tokens > budget.maxEvidenceTokens - usage.estimatedTokens) {
          add("token_limit", "read");
          return undefined;
        }
        usage.estimatedTokens += tokens;
        usage.excerpts++;
        if (item.completeness === "partial") add("partial_evidence", "read");
        readCache.set(evidenceKey(item.reference), structuredClone(item));
        return structuredClone(item);
      } catch (error) {
        signal.throwIfAborted();
        add(errorCode(error), "read", true);
        return undefined;
      }
    },
    async query(query) {
      const active = ensure();
      if (!active || query === undefined || !query.trim()) return cycle.result();
      if (Buffer.byteLength(query) > budget.maxQueryBytes || usage.queries >= budget.maxQueries) {
        add("query_limit", "discovery");
        return cycle.result();
      }
      const maxCandidates = budget.maxCandidates - usage.candidates;
      const maxResponseBytes = budget.maxDiscoveryBytes - usage.discoveryBytes;
      if (maxCandidates <= 0) {
        add("candidate_limit", "discovery");
        return cycle.result();
      }
      if (maxResponseBytes <= 0) {
        add("byte_limit", "discovery");
        return cycle.result();
      }
      usage.queries++;
      try {
        const raw = await withinWindow(signal, deadline, (operationSignal) =>
          active.discover({ query, maxCandidates, maxResponseBytes }, limits(operationSignal, maxResponseBytes)),
        );
        const bytes = serializedBytes(raw);
        usage.bytes += bytes;
        usage.discoveryBytes += bytes;
        if (bytes > maxResponseBytes) {
          add("byte_limit", "discovery", true);
          return cycle.result();
        }
        const parsed = discoverySchema.safeParse(raw);
        if (!parsed.success) {
          add("invalid_response", "discovery", true);
          return cycle.result();
        }
        if (parsed.data.viewRevision !== viewRevision) {
          add("revision_changed", "discovery", true);
          return cycle.result();
        }
        if (
          parsed.data.candidates.length > maxCandidates ||
          new Set(parsed.data.candidates.map((item) => item.id)).size !== parsed.data.candidates.length
        ) {
          add("invalid_response", "discovery", true);
          return cycle.result();
        }
        usage.candidates += parsed.data.candidates.length;
        if (parsed.data.partial) add("partial_evidence", "discovery");
        const seen = new Set(excerpts.map((item) => evidenceKey(item.reference)));
        for (const candidate of [...parsed.data.candidates].sort((a, b) => b.rank - a.rank)) {
          if (seen.has(evidenceKey(candidate.reference))) continue;
          const excerpt = await cycle.read(candidate.reference, { expectedId: candidate.id });
          if (failed) break;
          if (excerpt) {
            excerpts.push(excerpt);
            seen.add(evidenceKey(excerpt.reference));
          }
        }
      } catch (error) {
        signal.throwIfAborted();
        add(errorCode(error), "discovery", true);
      }
      return cycle.result();
    },
    result(extra = []) {
      const unique = new Map<string, EvidenceExcerpt>();
      if (!failed)
        for (const item of [...extra, ...excerpts])
          if (!unique.has(evidenceKey(item.reference))) unique.set(evidenceKey(item.reference), item);
      return {
        status: failed
          ? "failed"
          : diagnostics.length
            ? "partial"
            : unique.size
              ? "complete"
              : "no_accessible_evidence",
        excerpts: structuredClone([...unique.values()]),
        diagnostics: structuredClone(diagnostics),
        viewRevision,
        usage: {
          queries: usage.queries,
          candidates: usage.candidates,
          bytes: usage.bytes,
          estimatedTokens: usage.estimatedTokens,
          elapsedMs: closed ? usage.elapsedMs : usage.elapsedMs + Date.now() - start,
        },
      };
    },
    async validate(references, expectedViewRevision = viewRevision ?? "") {
      const active = ensure();
      if (!active) return { valid: false, code: "backend_failure" };
      const result = await validateRecallView(active, expectedViewRevision, references, {
        signal,
        runDeadline: options.runDeadline,
        validationDeadlineMs: budget.validationDeadlineMs,
        maxValidationBytes: budget.maxValidationBytes,
      });
      if (!result.valid) add(result.code ?? "backend_failure", "validation", true);
      return result;
    },
    async close() {
      if (closed) return;
      closed = true;
      usage.elapsedMs += Date.now() - start;
      if (session && typeof session.close === "function") await closeSession(session);
    },
  };
  return cycle;
}
