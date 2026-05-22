export class RunCancelledError extends Error {
  constructor(message = "Run was cancelled via AbortSignal") {
    super(message);
    this.name = "RunCancelledError";
  }
}
