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

  "context.compacted": { runId: string; beforeTokens: number; afterTokens: number; strategy: string };
  "reflection.critique": { runId: string; pass: boolean; score: number; feedback: string };
};
