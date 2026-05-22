import type { EventBus } from "../events/event-bus.js";
import type { WebhookConfig, WebhookDestination } from "./types.js";

interface BatchedEvent {
  event: string;
  payload: unknown;
  timestamp: number;
}

export class WebhookManager {
  private destinations: WebhookDestination[];
  private eventFilter: Set<string> | null;
  private batchInterval: number;
  private retries: number;
  private onError: "log" | "throw";
  private batch: BatchedEvent[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: tracks which bus is attached for future detach validation
  private attachedBus: EventBus | null = null;
  private handlers: Array<{ event: string; handler: (...args: any[]) => void }> = [];

  constructor(config: WebhookConfig) {
    this.destinations = config.destinations;
    this.eventFilter = config.events ? new Set(config.events) : null;
    this.batchInterval = config.batchInterval ?? 0;
    this.retries = config.retries ?? 2;
    this.onError = config.onError ?? "log";
  }

  attach(eventBus: EventBus): void {
    this.attachedBus = eventBus;

    const knownEvents = [
      "run.start",
      "run.complete",
      "run.error",
      "run.stream.chunk",
      "tool.call",
      "tool.result",
      "team.delegate",
      "workflow.step",
      "memory.extract",
      "memory.stored",
      "memory.error",
      "skill.loaded",
      "skill.learned",
      "handoff.transfer",
      "handoff.complete",
      "cost.tracked",
      "cost.budget.exceeded",
      "cache.hit",
      "cache.miss",
    ];

    for (const evt of knownEvents) {
      if (this.eventFilter && !this.eventFilter.has(evt)) continue;
      const evtHandler = (data: unknown) => {
        if (this.batchInterval > 0) {
          this.batch.push({ event: evt, payload: data, timestamp: Date.now() });
          if (!this.batchTimer) {
            this.scheduleBatchFlush();
          }
        } else {
          this.sendToAll(evt, data);
        }
      };
      (eventBus as any).on(evt, evtHandler);
      this.handlers.push({ event: evt, handler: evtHandler });
    }
  }

  detach(eventBus: EventBus): void {
    for (const { event, handler } of this.handlers) {
      (eventBus as any).off(event, handler);
    }
    this.handlers = [];
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.attachedBus = null;
  }

  private scheduleBatchFlush(): void {
    if (this.batchTimer) return;
    const flush = async () => {
      try {
        await this.flush();
      } catch (err) {
        console.warn("[WebhookManager] Batch flush failed:", err);
      }
      this.batchTimer = setTimeout(flush, this.batchInterval);
    };
    this.batchTimer = setTimeout(flush, this.batchInterval);
  }

  async flush(): Promise<void> {
    if (this.batch.length === 0) return;

    const events = [...this.batch];
    this.batch = [];

    for (const { event, payload } of events) {
      await this.sendToAll(event, payload);
    }
  }

  private async sendToAll(event: string, payload: unknown): Promise<void> {
    const results = await Promise.allSettled(this.destinations.map((dest) => this.sendWithRetry(dest, event, payload)));
    if (this.onError === "throw") {
      const failed = results.find((r) => r.status === "rejected");
      if (failed) throw (failed as PromiseRejectedResult).reason;
    }
  }

  private async sendWithRetry(dest: WebhookDestination, event: string, payload: unknown): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        await dest.send(event, payload);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.retries) {
          await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
        }
      }
    }

    if (lastError) {
      if (this.onError === "log") {
        console.error(`[WebhookManager] Failed to send to "${dest.name}": ${lastError.message}`);
      } else {
        throw lastError;
      }
    }
  }
}
