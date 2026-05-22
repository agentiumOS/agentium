export class RunCancelledError extends Error {
  constructor(message = "Run was cancelled via AbortSignal") {
    super(message);
    this.name = "RunCancelledError";
  }
}

/**
 * Thrown to signal a cooperative graceful drain: an in-flight run is asked to
 * stop after the current step and persist a resumable checkpoint. Callers can
 * resume the run later with the same `runId`.
 */
export class RunDrainedError extends Error {
  readonly runId: string;
  constructor(runId: string, message = "Run was drained gracefully and may be resumed") {
    super(message);
    this.name = "RunDrainedError";
    this.runId = runId;
  }
}

/**
 * A coordinator the application can call to request a graceful drain of an
 * in-flight run. Pass into `agent.run(input, { signal, drain })` (or its
 * factory equivalent) and call `requestDrain()` from any thread/handler.
 */
export class DrainController {
  private _drained = false;
  private resolvers: Array<() => void> = [];

  /** Returns true once `requestDrain()` has been invoked. */
  get drained(): boolean {
    return this._drained;
  }

  /** Request a graceful stop. Idempotent. */
  requestDrain(): void {
    if (this._drained) return;
    this._drained = true;
    for (const r of this.resolvers) r();
    this.resolvers = [];
  }

  /** Resolves once drain is requested. */
  waitForDrain(): Promise<void> {
    if (this._drained) return Promise.resolve();
    return new Promise((resolve) => this.resolvers.push(resolve));
  }
}
