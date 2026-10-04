import { randomUUID as uuidv4 } from "node:crypto";
import type { EventBus } from "../events/event-bus.js";
import type { ExecutionPolicy, RunMode } from "../tools/execution-policy.js";

export class RunContext {
  readonly executionServices?: import("./execution-services.js").ExecutionServices;
  readonly ephemeral: boolean;
  readonly externalHistory?: readonly import("../models/types.js").ChatMessage[];
  readonly runMode: RunMode;
  readonly executionPolicy?: ExecutionPolicy;
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
  /** Per-run Jev questions, when `agent.run(input, { questions })` is used. */
  readonly questions?: Record<string, unknown>;

  constructor(opts: {
    sessionId: string;
    userId?: string;
    tenantId?: string;
    metadata?: Record<string, unknown>;
    eventBus: EventBus;
    sessionState?: Record<string, unknown>;
    runId?: string;
    executionServices?: import("./execution-services.js").ExecutionServices;
    ephemeral?: boolean;
    externalHistory?: readonly import("../models/types.js").ChatMessage[];
    runMode?: RunMode;
    executionPolicy?: ExecutionPolicy;
    signal?: AbortSignal;
    dependencies?: Record<string, string>;
    questions?: Record<string, unknown>;
  }) {
    this.executionServices = opts.executionServices;
    this.externalHistory = opts.externalHistory;
    this.ephemeral = opts.ephemeral ?? false;
    this.runMode = opts.runMode ?? "execute";
    this.executionPolicy = opts.executionPolicy;
    Object.defineProperty(this, "executionPolicy", { writable: false, configurable: false });
    Object.defineProperty(this, "runMode", { writable: false, configurable: false });
    this.runId = opts.runId ?? uuidv4();
    this.sessionId = opts.sessionId;
    this.userId = opts.userId;
    this.tenantId = opts.tenantId;
    this.metadata = opts.metadata ?? {};
    this.eventBus = opts.eventBus;
    this.sessionState = opts.sessionState ?? {};
    this.signal = opts.signal;
    this.dependencies = opts.dependencies ?? {};
    this.questions = opts.questions;
  }

  getState<T>(key: string): T | undefined {
    return this.sessionState[key] as T | undefined;
  }

  setState(key: string, value: unknown): void {
    this.sessionState[key] = value;
  }
}
