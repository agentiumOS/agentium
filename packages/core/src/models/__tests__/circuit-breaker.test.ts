import { beforeEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker, defaultClassifyError } from "../circuit-breaker.js";

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 1000,
      halfOpenMaxAttempts: 2,
    });
  });

  describe("initial state", () => {
    it("starts in closed state", () => {
      expect(breaker.state).toBe("closed");
    });

    it("can attempt when closed", () => {
      expect(breaker.canAttempt()).toBe(true);
    });

    it("metrics reflect initial state", () => {
      expect(breaker.metrics).toEqual({
        state: "closed",
        failureCount: 0,
        lastFailureTime: 0,
      });
    });
  });

  describe("state transitions: closed → open", () => {
    it("remains closed below failure threshold", () => {
      breaker.recordFailure(new Error("fail 1"));
      breaker.recordFailure(new Error("fail 2"));
      expect(breaker.state).toBe("closed");
      expect(breaker.canAttempt()).toBe(true);
    });

    it("opens after reaching failure threshold", () => {
      breaker.recordFailure(new Error("fail 1"));
      breaker.recordFailure(new Error("fail 2"));
      breaker.recordFailure(new Error("fail 3"));
      expect(breaker.state).toBe("open");
      expect(breaker.canAttempt()).toBe(false);
    });

    it("records failure count in metrics", () => {
      breaker.recordFailure(new Error("fail"));
      breaker.recordFailure(new Error("fail"));
      expect(breaker.metrics.failureCount).toBe(2);
    });
  });

  describe("state transitions: open → half-open", () => {
    it("transitions to half-open after cooldown", () => {
      breaker.recordFailure(new Error("1"));
      breaker.recordFailure(new Error("2"));
      breaker.recordFailure(new Error("3"));
      expect(breaker.state).toBe("open");

      vi.useFakeTimers();
      vi.advanceTimersByTime(1001);
      expect(breaker.state).toBe("half-open");
      expect(breaker.canAttempt()).toBe(true);
      vi.useRealTimers();
    });
  });

  describe("state transitions: half-open → closed / open", () => {
    function openAndWait() {
      breaker.recordFailure(new Error("1"));
      breaker.recordFailure(new Error("2"));
      breaker.recordFailure(new Error("3"));
      vi.useFakeTimers();
      vi.advanceTimersByTime(1001);
    }

    it("closes after enough successes in half-open", () => {
      openAndWait();
      expect(breaker.state).toBe("half-open");

      breaker.recordSuccess();
      breaker.recordSuccess();
      expect(breaker.state).toBe("closed");
      vi.useRealTimers();
    });

    it("re-opens on failure in half-open", () => {
      openAndWait();
      expect(breaker.state).toBe("half-open");

      breaker.recordFailure(new Error("again"));
      expect(breaker.state).toBe("open");
      vi.useRealTimers();
    });
  });

  describe("success resets failure count", () => {
    it("resets counter in closed state", () => {
      breaker.recordFailure(new Error("1"));
      breaker.recordFailure(new Error("2"));
      breaker.recordSuccess();
      expect(breaker.metrics.failureCount).toBe(0);

      breaker.recordFailure(new Error("1"));
      breaker.recordFailure(new Error("2"));
      expect(breaker.state).toBe("closed");
    });
  });

  describe("reset()", () => {
    it("restores to initial state", () => {
      breaker.recordFailure(new Error("1"));
      breaker.recordFailure(new Error("2"));
      breaker.recordFailure(new Error("3"));
      expect(breaker.state).toBe("open");

      breaker.reset();
      expect(breaker.state).toBe("closed");
      expect(breaker.metrics.failureCount).toBe(0);
      expect(breaker.canAttempt()).toBe(true);
    });
  });

  describe("error classification", () => {
    it("returns classification from recordFailure", () => {
      const result = breaker.recordFailure(new Error("test"));
      expect(["retry", "cascade", "fatal"]).toContain(result);
    });

    it("does not count fatal errors toward threshold", () => {
      const customBreaker = new CircuitBreaker({
        failureThreshold: 3,
        cooldownMs: 1000,
        halfOpenMaxAttempts: 2,
        classifyError: () => "fatal",
      });

      customBreaker.recordFailure(new Error("1"));
      customBreaker.recordFailure(new Error("2"));
      customBreaker.recordFailure(new Error("3"));
      expect(customBreaker.state).toBe("closed");
    });
  });
});

describe("defaultClassifyError", () => {
  it("classifies 429 as retry", () => {
    expect(defaultClassifyError({ status: 429 })).toBe("retry");
  });

  it("classifies 500 as retry", () => {
    expect(defaultClassifyError({ status: 500 })).toBe("retry");
  });

  it("classifies 503 as retry", () => {
    expect(defaultClassifyError({ statusCode: 503 })).toBe("retry");
  });

  it("classifies 401 as cascade", () => {
    expect(defaultClassifyError({ status: 401 })).toBe("cascade");
  });

  it("classifies 403 as cascade", () => {
    expect(defaultClassifyError({ status: 403 })).toBe("cascade");
  });

  it("classifies 404 as cascade", () => {
    expect(defaultClassifyError({ status: 404 })).toBe("cascade");
  });

  it("classifies ECONNRESET as retry", () => {
    expect(defaultClassifyError({ code: "ECONNRESET" })).toBe("retry");
  });

  it("classifies ETIMEDOUT as retry", () => {
    expect(defaultClassifyError({ code: "ETIMEDOUT" })).toBe("retry");
  });

  it("classifies content policy violation as fatal", () => {
    expect(defaultClassifyError({ message: "content policy violation" })).toBe("fatal");
  });

  it("classifies content filter as fatal", () => {
    expect(defaultClassifyError({ message: "content_filter triggered" })).toBe("fatal");
  });

  it("defaults to retry for unknown errors", () => {
    expect(defaultClassifyError(new Error("something weird"))).toBe("retry");
  });

  it("handles non-object errors", () => {
    expect(defaultClassifyError("string error")).toBe("retry");
    expect(defaultClassifyError(null)).toBe("retry");
    expect(defaultClassifyError(42)).toBe("retry");
  });
});
