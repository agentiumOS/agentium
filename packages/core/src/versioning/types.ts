import type { RunOutput } from "../agent/types.js";

export interface AgentVersion {
  versionId: string;
  agentName: string;
  instructions?: string;
  modelId: string;
  providerId: string;
  toolNames: string[];
  temperature?: number;
  maxTokens?: number;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

export interface ABTestConfig {
  name: string;
  control: { agentName: string; versionId?: string };
  variant: { agentName: string; versionId?: string };
  trafficSplit: number;
  routing: "random" | "user" | "session";
  metrics?: string[];
  autoRollback?: { errorRateThreshold: number; windowMs: number };
}

export interface ShadowConfig {
  compareOutputs?: (primary: RunOutput, shadow: RunOutput) => ComparisonResult;
}

export interface ComparisonResult {
  match: boolean;
  similarity: number;
  differences: string[];
}

export interface ABMetrics {
  variant: "control" | "variant";
  totalRuns: number;
  successCount: number;
  errorCount: number;
  avgLatencyMs: number;
  avgTokens: number;
  totalCost: number;
}

export interface VersionDiff {
  field: string;
  before: unknown;
  after: unknown;
}
