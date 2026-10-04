import type { ServerResponse } from "node:http";

export interface TextStreamLimits {
  /** Maximum encoded frame and queued response bytes. Default 256 KiB each. */
  maxFrameBytes?: number;
  maxBufferedBytes?: number;
  /** Maximum wait for a writable drain. Default 10 seconds. */
  writeTimeoutMs?: number;
}

export function textStreamLimits(options: TextStreamLimits = {}) {
  const limits = {
    maxFrameBytes: options.maxFrameBytes ?? 256 * 1024,
    maxBufferedBytes: options.maxBufferedBytes ?? 256 * 1024,
    writeTimeoutMs: options.writeTimeoutMs ?? 10_000,
  };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${key}`);
  }
  return limits;
}

/** One owner for the response lifetime. Cancellation remains cooperative. */
export function responseLifetime(res: ServerResponse) {
  const controller = new AbortController();
  const close = () => controller.abort(new Error("Response disconnected"));
  res.once("close", close);
  res.once("error", close);
  if (res.destroyed) close();
  return {
    controller,
    dispose() {
      res.off("close", close);
      res.off("error", close);
    },
  };
}

export class BoundedSSEWriter {
  private readonly limits;
  constructor(
    private readonly res: ServerResponse,
    private readonly signal: AbortSignal,
    options?: TextStreamLimits,
  ) {
    this.limits = textStreamLimits(options);
  }
  async write(frame: string): Promise<void> {
    this.signal.throwIfAborted();
    if (this.res.destroyed || this.res.writableEnded) throw new Error("Response closed");
    const bytes = Buffer.byteLength(frame);
    if (bytes > this.limits.maxFrameBytes || this.res.writableLength + bytes > this.limits.maxBufferedBytes)
      throw new Error("Text stream byte limit exceeded");
    if (this.res.write(frame)) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.res.off("drain", drain);
        this.res.off("close", abort);
        this.res.off("error", fail);
        this.signal.removeEventListener("abort", abort);
      };
      const drain = () => {
        cleanup();
        resolve();
      };
      const fail = (error: unknown) => {
        cleanup();
        reject(error);
      };
      const abort = () => fail(this.signal.reason ?? new Error("Response closed"));
      const timer = setTimeout(
        () => fail(new Error("Text stream write deadline exceeded")),
        this.limits.writeTimeoutMs,
      );
      this.res.once("drain", drain);
      this.res.once("close", abort);
      this.res.once("error", fail);
      this.signal.addEventListener("abort", abort, { once: true });
      if (this.signal.aborted || this.res.destroyed) abort();
    });
  }
}

/** Initiate return on abort even for iterators whose next() settles only after return(). */
export function ownIterator(iterator: AsyncIterator<unknown>, signal: AbortSignal) {
  let closing: Promise<unknown> | undefined;
  const close = () => {
    closing ??= Promise.resolve().then(() => iterator.return?.());
    // Abort listeners cannot return a promise to their caller; always observe rejection.
    void closing.catch(() => {});
    return closing;
  };
  const abort = () => {
    void close();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return { close, dispose: () => signal.removeEventListener("abort", abort) };
}

/** Pull only after the previous frame drained; settle iterator cleanup before terminal output. */
export async function serveTextStream(
  res: ServerResponse,
  source: (signal: AbortSignal) => AsyncIterable<unknown>,
  options?: TextStreamLimits,
): Promise<void> {
  const lifetime = responseLifetime(res);
  const writer = new BoundedSSEWriter(res, lifetime.controller.signal, options);
  let iterator: AsyncIterator<unknown> | undefined;
  let failure: unknown;
  let ownedIterator: ReturnType<typeof ownIterator> | undefined;
  try {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    lifetime.controller.signal.throwIfAborted();
    iterator = source(lifetime.controller.signal)[Symbol.asyncIterator]();
    ownedIterator = ownIterator(iterator, lifetime.controller.signal);
    while (!lifetime.controller.signal.aborted) {
      const next = await iterator.next();
      if (next.done) break;
      await writer.write(`data: ${JSON.stringify(next.value)}\n\n`);
    }
  } catch (error) {
    failure = error;
    lifetime.controller.abort(error);
  } finally {
    try {
      await ownedIterator?.close();
    } catch (error) {
      failure ??= error;
    }
    ownedIterator?.dispose();
    if (!res.destroyed && !res.writableEnded) {
      // A fresh signal permits a bounded error terminal after producer cancellation.
      const terminalWriter = new BoundedSSEWriter(res, new AbortController().signal, options);
      try {
        await terminalWriter.write(
          failure ? `data: ${JSON.stringify({ type: "error", error: "Text stream failed" })}\n\n` : "data: [DONE]\n\n",
        );
        res.end();
      } catch {
        res.destroy();
      }
    }
    lifetime.dispose();
  }
}
