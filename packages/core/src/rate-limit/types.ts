import type { ModelProvider } from "../models/provider.js";

export interface RateLimitConfig {
  maxTokensPerMinute?: number;
  maxTokensPerHour?: number;
  maxRequestsPerMinute?: number;
  maxConcurrent?: number;
  perTenant?: boolean;
  perUser?: boolean;
  onLimitReached?: "queue" | "reject" | "degrade";
  degradeStrategy?: {
    useCheaperModel: ModelProvider;
    reduceMaxTokens: number;
  };
}

export interface QuotaConfig {
  tenantQuotas?: Record<string, { tokensPerDay: number; costPerDay: number }>;
  defaultQuota?: { tokensPerDay: number; costPerDay: number };
  priorityLevels?: Record<string, "p0" | "p1" | "p2">;
}

export interface RateLimitScope {
  tenantId?: string;
  userId?: string;
  agentName?: string;
}

export interface RateLimitStatus {
  allowed: boolean;
  remaining: number;
  resetMs: number;
  degraded?: boolean;
}
