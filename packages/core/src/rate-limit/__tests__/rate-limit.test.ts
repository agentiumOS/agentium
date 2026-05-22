import { describe, expect, it, vi } from "vitest";
import { ConcurrencyLimiter } from "../concurrency-limiter.js";
import { TokenRateLimiter } from "../token-rate-limiter.js";

describe("TokenRateLimiter", () => {
  describe("check()", () => {
    it("allows requests within limits", () => {
      const limiter = new TokenRateLimiter({ maxTokensPerMinute: 1000 });
      const status = limiter.check({ tenantId: "t1" });
      expect(status.allowed).toBe(true);
    });
  });

  describe("acquire()", () => {
    it("allows and tracks token usage", () => {
      const limiter = new TokenRateLimiter({ maxTokensPerMinute: 1000 });
      const s1 = limiter.acquire(500, {});
      expect(s1.allowed).toBe(true);

      const s2 = limiter.acquire(400, {});
      expect(s2.allowed).toBe(true);

      const s3 = limiter.acquire(200, {});
      expect(s3.allowed).toBe(false);
    });

    it("rejects when request limit reached", () => {
      const limiter = new TokenRateLimiter({ maxRequestsPerMinute: 2 });
      limiter.acquire(10, {});
      limiter.acquire(10, {});
      const status = limiter.acquire(10, {});
      expect(status.allowed).toBe(false);
    });

    it("enforces hourly token limits", () => {
      const limiter = new TokenRateLimiter({ maxTokensPerHour: 500 });
      limiter.acquire(300, {});
      limiter.acquire(150, {});
      const status = limiter.acquire(100, {});
      expect(status.allowed).toBe(false);
    });
  });

  describe("per-tenant scoping", () => {
    it("tracks tenants independently", () => {
      const limiter = new TokenRateLimiter({
        maxTokensPerMinute: 1000,
        perTenant: true,
      });

      limiter.acquire(800, { tenantId: "acme" });
      const acmeStatus = limiter.acquire(300, { tenantId: "acme" });
      expect(acmeStatus.allowed).toBe(false);

      const globexStatus = limiter.acquire(300, { tenantId: "globex" });
      expect(globexStatus.allowed).toBe(true);
    });
  });

  describe("per-user scoping", () => {
    it("tracks users independently", () => {
      const limiter = new TokenRateLimiter({
        maxTokensPerMinute: 500,
        perUser: true,
      });

      limiter.acquire(400, { userId: "alice" });
      const aliceStatus = limiter.acquire(200, { userId: "alice" });
      expect(aliceStatus.allowed).toBe(false);

      const bobStatus = limiter.acquire(200, { userId: "bob" });
      expect(bobStatus.allowed).toBe(true);
    });
  });

  describe("record()", () => {
    it("adjusts usage for actual vs estimated tokens", () => {
      const limiter = new TokenRateLimiter({ maxTokensPerMinute: 1000 });
      limiter.acquire(500, {});
      limiter.record(300, 500, {}); // Used 200 less
      const usage = limiter.getUsage({});
      expect(usage.minuteTokens).toBe(300);
    });
  });

  describe("getUsage()", () => {
    it("returns current usage", () => {
      const limiter = new TokenRateLimiter({ maxTokensPerMinute: 1000 });
      limiter.acquire(100, {});
      limiter.acquire(200, {});
      const usage = limiter.getUsage({});
      expect(usage.minuteTokens).toBe(300);
      expect(usage.minuteRequests).toBe(2);
    });
  });

  describe("reset()", () => {
    it("resets specific scope", () => {
      const limiter = new TokenRateLimiter({ maxTokensPerMinute: 1000, perTenant: true });
      limiter.acquire(500, { tenantId: "acme" });
      limiter.acquire(500, { tenantId: "globex" });

      limiter.reset({ tenantId: "acme" });
      expect(limiter.getUsage({ tenantId: "acme" }).minuteTokens).toBe(0);
      expect(limiter.getUsage({ tenantId: "globex" }).minuteTokens).toBe(500);
    });

    it("resets all scopes when no scope given", () => {
      const limiter = new TokenRateLimiter({ maxTokensPerMinute: 1000 });
      limiter.acquire(500, {});
      limiter.reset();
      expect(limiter.getUsage({}).minuteTokens).toBe(0);
    });
  });

  describe("window reset", () => {
    it("resets minute window after 60s", () => {
      vi.useFakeTimers();
      const limiter = new TokenRateLimiter({ maxTokensPerMinute: 100 });

      limiter.acquire(90, {});
      expect(limiter.acquire(20, {}).allowed).toBe(false);

      vi.advanceTimersByTime(61_000);
      expect(limiter.acquire(20, {}).allowed).toBe(true);
      vi.useRealTimers();
    });
  });
});

describe("ConcurrencyLimiter", () => {
  it("allows up to max concurrent", async () => {
    const limiter = new ConcurrencyLimiter(2);
    const r1 = await limiter.acquire();
    const r2 = await limiter.acquire();

    expect(limiter.active).toBe(2);
    expect(limiter.available).toBe(0);

    r1();
    expect(limiter.active).toBe(1);
    expect(limiter.available).toBe(1);

    r2();
    expect(limiter.active).toBe(0);
  });

  it("queues requests beyond limit", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const r1 = await limiter.acquire();

    let r2Resolved = false;
    const r2Promise = limiter.acquire().then((release) => {
      r2Resolved = true;
      return release;
    });

    expect(limiter.pending).toBe(1);
    expect(r2Resolved).toBe(false);

    r1(); // Free up slot
    const r2 = await r2Promise;
    expect(r2Resolved).toBe(true);
    expect(limiter.active).toBe(1);
    r2();
  });

  it("handles timeout for queued requests", async () => {
    vi.useFakeTimers();
    const limiter = new ConcurrencyLimiter(1, 100);
    const r1 = await limiter.acquire();

    const acquirePromise = limiter.acquire();
    vi.advanceTimersByTime(150);

    await expect(acquirePromise).rejects.toThrow("Concurrency limit reached");
    r1();
    vi.useRealTimers();
  });

  it("prevents double-release", async () => {
    const limiter = new ConcurrencyLimiter(2);
    const release = await limiter.acquire();

    release();
    release(); // Should be a no-op
    expect(limiter.active).toBe(0);
    expect(limiter.available).toBe(2);
  });

  it("drains queued requests in order", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const r1 = await limiter.acquire();

    const order: number[] = [];
    const p2 = limiter.acquire().then((rel) => {
      order.push(2);
      return rel;
    });
    const p3 = limiter.acquire().then((rel) => {
      order.push(3);
      return rel;
    });

    expect(limiter.pending).toBe(2);

    r1();
    const r2 = await p2;
    r2();
    const r3 = await p3;
    r3();

    expect(order).toEqual([2, 3]);
  });
});
