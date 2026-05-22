export type CircuitState = "closed" | "open" | "half-open";
export type ErrorClassification = "retry" | "cascade" | "fatal";

export interface CircuitBreakerConfig {
  failureThreshold: number;
  cooldownMs: number;
  halfOpenMaxAttempts: number;
  classifyError?: (error: unknown) => ErrorClassification;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  cooldownMs: 30_000,
  halfOpenMaxAttempts: 2,
  classifyError: defaultClassifyError,
};

export function defaultClassifyError(error: unknown): ErrorClassification {
  if (error && typeof error === "object") {
    const status = (error as any).status ?? (error as any).statusCode;
    if (status === 401 || status === 403 || status === 404) return "cascade";
    if (status === 429 || (status >= 500 && status < 600)) return "retry";

    const code = (error as any).code;
    if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND") return "retry";

    const msg = (error as any).message;
    if (typeof msg === "string") {
      if (/content.?filter|content.?policy|safety/i.test(msg)) return "fatal";
      if (/rate.limit|too.many.requests|overloaded/i.test(msg)) return "retry";
      if (/unauthorized|forbidden|not.found/i.test(msg)) return "cascade";
    }
  }
  return "retry";
}

export class CircuitBreaker {
  private _state: CircuitState = "closed";
  private failureCount = 0;
  private lastFailureTime = 0;
  private halfOpenSuccesses = 0;
  private config: CircuitBreakerConfig;
  private classifyError: (error: unknown) => ErrorClassification;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.classifyError = this.config.classifyError ?? defaultClassifyError;
  }

  get state(): CircuitState {
    if (this._state === "open") {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.config.cooldownMs) {
        this._state = "half-open";
        this.halfOpenSuccesses = 0;
      }
    }
    return this._state;
  }

  canAttempt(): boolean {
    const s = this.state;
    return s === "closed" || s === "half-open";
  }

  recordSuccess(): void {
    if (this._state === "half-open") {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.config.halfOpenMaxAttempts) {
        this._state = "closed";
        this.failureCount = 0;
      }
    } else {
      this.failureCount = 0;
    }
  }

  recordFailure(error: unknown): ErrorClassification {
    const classification = this.classifyError(error);

    if (classification === "cascade" || classification === "retry") {
      this.failureCount++;
      this.lastFailureTime = Date.now();

      if (this._state === "half-open") {
        this._state = "open";
      } else if (this.failureCount >= this.config.failureThreshold) {
        this._state = "open";
      }
    }

    return classification;
  }

  reset(): void {
    this._state = "closed";
    this.failureCount = 0;
    this.halfOpenSuccesses = 0;
    this.lastFailureTime = 0;
  }

  get metrics(): { state: CircuitState; failureCount: number; lastFailureTime: number } {
    return {
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
    };
  }
}
