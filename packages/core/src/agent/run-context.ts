import { v4 as uuidv4 } from "uuid";
import type { EventBus } from "../events/event-bus.js";

export class RunContext {
  readonly runId: string;
  readonly sessionId: string;
  readonly userId?: string;
  readonly tenantId?: string;
  readonly metadata: Record<string, unknown>;
  readonly eventBus: EventBus;
  sessionState: Record<string, unknown>;
  /** AbortSignal for cancelling the run mid-execution. */
  readonly signal?: AbortSignal;
  /** Resolved runtime dependencies available to tools and hooks. */
  readonly dependencies: Record<string, string>;

  constructor(opts: {
    sessionId: string;
    userId?: string;
    tenantId?: string;
    metadata?: Record<string, unknown>;
    eventBus: EventBus;
    sessionState?: Record<string, unknown>;
    runId?: string;
    signal?: AbortSignal;
    dependencies?: Record<string, string>;
  }) {
    this.runId = opts.runId ?? uuidv4();
    this.sessionId = opts.sessionId;
    this.userId = opts.userId;
    this.tenantId = opts.tenantId;
    this.metadata = opts.metadata ?? {};
    this.eventBus = opts.eventBus;
    this.sessionState = opts.sessionState ?? {};
    this.signal = opts.signal;
    this.dependencies = opts.dependencies ?? {};
  }

  getState<T>(key: string): T | undefined {
    return this.sessionState[key] as T | undefined;
  }

  setState(key: string, value: unknown): void {
    this.sessionState[key] = value;
  }
}
