import type { TokenUsage } from "../models/types.js";

export interface ModelPricing {
  promptPer1k: number;
  completionPer1k: number;
  reasoningPer1k?: number;
  cachedPromptPer1k?: number;
  audioInputPer1k?: number;
  audioOutputPer1k?: number;
}

export interface CostBreakdown {
  input: number;
  output: number;
  reasoning: number;
  cached: number;
  audioInput: number;
  audioOutput: number;
  total: number;
}

export interface CostEntry {
  runId: string;
  agentName: string;
  modelId: string;
  usage: TokenUsage;
  cost: number;
  breakdown: CostBreakdown;
  timestamp: Date;
  sessionId?: string;
  userId?: string;
}

export interface CostBudget {
  maxCostPerRun?: number;
  maxCostPerSession?: number;
  maxCostPerUser?: number;
  maxTokensPerRun?: number;
  onBudgetExceeded?: "throw" | "warn";
}

export interface CostSummary {
  totalCost: number;
  totalTokens: TokenUsage;
  totalBreakdown: CostBreakdown;
  entries: number;
  byAgent: Record<string, { cost: number; breakdown: CostBreakdown; tokens: TokenUsage; runs: number }>;
  byModel: Record<string, { cost: number; breakdown: CostBreakdown; tokens: TokenUsage }>;
  byUser: Record<string, { cost: number; breakdown: CostBreakdown; tokens: TokenUsage }>;
}

export interface CostTrackerConfig {
  pricing?: Record<string, ModelPricing>;
  budget?: CostBudget;
}
