import { StringDecoder } from "node:string_decoder";
import type { SandboxRunOptions, SandboxRunResult } from "./types.js";

/** Internal owner: one lazily-created session, no admission while close drains active SDK calls. */
export class SandboxSessionOwner<T> {
  private session?: T;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  private active = new Set<Promise<unknown>>();
  constructor(
    private create: () => Promise<T>,
    private dispose: (session: T) => Promise<void>,
    private validate?: (session: T) => void,
  ) {}
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Sandbox is closed; construct a new adapter"));
    if (this.starting) return this.starting;
    if (this.session) return Promise.resolve();
    this.starting = this.create()
      .then(async (session) => {
        this.session = session;
        try {
          this.validate?.(session);
        } catch (error) {
          this.closed = true;
          try {
            await this.dispose(session);
            this.session = undefined;
          } catch (cleanup) {
            throw new AggregateError(
              [error, cleanup],
              "Unsupported sandbox SDK and resource cleanup failed; retry close()",
            );
          }
          throw error;
        }
      })
      .finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }
  async use<R>(operation: (session: T) => Promise<R>, signal?: AbortSignal): Promise<R> {
    signal?.throwIfAborted();
    await this.start();
    signal?.throwIfAborted();
    if (this.closed) throw new Error("Sandbox is closed");
    const pending = operation(this.session!);
    this.active.add(pending);
    try {
      const result = await pending;
      // Never race a remote write against cancellation and claim its effect was stopped.
      signal?.throwIfAborted();
      return result;
    } finally {
      this.active.delete(pending);
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      await this.starting?.catch(() => {});
      await Promise.allSettled([...this.active]);
      if (this.session) {
        await this.dispose(this.session);
        this.session = undefined;
      }
    })().finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }
}
export function sandboxTimeout(options: SandboxRunOptions, fallback: number): number {
  const value = options.timeoutSeconds ?? fallback;
  if (!Number.isFinite(value) || value <= 0 || value > 3600)
    throw new Error("Sandbox timeoutSeconds must be between 0 (exclusive) and 3600");
  return value;
}
export function sandboxOutputLimit(value = 1_048_576): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 16_777_216)
    throw new Error("Sandbox maxOutputBytes must be between 1 and 16777216");
  return value;
}
export function sandboxResult(output: string, exitCode: number, limit: number): SandboxRunResult {
  if (typeof output !== "string" || !Number.isSafeInteger(exitCode))
    throw new Error("Invalid sandbox execution response");
  const bytes = Buffer.from(output);
  return {
    output: bytes.length > limit ? new StringDecoder("utf8").write(bytes.subarray(0, limit)) : output,
    exitCode,
    ...(bytes.length > limit ? { outputTruncated: true } : {}),
  };
}
export function requireSandboxMethods(session: unknown, paths: string[]): void {
  for (const path of paths) {
    let value: unknown = session;
    for (const key of path.split(".")) value = (value as Record<string, unknown> | undefined)?.[key];
    if (typeof value !== "function") throw new Error(`Unsupported sandbox SDK: missing ${path}`);
  }
}
