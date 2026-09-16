import { EventEmitter } from "node:events";
import type { AgentEventMap } from "./types.js";

type EventKey = keyof AgentEventMap;
export type AnyEventHandler = (event: string, data: unknown) => void;

/**
 * Typed pub/sub for agent lifecycle.
 *
 * Observe with `on` / `onAny`. Do not use this bus to steer a run —
 * use `loopHooks` when you need to skip a tool or stop the loop.
 *
 * By default each Agent/Team/Workflow gets its own bus. Pass
 * `EventBus.shared` (or `sharedEventBus: true` on Agent) when one tracer
 * should see every entity in the process.
 */
export class EventBus {
  private static readonly MAX_LISTENERS = 200;
  private static _shared: EventBus | undefined;

  private emitter = new EventEmitter();
  private anyHandlers = new Set<AnyEventHandler>();

  /** Process-wide bus. Safe to attach a single tracer/metrics collector. */
  static get shared(): EventBus {
    if (!EventBus._shared) {
      EventBus._shared = new EventBus();
    }
    return EventBus._shared;
  }

  /** Reset the shared singleton. For tests only. */
  static resetShared(): void {
    EventBus._shared?.removeAllListeners();
    EventBus._shared = undefined;
  }

  constructor() {
    this.emitter.setMaxListeners(EventBus.MAX_LISTENERS);
    this.emitter.on("error", (err) => {
      console.error("[EventBus] Unhandled error:", err);
    });
  }

  on<K extends EventKey>(event: K, handler: (data: AgentEventMap[K]) => void): this {
    this.emitter.on(event, handler as (...args: unknown[]) => void);
    return this;
  }

  once<K extends EventKey>(event: K, handler: (data: AgentEventMap[K]) => void): this {
    this.emitter.once(event, handler as (...args: unknown[]) => void);
    return this;
  }

  off<K extends EventKey>(event: K, handler: (data: AgentEventMap[K]) => void): this {
    this.emitter.off(event, handler as (...args: unknown[]) => void);
    return this;
  }

  /**
   * Subscribe to every event. Preferred attachment point for tracers and
   * metrics — avoids casting and survives new event names.
   */
  onAny(handler: AnyEventHandler): this {
    this.anyHandlers.add(handler);
    return this;
  }

  offAny(handler: AnyEventHandler): this {
    this.anyHandlers.delete(handler);
    return this;
  }

  emit<K extends EventKey>(event: K, data: AgentEventMap[K]): boolean {
    for (const handler of this.anyHandlers) {
      try {
        handler(event, data);
      } catch (err) {
        console.error("[EventBus] onAny handler error:", err);
      }
    }
    return this.emitter.emit(event, data);
  }

  removeAllListeners(event?: EventKey): this {
    if (!event) {
      this.anyHandlers.clear();
    }
    this.emitter.removeAllListeners(event);
    return this;
  }
}
