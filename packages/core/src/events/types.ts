import type { RunOutput } from "../agent/types.js";
import type { TokenUsage } from "../models/types.js";

/**
 * Canonical lifecycle events. Prefer these for product code, tracers, and webhooks.
 * Everything else in `AgentEventMap` is kept for backward compatibility.
 */
export const LIFECYCLE_EVENTS = [
  "run.start",
  "run.complete",
  "run.error",
  "run.cancelled",
  "run.stream.chunk",
  "tool.call",
  "tool.result",
  "tool.approval.request",
  "tool.approval.response",
  "team.delegate",
  "handoff.transfer",
  "handoff.complete",
  "workflow.step",
  "memory.extract",
  "memory.error",
  "memory.correction.recorded",
  "memory.learning.invalidated",
  "cost.tracked",
  "cache.hit",
  "cache.miss",
  "subagent.start",
  "subagent.complete",
  "subagent.error",
] as const;

export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

export type AgentEventMap = {
  "run.start": { runId: string; agentName: string; input: string };
  "run.complete": { runId: string; output: RunOutput };
  "run.error": { runId: string; error: Error };
  "run.stream.chunk": { runId: string; chunk: string };
  "tool.call": { runId: string; toolName: string; args: unknown };
  "tool.result": { runId: string; toolName: string; result: unknown };
  "team.delegate": { runId: string; memberId: string; task: string };
  "workflow.step": {
    runId: string;
    stepName: string;
    status: "start" | "done" | "error";
  };

  "voice.connected": { agentName: string };
  "voice.audio": { agentName: string; data: Buffer };
  "voice.transcript": { agentName: string; text: string; role: "user" | "assistant" };
  "voice.tool.call": { agentName: string; toolName: string; args: unknown };
  "voice.tool.result": { agentName: string; toolName: string; result: string };
  "voice.error": { agentName: string; error: Error };
  "voice.disconnected": { agentName: string };

  "browser.screenshot": { data: Buffer };
  "browser.action": { action: unknown };
  "browser.step": { index: number; action: unknown; pageUrl: string; screenshot: Buffer };
  "browser.done": { result: string; success: boolean; steps: unknown[] };
  "browser.error": { error: Error };

  "tool.approval.request": {
    requestId: string;
    toolName: string;
    args: unknown;
    agentName: string;
    runId: string;
  };
  "tool.approval.response": {
    requestId: string;
    approved: boolean;
    reason?: string;
  };

  "memory.extract": { sessionId: string; userId?: string; agentName: string };
  "memory.error": { store: string; error: Error; agentName: string };
  "memory.correction.recorded": {
    correctionId: string;
    agentName: string;
    field?: string;
    entityKey?: string;
    runId?: string;
  };
  "memory.learning.invalidated": {
    learningIds: string[];
    supersededBy: string;
    agentName: string;
  };

  "handoff.transfer": { runId: string; fromAgent: string; toAgent: string; reason: string };
  "handoff.complete": { runId: string; chain: string[]; finalAgent: string };

  "cost.tracked": { runId: string; agentName: string; modelId: string; usage: TokenUsage };
  "cache.hit": { agentName: string; input: string; cachedId: string };
  "cache.miss": { agentName: string; input: string };
  "run.cancelled": { runId: string; agentName: string };

  "subagent.start": { runId: string; parentRunId: string; agentName: string; task: string };
  "subagent.complete": { runId: string; parentRunId: string; agentName: string; text: string };
  "subagent.error": { runId: string; parentRunId: string; agentName: string; error: Error };

  /** @deprecated Never emitted. Use `memory.extract` / `memory.error`. */
  "memory.stored": { store: string; key: string; agentName: string };
  /** @deprecated Never emitted. */
  "memory.fact.added": { userId: string; fact: string; source: "auto" | "manual"; importance?: number };
  /** @deprecated Never emitted. */
  "memory.fact.invalidated": { userId: string; factId: string; reason: string };
  /** @deprecated Never emitted. */
  "memory.fact.consolidated": { userId: string; mergedCount: number; resultFact: string };
  /** @deprecated Never emitted. */
  "memory.graph.node.added": { nodeId: string; type: string; name: string };
  /** @deprecated Never emitted. */
  "memory.graph.edge.added": { edgeId: string; sourceId: string; targetId: string; type: string };
  /** @deprecated Never emitted. */
  "memory.procedure.recorded": { trigger: string; stepCount: number };
  /** @deprecated Never emitted. */
  "memory.context.built": { sessionId: string; totalTokens: number; sections: Record<string, number> };
  /** @deprecated Never emitted. */
  "memory.recall": { query: string; resultCount: number; topScore: number };
  /** @deprecated Never emitted. Subscribe via SkillMdManager instead. */
  "skill.loaded": { skillName: string; source: string };
  /** @deprecated Never emitted. */
  "skill.learned": { skillName: string; agentName: string };
  /** @deprecated Never emitted. Use `cost.tracked` plus CostTracker.checkBudget. */
  "cost.budget.exceeded": { runId: string; agentName: string; budget: string; current: number; limit: number };
  /** @deprecated Never emitted. */
  "trace.complete": { traceId: string };
  /** @deprecated Never emitted. Use loopHooks.onRoundtripComplete. */
  "loop.roundtrip.complete": { runId: string; roundtrip: number; tokensSoFar: TokenUsage };
  /** @deprecated Never emitted. */
  "loop.budget.exceeded": { runId: string; agentName: string; roundtrip: number };
  /** @deprecated Never emitted. */
  "checkpoint.saved": { runId: string; checkpointId: string; roundtrip: number };
  /** @deprecated Never emitted. */
  "checkpoint.rollback": { checkpointId: string; runId: string };
  /** @deprecated Never emitted. */
  "pii.scrubbed": { runId: string; fieldsCount: number };
  /** @deprecated Prefer logger for compaction internals. */
  "context.compressed": { runId: string; beforeTokens: number; afterTokens: number };
  "context.compacted": { runId: string; beforeTokens: number; afterTokens: number; strategy: string };
  /** @deprecated Never emitted. */
  "capacity.session.classified": {
    sessionId: string;
    category: "light" | "medium" | "heavy" | "extreme";
    totalTokens: number;
    previousCategory?: "light" | "medium" | "heavy" | "extreme";
  };
  /** @deprecated Never emitted. */
  "capacity.warning": {
    type: "kv_pressure" | "session_limit";
    message: string;
    estimatedKvGb: number;
    sessionCount: number;
  };
  /** @deprecated Never emitted. */
  "metrics.snapshot": { timestamp: number };
  /** @deprecated Never emitted. */
  "model.fallback": { from: string; to: string; error: string };
  /** @deprecated Never emitted. */
  "model.circuit.open": { provider: string; modelId: string; failureCount: number };
  /** @deprecated Never emitted. */
  "model.circuit.close": { provider: string; modelId: string };
  /** @deprecated Never emitted. */
  "model.routed": { tier: number; complexity: number; modelId: string };
  "reflection.critique": { runId: string; pass: boolean; score: number; feedback: string };
  /** @deprecated Never emitted. */
  "reflection.loop.escaped": { runId: string; tool: string; repeatCount: number };
  /** @deprecated Never emitted. */
  "reflection.postmortem": { runId: string; lesson: string; category: string };
  /** @deprecated Never emitted. */
  "version.created": { agentName: string; versionId: string };
  /** @deprecated Never emitted. */
  "ab.routed": { testName: string; variant: "control" | "variant"; userId?: string };
  /** @deprecated Never emitted. */
  "ab.metrics": { testName: string; control: Record<string, number>; variant: Record<string, number> };
  /** @deprecated Never emitted. */
  "shadow.compared": { agentName: string; match: boolean; similarity: number };
  /** @deprecated Never emitted. */
  "compliance.audit.logged": { entryId: string; action: string; agentName: string };
  /** @deprecated Never emitted. */
  "compliance.erasure": { userId: string; storesErased: number; entriesAnonymized: number };
  /** @deprecated Never emitted. */
  "compliance.retention.purged": { purgedCount: number };
  /** @deprecated Never emitted. */
  "tenant.scoped": { tenantId: string; agentName: string };
  /** @deprecated Never emitted. */
  "rateLimit.throttled": { scope: string; limitType: string; resetMs: number };
  /** @deprecated Never emitted. */
  "rateLimit.degraded": { scope: string; originalModel: string; degradedModel: string };
  /** @deprecated Never emitted. */
  "rateLimit.rejected": { scope: string; reason: string };
  "schedule.fired": { scheduleId: string; agentName: string };
  "schedule.completed": { scheduleId: string; agentName: string; runCount: number };
  "schedule.error": { scheduleId: string; agentName: string; error: Error };
  "trigger.fired": { triggerId: string; agentName: string; event: string };
  /** @deprecated Never emitted. */
  "context.curated": { runId: string; originalCount: number; curatedCount: number; failedRemoved: number };
};
