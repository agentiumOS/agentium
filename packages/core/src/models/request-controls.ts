import { captureRetryFailure } from "../cost/context.js";
import type { ModelConfig } from "./types.js";

/** Two independent retry owners. Set both counts to zero when the host owns retries. */
export interface ProviderRequestControls {
  /** Agentium retries after the initial SDK invocation. Default: 2. */
  maxRetries?: number;
  /** SDK retries after its initial HTTP request. Omitted: SDK default (usually 2). */
  sdkMaxRetries?: number;
  /** SDK request timeout in milliseconds; SDK/Agentium may retry a timeout. */
  timeoutMs?: number;
  /** Whole logical call, including backoff and stream consumption, in milliseconds. */
  callTimeoutMs?: number;
}
export class ModelDeadlineError extends Error {
  readonly code = "MODEL_DEADLINE_EXCEEDED";
  readonly retryable = false;
  constructor() {
    super("Logical model call deadline exceeded");
    this.name = "ModelDeadlineError";
  }
}
export function validateRequestControls(config: ProviderRequestControls): void {
  for (const value of [config.maxRetries, config.sdkMaxRetries])
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      throw new TypeError("Retry counts must be nonnegative safe integers");
  for (const value of [config.timeoutMs, config.callTimeoutMs])
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
      throw new TypeError("Timeouts must be positive safe integers");
}
/** Reject promptly while also forwarding cancellation to the underlying operation. */
export async function abortable<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => {};
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
async function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await abortable(
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
      signal,
    );
  } finally {
    clearTimeout(timer);
  }
}
function retryable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("retryable" in error && error.retryable === false) return false;
  const status = "status" in error ? error.status : "statusCode" in error ? error.statusCode : undefined;
  const code = "code" in error ? error.code : undefined;
  return (
    [429, 500, 502, 503].includes(Number(status)) ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    (error instanceof Error && (error.name === "APIConnectionTimeoutError" || error.message.includes("rate limit")))
  );
}
/** One scope per logical generate/stream call; the deadline never restarts on retry. */
export function createRequestScope(
  config: ProviderRequestControls,
  options?: ModelConfig,
): { signal: AbortSignal; retry<T>(work: () => Promise<T>): Promise<T>; dispose(): void } {
  validateRequestControls({ callTimeoutMs: options?.callTimeoutMs });
  if (options?.deadline !== undefined && !Number.isFinite(options.deadline))
    throw new TypeError("Model deadline must be a finite epoch timestamp");
  const controller = new AbortController();
  const cancel = () => controller.abort(options?.signal?.reason);
  options?.signal?.addEventListener("abort", cancel, { once: true });
  if (options?.signal?.aborted) cancel();
  const now = Date.now();
  const deadline = Math.min(
    options?.deadline ?? Infinity,
    config.callTimeoutMs === undefined ? Infinity : now + config.callTimeoutMs,
    options?.callTimeoutMs === undefined ? Infinity : now + options.callTimeoutMs,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    if (controller.signal.aborted || !Number.isFinite(deadline)) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) controller.abort(new ModelDeadlineError());
    else timer = setTimeout(tick, Math.min(remaining, 2_147_483_647));
  };
  tick();
  return {
    signal: controller.signal,
    async retry<T>(work: () => Promise<T>): Promise<T> {
      const retries = config.maxRetries ?? 2;
      for (let attempt = 0; ; attempt++) {
        controller.signal.throwIfAborted();
        try {
          return await abortable(Promise.resolve().then(work), controller.signal);
        } catch (error) {
          controller.signal.throwIfAborted();
          if (attempt >= retries || !retryable(error)) throw error;
          await waitForRetry(Math.min(1000 * 2 ** attempt + Math.random() * 500, 10000), controller.signal);
          controller.signal.throwIfAborted();
          await captureRetryFailure(error);
        }
      }
    },
    dispose() {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", cancel);
      // Also close a stream when its consumer returns early.
      if (!controller.signal.aborted) controller.abort();
    },
  };
}

/** Stream creation may retry; iteration never does. */
export async function* abortableStream<T>(stream: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const iterator = stream[Symbol.asyncIterator]();
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await abortable(iterator.next(), signal);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    if ("controller" in stream && stream.controller instanceof AbortController) stream.controller.abort();
    await iterator.return?.();
  }
}
