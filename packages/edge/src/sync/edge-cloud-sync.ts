import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ResourceSnapshot } from "../runtime/resource-monitor.js";

export interface EdgeCloudSyncConfig {
  /** Cloud server base URL (e.g. "https://api.example.com"). */
  cloudUrl: string;
  /** Unique device/edge node identifier. */
  deviceId: string;
  /** Auth token for cloud API requests. */
  authToken?: string;
  /** Heartbeat interval in ms (default 30000). */
  heartbeatIntervalMs?: number;
  /** Local SQLite-like queue directory for offline events (default /tmp/agentium-edge-queue). */
  queueDir?: string;
  /** Max queued events before oldest are dropped (default 10000). */
  maxQueueSize?: number;
  /** Auto-flush interval in ms — attempt to push queued events (default 60000). */
  flushIntervalMs?: number;
}

interface QueuedEvent {
  id: string;
  timestamp: number;
  type: string;
  payload: unknown;
}

/**
 * EdgeCloudSync — connects an edge device to a cloud Agentium instance.
 *
 * Features:
 * - Heartbeat: periodic POST with device status and resource metrics
 * - Config pull: fetch agent/team blueprints from the cloud admin API
 * - Event push: stream agent run results back to cloud
 * - Offline-first: queue events locally when cloud is unreachable, flush on reconnect
 */
export class EdgeCloudSync extends EventEmitter {
  private config: EdgeCloudSyncConfig;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private queue: QueuedEvent[] = [];
  private queueFile: string;
  private maxQueueSize: number;
  private connected = false;
  private backoffMs = 1000;
  private readonly maxBackoff = 60_000;

  constructor(config: EdgeCloudSyncConfig) {
    super();
    this.config = config;
    this.maxQueueSize = config.maxQueueSize ?? 10_000;

    const queueDir = config.queueDir ?? "/tmp/agentium-edge-queue";
    if (!fs.existsSync(queueDir)) {
      fs.mkdirSync(queueDir, { recursive: true });
    }
    this.queueFile = path.join(queueDir, `${config.deviceId}.jsonl`);

    this.loadQueue();
  }

  /** Start heartbeat and flush timers. */
  start(): void {
    const heartbeatMs = this.config.heartbeatIntervalMs ?? 30_000;
    const flushMs = this.config.flushIntervalMs ?? 60_000;

    this.sendHeartbeat();
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), heartbeatMs);
    this.flushTimer = setInterval(() => this.flush(), flushMs);

    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  /** Stop all timers. */
  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.persistQueue();
  }

  /** Push an event to the cloud. Queues locally if offline. */
  pushEvent(type: string, payload: unknown): void {
    const event: QueuedEvent = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      type,
      payload,
    };

    this.queue.push(event);

    if (this.queue.length > this.maxQueueSize) {
      this.queue.shift(); // drop oldest
    }

    if (this.connected) {
      this.flush();
    } else {
      this.persistQueue();
    }
  }

  /** Pull agent/team blueprints from the cloud admin API. */
  async pullConfig(): Promise<{
    agents: unknown[];
    teams: unknown[];
    workflows: unknown[];
  }> {
    try {
      const [agents, teams, workflows] = await Promise.all([
        this.cloudGet("/admin/agents"),
        this.cloudGet("/admin/teams"),
        this.cloudGet("/admin/workflows"),
      ]);

      this.emit("config-pulled", { agents, teams, workflows });
      return {
        agents: agents as unknown[],
        teams: teams as unknown[],
        workflows: workflows as unknown[],
      };
    } catch (err: any) {
      this.emit("config-pull-error", { error: err.message });
      return { agents: [], teams: [], workflows: [] };
    }
  }

  /** Send heartbeat with device status. */
  async sendHeartbeat(resources?: ResourceSnapshot): Promise<void> {
    const payload = {
      deviceId: this.config.deviceId,
      timestamp: Date.now(),
      status: "alive",
      queuedEvents: this.queue.length,
      resources: resources ?? null,
    };

    try {
      await this.cloudPost("/edge/heartbeat", payload);
      this.onConnected();
    } catch {
      this.onDisconnected();
    }
  }

  /** Attempt to flush all queued events to the cloud. */
  async flush(): Promise<{ sent: number; failed: number; remaining: number }> {
    if (this.queue.length === 0) return { sent: 0, failed: 0, remaining: 0 };

    const batch = [...this.queue];
    let sent = 0;
    let failed = 0;

    try {
      await this.cloudPost("/edge/events", {
        deviceId: this.config.deviceId,
        events: batch,
      });
      sent = batch.length;
      this.queue = [];
      this.persistQueue();
      this.onConnected();
    } catch {
      failed = batch.length;
      this.onDisconnected();
    }

    return { sent, failed, remaining: this.queue.length };
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get queueSize(): number {
    return this.queue.length;
  }

  private async cloudGet(endpoint: string): Promise<unknown> {
    const resp = await fetch(`${this.config.cloudUrl}${endpoint}`, {
      headers: this.getHeaders(),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  private async cloudPost(endpoint: string, body: unknown): Promise<unknown> {
    const resp = await fetch(`${this.config.cloudUrl}${endpoint}`, {
      method: "POST",
      headers: { ...this.getHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.config.authToken) {
      headers.Authorization = `Bearer ${this.config.authToken}`;
    }
    return headers;
  }

  private onConnected(): void {
    if (!this.connected) {
      this.connected = true;
      this.backoffMs = 1000;
      this.emit("connected");
    }
  }

  private onDisconnected(): void {
    if (this.connected) {
      this.connected = false;
      this.emit("disconnected");
    }
    // Exponential backoff for next retry
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoff);
  }

  private persistQueue(): void {
    try {
      const lines = this.queue.map((e) => JSON.stringify(e)).join("\n");
      fs.writeFileSync(this.queueFile, lines, "utf-8");
    } catch {
      /* best-effort — /tmp might be full */
    }
  }

  private loadQueue(): void {
    try {
      if (fs.existsSync(this.queueFile)) {
        const content = fs.readFileSync(this.queueFile, "utf-8").trim();
        if (content) {
          this.queue = content.split("\n").map((line) => JSON.parse(line));
          this.emit("queue-loaded", { count: this.queue.length });
        }
      }
    } catch {
      this.queue = [];
    }
  }
}
