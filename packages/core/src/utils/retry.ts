export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  retryableErrors?: (error: unknown) => boolean;
}

const DEFAULT_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  retryableErrors: isRetryableError,
};

function isRetryableError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const status = (error as any).status ?? (error as any).statusCode;
    if (status === 429 || (status >= 500 && status < 600)) return true;

    const code = (error as any).code;
    if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND") return true;

    const msg = (error as any).message;
    if (typeof msg === "string" && /rate.limit|too.many.requests|overloaded/i.test(msg)) return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(fn: () => Promise<T>, config?: Partial<RetryConfig>): Promise<T> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let lastError: unknown;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= cfg.maxRetries || !cfg.retryableErrors!(error)) throw error;

      const delay = Math.min(cfg.initialDelayMs * 2 ** attempt + Math.random() * 200, cfg.maxDelayMs);
      await sleep(delay);
    }
  }

  throw lastError;
}
