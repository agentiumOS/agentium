import { EventEmitter } from "node:events";
import type { AgentEventMap } from "./types.js";

type EventKey = keyof AgentEventMap;

export class EventBus {
  private static readonly MAX_LISTENERS = 200;
  private emitter = new EventEmitter();

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

  emit<K extends EventKey>(event: K, data: AgentEventMap[K]): boolean {
    return this.emitter.emit(event, data);
  }

  removeAllListeners(event?: EventKey): this {
    this.emitter.removeAllListeners(event);
    return this;
  }
}
