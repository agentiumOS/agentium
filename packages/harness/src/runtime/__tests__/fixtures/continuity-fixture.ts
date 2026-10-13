import { type ChatMessage, groupConversationTurns } from "@agentium/core";
import type { HistoryArchive, HistoryArchiveReference } from "../../history.js";
import type {
  EvidenceExcerpt,
  EvidenceReference,
  RecallBudget,
  RecallOperationLimits,
  RecallScope,
  RecallSession,
  RecallStore,
} from "../../recall.js";
import { scopesEqual } from "../../recall.js";

export const continuityScope: RecallScope = {
  identity: { tenantId: "tenant", userId: "actor" },
  sessionId: "session",
  projectId: "project",
};
export const continuityBudget: RecallBudget = {
  maxQueryBytes: 256,
  maxQueries: 2,
  maxCandidates: 8,
  maxDiscoveryBytes: 4096,
  maxExcerpts: 8,
  maxExcerptBytes: 4096,
  maxSourceBytes: 16384,
  maxEvidenceTokens: 4096,
  deadlineMs: 100,
  validationDeadlineMs: 50,
  maxValidationBytes: 1024,
};

/** Indexed, bounded source fixture: read seeks a stored group; no full archive read path. */
export function createContinuityFixture(options: { conditionalPublication?: boolean } = {}) {
  const groups = new Map<string, EvidenceExcerpt>();
  const archives: HistoryArchiveReference[] = [];
  const sourceReads: { reference: EvidenceReference; limits: RecallOperationLimits; bytes: number }[] = [];
  const discoveries: { query: string; limits: RecallOperationLimits }[] = [];
  const validations: { expectedViewRevision: string; limits: RecallOperationLimits; session: number }[] = [];
  const opens: RecallOperationLimits[] = [];
  const closes: number[] = [];
  let epoch = 1;
  let physicalBytes = 0;
  let legacyArchiveReads = 0;
  const canonical = new Map<string, readonly ChatMessage[]>();
  let fault: "none" | "failure" | "unavailable" | "partial" = "none";
  let onDiscover: (() => void) | undefined;
  let onRead: (() => void) | undefined;
  let onValidate: (() => Promise<void>) | undefined;
  const store: RecallStore = {
    capabilities: {
      boundedDiscovery: true,
      boundedReads: true,
      revisionValidation: true,
      boundedCurrentValidation: true,
      canonicalArchiveReads: true,
    },
    async open(scope, limits) {
      limits.signal.throwIfAborted();
      opens.push(limits);
      if (!scopesEqual(scope, continuityScope)) throw new Error("forbidden-secret-source");
      const sessionId = opens.length;
      let closed = false;
      const check = (limits: RecallOperationLimits) => {
        if (closed) throw new Error("closed");
        limits.signal.throwIfAborted();
        if (Date.now() >= limits.deadline) throw new Error("expired");
      };
      const session: RecallSession = {
        scope: structuredClone(scope),
        viewRevision: String(epoch),
        async discover(request, limits) {
          check(limits);
          onDiscover?.();
          discoveries.push({ query: request.query, limits });
          if (fault === "failure") throw new Error("forbidden-secret-source");
          const candidates = [...groups.values()]
            .filter((item) => item.text.includes(request.query))
            .map((item, i) => ({ id: item.id, reference: item.reference, rank: i }));
          const bounded = [];
          for (const candidate of candidates) {
            const projected = { candidates: [...bounded, candidate], partial: false, viewRevision: String(epoch) };
            if (
              bounded.length >= request.maxCandidates ||
              Buffer.byteLength(JSON.stringify(projected)) > Math.min(request.maxResponseBytes, limits.remainingBytes)
            )
              break;
            bounded.push(candidate);
          }
          return {
            candidates: bounded,
            partial: fault === "partial" || bounded.length < candidates.length,
            viewRevision: String(epoch),
          };
        },
        async read(request, limits) {
          check(limits);
          onRead?.();
          if (fault === "failure") throw new Error("forbidden-secret-source");
          const excerpt = [...groups.values()].find(
            (item) =>
              item.reference.sourceId === request.reference.sourceId &&
              item.reference.sourceRevision === request.reference.sourceRevision &&
              (request.completeGroup
                ? item.reference.messageRange?.start === request.reference.messageRange?.start
                : item.reference.locator === request.reference.locator),
          );
          if (!excerpt || fault === "unavailable") return { status: "unavailable", viewRevision: String(epoch) };
          const result = { status: "found" as const, excerpt: structuredClone(excerpt), viewRevision: String(epoch) };
          const bytes = Buffer.byteLength(JSON.stringify(result));
          if (bytes > Math.min(request.maxBytes, limits.remainingBytes))
            return { status: "unavailable", viewRevision: String(epoch) };
          physicalBytes += bytes;
          sourceReads.push({ reference: request.reference, limits, bytes });
          return result;
        },
        async validate(request, limits) {
          check(limits);
          await onValidate?.();
          validations.push({ expectedViewRevision: request.expectedViewRevision, limits, session: sessionId });
          return {
            status: request.expectedViewRevision === String(epoch) ? "valid" : "changed",
            viewRevision: String(epoch),
          };
        },
        async close() {
          if (!closed) {
            closed = true;
            closes.push(sessionId);
          }
        },
      };
      return session;
    },
  };
  const archive: HistoryArchive = {
    async write(_scope, reference, messages) {
      canonical.set(reference.id, structuredClone(messages));
      archives.push(structuredClone(reference));
      let start = 0;
      for (const turn of groupConversationTurns([...messages])) {
        const end = start + turn.length;
        const evidenceReference = {
          sourceId: reference.id,
          sourceRevision: reference.digest,
          locator: `archive:${reference.id}:messages:${start}-${end}`,
          archive: reference,
          messageRange: { start, end },
        };
        const excerpt: EvidenceExcerpt = {
          id: `${reference.id}:${start}`,
          reference: evidenceReference,
          text: JSON.stringify(
            turn.map((message) => ({
              role: message.role,
              content: message.content,
              ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
              ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
            })),
          ),
          completeness: "complete",
          omissions: [],
          completeGroup: true,
        };
        groups.set(excerpt.id, excerpt);
        start = end;
      }
    },
    async read(_scope, reference) {
      legacyArchiveReads++;
      return structuredClone(canonical.get(reference.id) ?? []);
    },
  };
  return {
    store,
    archive,
    archives,
    sourceReads,
    discoveries,
    validations,
    opens,
    closes,
    get physicalBytes() {
      return physicalBytes;
    },
    get legacyArchiveReads() {
      return legacyArchiveReads;
    },
    get viewRevision() {
      return String(epoch);
    },
    setFault(value: typeof fault) {
      fault = value;
    },
    onDiscover(callback: () => void) {
      onDiscover = callback;
    },
    onRead(callback: () => void) {
      onRead = callback;
    },
    onValidate(callback: () => Promise<void>) {
      onValidate = callback;
    },
    revoke() {
      epoch++;
    },
    deleteSource(id: string) {
      for (const [key, item] of groups) if (item.reference.sourceId === id) groups.delete(key);
      epoch++;
    },
    publishIfCurrent(expected: string, publish: () => void) {
      if (options.conditionalPublication && expected !== String(epoch)) return false;
      publish();
      return true;
    },
    seedArchive(id: string, texts: string | readonly string[], conversationId = "main") {
      const values = typeof texts === "string" ? [texts] : texts;
      const archive = { id, conversationId, messageCount: values.length, digest: `digest-${id}` };
      archives.push(archive);
      values.forEach((text, start) => {
        const reference = {
          sourceId: id,
          sourceRevision: archive.digest,
          locator: `archive:${id}:messages:${start}-${start + 1}`,
          archive,
          messageRange: { start, end: start + 1 },
        };
        const excerpt: EvidenceExcerpt = {
          id: `${id}:${start}`,
          reference,
          text,
          completeness: "complete",
          omissions: [],
          completeGroup: true,
        };
        groups.set(excerpt.id, excerpt);
      });
      return archive;
    },
    mutateExcerpt(id: string, update: Partial<EvidenceExcerpt>) {
      const previous = groups.get(id);
      if (!previous) throw new Error("Unknown fixture excerpt");
      groups.set(id, { ...previous, ...update });
    },
  };
}
