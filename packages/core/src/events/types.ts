import type { RunOutput } from "../agent/types.js";
import type { TokenUsage } from "../models/types.js";

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

  // Voice / Realtime events
  "voice.connected": { agentName: string };
  "voice.audio": { agentName: string; data: Buffer };
  "voice.transcript": { agentName: string; text: string; role: "user" | "assistant" };
  "voice.tool.call": { agentName: string; toolName: string; args: unknown };
  "voice.tool.result": { agentName: string; toolName: string; result: string };
  "voice.error": { agentName: string; error: Error };
  "voice.disconnected": { agentName: string };

  // Browser events
  "browser.screenshot": { data: Buffer };
  "browser.action": { action: unknown };
  "browser.step": { index: number; action: unknown; pageUrl: string; screenshot: Buffer };
  "browser.done": { result: string; success: boolean; steps: unknown[] };
  "browser.error": { error: Error };

  // Tool approval (HITL) events
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

  // Memory events
  "memory.extract": { sessionId: string; userId?: string; agentName: string };
  "memory.stored": { store: string; key: string; agentName: string };
  "memory.error": { store: string; error: Error; agentName: string };

  // Memory — granular events
  "memory.fact.added": { userId: string; fact: string; source: "auto" | "manual"; importance?: number };
  "memory.fact.invalidated": { userId: string; factId: string; reason: string };
  "memory.fact.consolidated": { userId: string; mergedCount: number; resultFact: string };
  "memory.graph.node.added": { nodeId: string; type: string; name: string };
  "memory.graph.edge.added": { edgeId: string; sourceId: string; targetId: string; type: string };
  "memory.procedure.recorded": { trigger: string; stepCount: number };
  "memory.context.built": { sessionId: string; totalTokens: number; sections: Record<string, number> };
  "memory.recall": { query: string; resultCount: number; topScore: number };
  "memory.correction.recorded": {
    correctionId: string;
    agentName: string;
    field?: string;
    entityKey?: string;
    runId?: string;
  };

  // Skill events
  "skill.loaded": { skillName: string; source: string };
  "skill.learned": { skillName: string; agentName: string };

  // Handoff events
  "handoff.transfer": { runId: string; fromAgent: string; toAgent: string; reason: string };
  "handoff.complete": { runId: string; chain: string[]; finalAgent: string };

  // Cost tracking events
  "cost.tracked": { runId: string; agentName: string; modelId: string; usage: TokenUsage };
  "cost.budget.exceeded": { runId: string; agentName: string; budget: string; current: number; limit: number };

  // Semantic cache events
  "cache.hit": { agentName: string; input: string; cachedId: string };
  "cache.miss": { agentName: string; input: string };

  // Trace events
  "trace.complete": { traceId: string };

  // Loop hooks events
  "loop.roundtrip.complete": { runId: string; roundtrip: number; tokensSoFar: TokenUsage };
  "loop.budget.exceeded": { runId: string; agentName: string; roundtrip: number };

  // Checkpoint events
  "checkpoint.saved": { runId: string; checkpointId: string; roundtrip: number };
  "checkpoint.rollback": { checkpointId: string; runId: string };

  // PII events
  "pii.scrubbed": { runId: string; fieldsCount: number };

  // Run cancellation
  "run.cancelled": { runId: string; agentName: string };

  // Context compression events
  "context.compressed": { runId: string; beforeTokens: number; afterTokens: number };

  // Context compaction events
  "context.compacted": { runId: string; beforeTokens: number; afterTokens: number; strategy: string };

  // Capacity planning events
  "capacity.session.classified": {
    sessionId: string;
    category: "light" | "medium" | "heavy" | "extreme";
    totalTokens: number;
    previousCategory?: "light" | "medium" | "heavy" | "extreme";
  };
  "capacity.warning": {
    type: "kv_pressure" | "session_limit";
    message: string;
    estimatedKvGb: number;
    sessionCount: number;
  };

  // Metrics events
  "metrics.snapshot": { timestamp: number };

  // Model resilience events
  "model.fallback": { from: string; to: string; error: string };
  "model.circuit.open": { provider: string; modelId: string; failureCount: number };
  "model.circuit.close": { provider: string; modelId: string };
  "model.routed": { tier: number; complexity: number; modelId: string };

  // Reflection events
  "reflection.critique": { runId: string; pass: boolean; score: number; feedback: string };
  "reflection.loop.escaped": { runId: string; tool: string; repeatCount: number };
  "reflection.postmortem": { runId: string; lesson: string; category: string };

  // Versioning / A/B testing events
  "version.created": { agentName: string; versionId: string };
  "ab.routed": { testName: string; variant: "control" | "variant"; userId?: string };
  "ab.metrics": { testName: string; control: Record<string, number>; variant: Record<string, number> };
  "shadow.compared": { agentName: string; match: boolean; similarity: number };

  // Compliance events
  "compliance.audit.logged": { entryId: string; action: string; agentName: string };
  "compliance.erasure": { userId: string; storesErased: number; entriesAnonymized: number };
  "compliance.retention.purged": { purgedCount: number };

  // Tenant events
  "tenant.scoped": { tenantId: string; agentName: string };

  // Rate limiting events
  "rateLimit.throttled": { scope: string; limitType: string; resetMs: number };
  "rateLimit.degraded": { scope: string; originalModel: string; degradedModel: string };
  "rateLimit.rejected": { scope: string; reason: string };

  // Scheduling events
  "schedule.fired": { scheduleId: string; agentName: string };
  "schedule.completed": { scheduleId: string; agentName: string; runCount: number };
  "schedule.error": { scheduleId: string; agentName: string; error: Error };
  "trigger.fired": { triggerId: string; agentName: string; event: string };

  // Context curation events
  "context.curated": { runId: string; originalCount: number; curatedCount: number; failedRemoved: number };
};
