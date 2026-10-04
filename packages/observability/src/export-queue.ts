import { boundedWait, Diagnostics, positive, type TelemetryOptions } from "./safety.js";
export interface ExportLimits {
  maxQueuedExports?: number;
  maxQueuedBytes?: number;
  maxInFlight?: number;
  flushTimeoutMs?: number;
}
/** Stalled operations retain their in-flight slot; timing out never creates unbounded replacement work. */
export class ExportQueue<T> {
  private queue: { value: T; bytes: number }[] = [];
  private active = new Set<Promise<void>>();
  private controllers = new Set<AbortController>();
  private bytes = 0;
  private closed = false;
  private readonly maxCount: number;
  private readonly maxBytes: number;
  private readonly concurrency: number;
  readonly timeout: number;
  readonly diagnostics: Diagnostics;
  constructor(
    private send: (value: T, signal: AbortSignal) => Promise<void>,
    options: ExportLimits & TelemetryOptions = {},
  ) {
    this.maxCount = positive(options.maxQueuedExports ?? 128, "maxQueuedExports");
    this.maxBytes = positive(options.maxQueuedBytes ?? 4_194_304, "maxQueuedBytes");
    this.concurrency = positive(options.maxInFlight ?? 2, "maxInFlight");
    this.timeout = positive(options.flushTimeoutMs ?? 5000, "flushTimeoutMs");
    this.diagnostics = new Diagnostics(options);
  }
  add(value: T): boolean {
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(value));
    } catch {
      this.diagnostics.report("export_invalid");
      return false;
    }
    if (this.closed || this.queue.length + this.active.size >= this.maxCount || this.bytes + bytes > this.maxBytes) {
      this.diagnostics.report("export_dropped", { dropped: 1 });
      return false;
    }
    this.queue.push({ value, bytes });
    this.bytes += bytes;
    this.pump();
    return true;
  }
  private pump() {
    while (!this.closed && this.queue.length && this.active.size < this.concurrency) {
      const item = this.queue.shift()!;
      const controller = new AbortController();
      this.controllers.add(controller);
      const work = Promise.resolve()
        .then(() => this.send(item.value, controller.signal))
        .catch(() => {
          this.diagnostics.report("export_failed");
        })
        .finally(() => {
          this.bytes -= item.bytes;
          this.active.delete(work);
          this.controllers.delete(controller);
          this.pump();
        });
      this.active.add(work);
    }
  }
  async flush(): Promise<void> {
    const deadline = Date.now() + this.timeout;
    while (this.active.size || this.queue.length) {
      if (
        !(await boundedWait(Promise.allSettled([...this.active]), Math.max(1, deadline - Date.now()))) ||
        Date.now() >= deadline
      ) {
        this.diagnostics.report("flush_timeout");
        return;
      }
    }
  }
  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
    if (this.queue.length) this.diagnostics.report("export_dropped", { dropped: this.queue.length });
    this.bytes -= this.queue.reduce((sum, item) => sum + item.bytes, 0);
    this.queue = [];
    for (const controller of this.controllers) controller.abort();
  }
  async whenIdle(): Promise<void> {
    await Promise.allSettled([...this.active]);
  }
  stats() {
    return {
      queued: this.queue.length,
      inFlight: this.active.size,
      bytes: this.bytes,
      diagnostics: { ...this.diagnostics.counts },
    };
  }
}
