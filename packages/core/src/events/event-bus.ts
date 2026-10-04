import { EventEmitter } from "node:events";
import type { AgentEventMap } from "./types.js";

type EventKey = keyof AgentEventMap;
export type AnyEventHandler = (event: string, data: unknown) => void;
export interface ObserverFailure {
  event: string;
  kind: "named" | "any";
  /** Host-only diagnostic; never emitted back through this bus or logged implicitly. */
  error: unknown;
}
export interface EventBusOptions {
  onObserverError?: (failure: ObserverFailure) => void | Promise<void>;
  /** Lifetime report cap. Further failures are counted, not queued. Default 100. */
  maxObserverDiagnostics?: number;
}
/** Observation-only lifecycle pub/sub. Use hooks, approval and execution policy for control flow.
 * Listeners run in registration order without awaiting promises; each failure is isolated.
 */
export class EventBus {
  private static _shared: EventBus | undefined;
  private emitter = new EventEmitter();
  private anyHandlers = new Set<AnyEventHandler>();
  private diagnosing = false;
  private failures = 0;
  private reported = 0;
  private readonly diagnostic: EventBusOptions["onObserverError"];
  private readonly diagnosticLimit: number;
  static get shared(): EventBus {
    return (EventBus._shared ??= new EventBus());
  }
  static resetShared(): void {
    EventBus._shared?.removeAllListeners();
    EventBus._shared = undefined;
  }
  constructor(options: EventBusOptions = {}) {
    this.emitter.setMaxListeners(200);
    this.diagnostic = options.onObserverError;
    this.diagnosticLimit = options.maxObserverDiagnostics ?? 100;
    if (!Number.isSafeInteger(this.diagnosticLimit) || this.diagnosticLimit < 0)
      throw new TypeError("Invalid observer diagnostic limit");
  }
  on<K extends EventKey>(event: K, handler: (data: AgentEventMap[K]) => void): this {
    this.emitter.on(event, handler);
    return this;
  }
  once<K extends EventKey>(event: K, handler: (data: AgentEventMap[K]) => void): this {
    this.emitter.once(event, handler);
    return this;
  }
  off<K extends EventKey>(event: K, handler: (data: AgentEventMap[K]) => void): this {
    this.emitter.off(event, handler);
    return this;
  }
  onAny(handler: AnyEventHandler): this {
    this.anyHandlers.add(handler);
    return this;
  }
  offAny(handler: AnyEventHandler): this {
    this.anyHandlers.delete(handler);
    return this;
  }
  emit<K extends EventKey>(event: K, data: AgentEventMap[K]): boolean {
    for (const handler of [...this.anyHandlers]) this.observe(() => handler(event, data), event, "any");
    // rawListeners preserves EventEmitter's once wrappers (including off(original), reentrant once,
    // snapshot delivery and duplicate listener removal), while isolating each invocation.
    const listeners = this.emitter.rawListeners(event);
    for (const listener of listeners) this.observe(() => listener.call(this.emitter, data), event, "named");
    return listeners.length > 0;
  }
  private observe(call: () => unknown, event: string, kind: ObserverFailure["kind"]) {
    try {
      const returned = call();
      if (returned && (typeof returned === "object" || typeof returned === "function"))
        void Promise.resolve(returned).catch((error) => this.report({ event, kind, error }));
    } catch (error) {
      this.report({ event, kind, error });
    }
  }
  private report(failure: ObserverFailure) {
    this.failures++;
    if (!this.diagnostic || this.diagnosing || this.reported >= this.diagnosticLimit) return;
    this.reported++;
    this.diagnosing = true;
    try {
      const result = this.diagnostic(failure);
      if (result && (typeof result === "object" || typeof result === "function")) {
        void Promise.resolve(result).then(
          () => {
            this.diagnosing = false;
          },
          () => {
            this.diagnosing = false;
          },
        );
      } else this.diagnosing = false;
    } catch {
      this.diagnosing = false;
    }
  }
  getObserverDiagnostics(): { failures: number; reported: number; suppressed: number } {
    return { failures: this.failures, reported: this.reported, suppressed: this.failures - this.reported };
  }
  removeAllListeners(event?: EventKey): this {
    if (!event) this.anyHandlers.clear();
    this.emitter.removeAllListeners(event);
    return this;
  }
}
