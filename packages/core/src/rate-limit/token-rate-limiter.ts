import type { RateLimitConfig, RateLimitScope, RateLimitStatus } from "./types.js";

interface Bucket {
  tokens: number;
  requests: number;
  windowStart: number;
  hourlyTokens: number;
  hourlyWindowStart: number;
}

export class TokenRateLimiter {
  private config: RateLimitConfig;
  private buckets = new Map<string, Bucket>();

  constructor(config: RateLimitConfig) {
    this.config = config;
  }

  private getScopeKey(scope: RateLimitScope): string {
    const parts: string[] = ["global"];
    if (this.config.perTenant && scope.tenantId) parts.push(`t:${scope.tenantId}`);
    if (this.config.perUser && scope.userId) parts.push(`u:${scope.userId}`);
    return parts.join(":");
  }

  private getBucket(key: string): Bucket {
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { tokens: 0, requests: 0, windowStart: now, hourlyTokens: 0, hourlyWindowStart: now };
      this.buckets.set(key, bucket);
      return bucket;
    }

    if (now - bucket.windowStart >= 60_000) {
      bucket.tokens = 0;
      bucket.requests = 0;
      bucket.windowStart = now;
    }

    if (now - bucket.hourlyWindowStart >= 3_600_000) {
      bucket.hourlyTokens = 0;
      bucket.hourlyWindowStart = now;
    }

    return bucket;
  }

  check(scope: RateLimitScope, tokensToAcquire = 0): RateLimitStatus {
    const key = this.getScopeKey(scope);
    const bucket = this.getBucket(key);

    if (this.config.maxRequestsPerMinute && bucket.requests >= this.config.maxRequestsPerMinute) {
      return {
        allowed: false,
        remaining: 0,
        resetMs: 60_000 - (Date.now() - bucket.windowStart),
      };
    }

    if (this.config.maxTokensPerMinute && bucket.tokens + tokensToAcquire > this.config.maxTokensPerMinute) {
      return {
        allowed: false,
        remaining: Math.max(0, this.config.maxTokensPerMinute - bucket.tokens),
        resetMs: 60_000 - (Date.now() - bucket.windowStart),
      };
    }

    if (this.config.maxTokensPerHour && bucket.hourlyTokens + tokensToAcquire > this.config.maxTokensPerHour) {
      return {
        allowed: false,
        remaining: Math.max(0, this.config.maxTokensPerHour - bucket.hourlyTokens),
        resetMs: 3_600_000 - (Date.now() - bucket.hourlyWindowStart),
      };
    }

    const remaining = Math.min(
      this.config.maxTokensPerMinute ? this.config.maxTokensPerMinute - bucket.tokens : Infinity,
      this.config.maxRequestsPerMinute ? this.config.maxRequestsPerMinute - bucket.requests : Infinity,
    );

    return {
      allowed: true,
      remaining: remaining === Infinity ? -1 : remaining,
      resetMs: 60_000 - (Date.now() - bucket.windowStart),
    };
  }

  acquire(estimatedTokens: number, scope: RateLimitScope): RateLimitStatus {
    const status = this.check(scope, estimatedTokens);

    if (status.allowed) {
      const key = this.getScopeKey(scope);
      const bucket = this.getBucket(key);
      bucket.tokens += estimatedTokens;
      bucket.requests++;
      bucket.hourlyTokens += estimatedTokens;
    }

    return status;
  }

  record(actualTokens: number, estimatedTokens: number, scope: RateLimitScope): void {
    const key = this.getScopeKey(scope);
    const bucket = this.buckets.get(key);
    if (!bucket) return;

    const diff = actualTokens - estimatedTokens;
    bucket.tokens += diff;
    bucket.hourlyTokens += diff;
  }

  getUsage(scope: RateLimitScope): { minuteTokens: number; minuteRequests: number; hourlyTokens: number } {
    const key = this.getScopeKey(scope);
    const bucket = this.getBucket(key);
    return {
      minuteTokens: bucket.tokens,
      minuteRequests: bucket.requests,
      hourlyTokens: bucket.hourlyTokens,
    };
  }

  reset(scope?: RateLimitScope): void {
    if (scope) {
      const key = this.getScopeKey(scope);
      this.buckets.delete(key);
    } else {
      this.buckets.clear();
    }
  }
}
