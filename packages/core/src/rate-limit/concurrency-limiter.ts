export class ConcurrencyLimiter {
  private maxConcurrent: number;
  private current = 0;
  private queue: Array<{ resolve: (release: () => void) => void; reject: (err: Error) => void }> = [];
  private timeoutMs: number;

  constructor(maxConcurrent: number, timeoutMs = 30_000) {
    this.maxConcurrent = maxConcurrent;
    this.timeoutMs = timeoutMs;
  }

  async acquire(): Promise<() => void> {
    if (this.current < this.maxConcurrent) {
      this.current++;
      return this.createRelease();
    }

    return new Promise<() => void>((resolve, reject) => {
      const entry = { resolve, reject };
      this.queue.push(entry);

      const timer = setTimeout(() => {
        const idx = this.queue.indexOf(entry);
        if (idx >= 0) {
          this.queue.splice(idx, 1);
          reject(
            new Error(
              `Concurrency limit reached (${this.maxConcurrent}). Request timed out after ${this.timeoutMs}ms.`,
            ),
          );
        }
      }, this.timeoutMs);

      const origResolve = entry.resolve;
      entry.resolve = (release) => {
        clearTimeout(timer);
        origResolve(release);
      };
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.current--;
      this.drain();
    };
  }

  private drain(): void {
    while (this.queue.length > 0 && this.current < this.maxConcurrent) {
      const next = this.queue.shift()!;
      this.current++;
      next.resolve(this.createRelease());
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  get active(): number {
    return this.current;
  }

  get available(): number {
    return Math.max(0, this.maxConcurrent - this.current);
  }
}
