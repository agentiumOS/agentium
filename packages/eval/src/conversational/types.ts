import type { ModelProvider } from "@agentium/core";
import type { EvalResult, Scorer } from "../types.js";

export interface UserPersona {
  name: string;
  description: string;
  goal: string;
  maxTurns?: number;
  model?: ModelProvider;
}

export interface ExpectedTrajectory {
  requiredTools?: string[];
  orderedTools?: string[];
  forbiddenTools?: string[];
  maxToolCalls?: number;
}

export interface ConversationScenario {
  name: string;
  persona: UserPersona;
  initialMessage: string;
  expectedTrajectory?: ExpectedTrajectory;
  successCriteria: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  toolCalls?: string[];
}

export interface TrajectoryMatchResult {
  pass: boolean;
  details: string;
  requiredToolsPresent?: boolean;
  orderedToolsMatch?: boolean;
  forbiddenToolsAbsent?: boolean;
  withinToolCallLimit?: boolean;
}

export interface ConversationEvalResult extends EvalResult {
  turns: ConversationTurn[];
  trajectoryMatch?: TrajectoryMatchResult;
  turnCount: number;
}

export interface ComparisonResult {
  scenarioName: string;
  agentA: { name: string; result: ConversationEvalResult };
  agentB: { name: string; result: ConversationEvalResult };
  winner: "A" | "B" | "tie";
  reasoning: string;
}

export interface ConversationSuiteConfig {
  name: string;
  scenarios: ConversationScenario[];
  scorers?: Scorer[];
  concurrency?: number;
  timeoutMs?: number;
  judgeModel?: ModelProvider;
}

export interface ConversationSuiteResult {
  name: string;
  results: ConversationEvalResult[];
  passed: number;
  failed: number;
  total: number;
  averageTurns: number;
  averageScore: number;
  durationMs: number;
}
