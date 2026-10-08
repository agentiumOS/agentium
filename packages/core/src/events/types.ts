import type { RunOutput } from "../agent/types.js";
import type { TokenUsage } from "../models/types.js";

/**
 * Canonical lifecycle events — every one of these is really emitted by a run.
 * Prefer them for product code, tracers, and webhooks. The rest of
 * `AgentEventMap` covers voice, vision, browser, compaction, and reflection.
 */
export const LIFECYCLE_EVENTS = [
  "run.start",
  "run.complete",
  "run.error",
  "run.cancelled",
  "run.stream.chunk",
  "model.start",
  "model.result",
  "model.error",
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
  "controller.start": { runId: string; controllerCallId: string; operation: string };
  "controller.result": {
    runId: string;
    controllerCallId: string;
    operation: string;
    decision?: string;
    modelRole?: string;
    activeToolCount?: number;
  };
  "controller.error": { runId: string; controllerCallId: string; operation: string; status: "error" | "cancelled" };
  "run.start": {
    runId: string;
    agentName: string;
    input: string;
    sessionId?: string;
    userId?: string;
    tenantId?: string;
    parentRunId?: string;
    rootRunId?: string;
    attemptId?: string;
  };
  "model.start": { runId: string; modelCallId: string; modelId: string; providerId: string };
  "model.result": {
    runId: string;
    modelCallId: string;
    modelId: string;
    providerId: string;
    usage?: TokenUsage;
    status?: "success" | "cancelled";
  };
  "model.error": {
    runId: string;
    modelCallId: string;
    modelId: string;
    providerId: string;
    status?: "error" | "cancelled";
    /** Known usage can still be billed when a call is cancelled after provider completion. */
    usage?: TokenUsage;
  };
  "run.complete": { runId: string; output: RunOutput };
  "run.error": {
    runId: string;
    error: Error;
    status?: "failed" | "cancelled";
    costs?: import("../cost/accounting-types.js").RunCostSnapshot;
  };
  "run.stream.chunk": { runId: string; chunk: string };
  "tool.call": { runId: string; toolCallId?: string; toolName: string; args: unknown };
  "tool.result": {
    runId: string;
    toolCallId?: string;
    toolName: string;
    result: unknown;
    status?: "success" | "error" | "denied" | "cancelled";
    cached?: boolean;
  };
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
    sessionId?: string;
    userId?: string;
    tenantId?: string;
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

  "usage.recorded": {
    runId?: string;
    attemptId: string;
    operationId: string;
    usageRevision: number;
    usageStatus: import("../cost/accounting-types.js").UsageStatus;
  };
  "cost.assessed": { runId?: string; assessment: import("../cost/accounting-types.js").CostAssessment };
  "budget.checked": {
    runId?: string;
    attemptId: string;
    decision: import("../cost/accounting-types.js").BudgetDecision;
  };
  "accounting.error": { runId?: string; attemptId: string; error: unknown };
  "cost.tracked": { runId: string; agentName: string; modelId: string; usage: TokenUsage; cost?: number };
  "cache.hit": { agentName: string; input: string; cachedId: string };
  "cache.miss": { agentName: string; input: string };
  "run.cancelled": { runId: string; agentName: string; costs?: import("../cost/accounting-types.js").RunCostSnapshot };

  "subagent.start": { runId: string; parentRunId: string; agentName: string; task: string };
  "subagent.complete": { runId: string; parentRunId: string; agentName: string; text: string };
  "subagent.error": { runId: string; parentRunId: string; agentName: string; error: Error };

  "context.compacted": { runId: string; beforeTokens: number; afterTokens: number; strategy: string };
  "reflection.critique": { runId: string; pass: boolean; score: number; feedback: string };
};
