export class VoiceBackpressureError extends Error {
  constructor(message = "Voice queue capacity exceeded") {
    super(message);
    this.name = "VoiceBackpressureError";
  }
}
/** A bounded single-consumer queue. Overflow terminates rather than silently dropping speech. */
export class BoundedVoiceQueue<T> implements AsyncIterable<T> {
  private items: Array<{ value: T; bytes: number }> = [];
  private waiting?: { resolve(value: IteratorResult<T>): void; reject(error: Error): void };
  private ended = false;
  private failure?: Error;
  private used = 0;
  highWaterBytes = 0;
  constructor(
    private maxItems = 64,
    private maxBytes = 1024 * 1024,
  ) {
    if (!Number.isSafeInteger(maxItems) || maxItems < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new Error("Invalid voice queue bounds");
  }
  push(value: T, bytes: number): void {
    if (this.ended) return;
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > this.maxBytes ||
      this.items.length >= this.maxItems ||
      this.used + bytes > this.maxBytes
    ) {
      const error = new VoiceBackpressureError();
      this.fail(error);
      throw error;
    }
    if (this.waiting) {
      const waiter = this.waiting;
      this.waiting = undefined;
      waiter.resolve({ value, done: false });
      return;
    }
    this.items.push({ value, bytes });
    this.used += bytes;
    this.highWaterBytes = Math.max(this.highWaterBytes, this.used);
  }
  close(): void {
    this.ended = true;
    if (!this.items.length && this.waiting) {
      this.waiting.resolve({ value: undefined, done: true });
      this.waiting = undefined;
    }
  }
  fail(error: Error): void {
    this.failure = error;
    this.items = [];
    this.used = 0;
    this.ended = true;
    this.waiting?.reject(error);
    this.waiting = undefined;
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        if (this.failure) throw this.failure;
        const item = this.items.shift();
        if (item) {
          this.used -= item.bytes;
          return { value: item.value, done: false };
        }
        if (this.ended) return { value: undefined, done: true };
        if (this.waiting) throw new Error("Voice queue supports one consumer");
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiting = { resolve, reject };
        });
      },
      return: async () => {
        this.items = [];
        this.used = 0;
        this.close();
        return { value: undefined, done: true };
      },
    };
  }
}
