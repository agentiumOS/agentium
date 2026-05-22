import { EventEmitter } from "node:events";
import * as http from "node:http";
import type { Agent } from "@agentium/core";
import { type EdgePreset, edgePreset } from "./edge-config.js";
import { ResourceMonitor, type ResourceSnapshot } from "./resource-monitor.js";

export interface EdgeRuntimeConfig {
  /** Edge preset ID or custom preset object. */
  preset: string | EdgePreset;
  /** Agent instance to manage. */
  agent: Agent;
  /** Port for the health check HTTP server (default 9090). */
  healthPort?: number;
  /** Disable the health check endpoint. */
  disableHealthCheck?: boolean;
  /** Callback when agent is restarted by the watchdog. */
  onWatchdogRestart?: (reason: string) => void;
  /** Toolkits that can be shed under memory pressure (by name). */
  sheddableToolkits?: string[];
}

export interface EdgeRuntimeStatus {
  state: "starting" | "running" | "degraded" | "stopped";
  uptime_ms: number;
  watchdog_restarts: number;
  resources: ResourceSnapshot | null;
  degraded_reason: string | null;
}

/**
 * EdgeRuntime — manages an Agent on constrained edge hardware.
 *
 * Features:
 * - Watchdog: auto-detect unresponsive agent and emit restart event
 * - Resource Monitor: CPU temp, memory, disk tracking with threshold events
 * - Graceful degradation: shed non-critical tools under memory pressure
 * - Health endpoint: lightweight HTTP `/health` for external monitoring
 */
export class EdgeRuntime extends EventEmitter {
  private config: EdgeRuntimeConfig;
  private preset: EdgePreset;
  private monitor: ResourceMonitor;
  private healthServer: http.Server | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivity: number = Date.now();
  private startTime: number = Date.now();
  private watchdogRestarts = 0;
  private _state: "starting" | "running" | "degraded" | "stopped" = "stopped";
  private degradedReason: string | null = null;

  constructor(config: EdgeRuntimeConfig) {
    super();
    this.config = config;
    this.preset = typeof config.preset === "string" ? edgePreset(config.preset) : config.preset;

    this.monitor = new ResourceMonitor({
      intervalMs: this.preset.monitorIntervalMs,
      thresholds: {
        thermalThrottleC: this.preset.thermalThrottleC,
        memoryThreshold: this.preset.memoryThreshold,
      },
    });

    this.monitor.on("thermal-warning", (data) => {
      this.emit("thermal-warning", data);
      this.enterDegraded(`CPU temperature ${data.temperature}°C exceeds ${data.threshold}°C`);
    });

    this.monitor.on("memory-warning", (data) => {
      this.emit("memory-warning", data);
      this.enterDegraded(`Memory usage ${data.usage_percent}% exceeds ${data.threshold}%`);
    });

    this.monitor.on("snapshot", (snap: ResourceSnapshot) => {
      this.emit("resource-snapshot", snap);
      // If conditions have recovered, exit degraded state
      if (this._state === "degraded") {
        const memOk = snap.memory.usage_percent / 100 <= this.preset.memoryThreshold;
        const tempOk = snap.cpu.temperature_c === null || snap.cpu.temperature_c <= this.preset.thermalThrottleC;
        if (memOk && tempOk) {
          this._state = "running";
          this.degradedReason = null;
          this.emit("recovered");
        }
      }
    });
  }

  get state() {
    return this._state;
  }

  /** Start the edge runtime: resource monitor, watchdog, and health endpoint. */
  async start(): Promise<void> {
    this._state = "starting";
    this.startTime = Date.now();
    this.lastActivity = Date.now();

    this.monitor.start();
    this.startWatchdog();

    if (!this.config.disableHealthCheck) {
      await this.startHealthServer();
    }

    this._state = "running";
    this.emit("started");
  }

  /** Stop the runtime cleanly. */
  async stop(): Promise<void> {
    this._state = "stopped";
    this.monitor.stop();
    this.stopWatchdog();

    if (this.healthServer) {
      await new Promise<void>((resolve) => {
        this.healthServer!.close(() => resolve());
      });
      this.healthServer = null;
    }

    this.emit("stopped");
  }

  /** Signal that the agent is alive — call this from agent hooks. */
  heartbeat(): void {
    this.lastActivity = Date.now();
  }

  /** Get current runtime status. */
  getStatus(): EdgeRuntimeStatus {
    return {
      state: this._state,
      uptime_ms: Date.now() - this.startTime,
      watchdog_restarts: this.watchdogRestarts,
      resources: this.monitor.lastSnapshot,
      degraded_reason: this.degradedReason,
    };
  }

  /** Get the resource monitor for direct access. */
  getMonitor(): ResourceMonitor {
    return this.monitor;
  }

  private enterDegraded(reason: string): void {
    if (this._state === "stopped") return;
    this._state = "degraded";
    this.degradedReason = reason;
    this.emit("degraded", { reason });
  }

  private startWatchdog(): void {
    if (this.watchdogTimer) return;

    this.watchdogTimer = setInterval(
      () => {
        const elapsed = Date.now() - this.lastActivity;
        if (elapsed > this.preset.watchdogTimeoutMs) {
          this.watchdogRestarts++;
          const reason = `Agent unresponsive for ${elapsed}ms (threshold: ${this.preset.watchdogTimeoutMs}ms)`;
          this.emit("watchdog-restart", { reason, restarts: this.watchdogRestarts });
          this.config.onWatchdogRestart?.(reason);
          this.lastActivity = Date.now(); // Reset to avoid rapid-fire restarts
        }
      },
      Math.min(this.preset.watchdogTimeoutMs / 2, 5000),
    );

    if (this.watchdogTimer.unref) this.watchdogTimer.unref();
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private startHealthServer(): Promise<void> {
    const port = this.config.healthPort ?? 9090;

    return new Promise((resolve, reject) => {
      this.healthServer = http.createServer((_req, res) => {
        if (_req.url === "/health" || _req.url === "/") {
          const status = this.getStatus();
          const httpCode = status.state === "stopped" ? 503 : 200;
          res.writeHead(httpCode, { "Content-Type": "application/json" });
          res.end(JSON.stringify(status));
        } else {
          res.writeHead(404);
          res.end("Not Found");
        }
      });

      this.healthServer.listen(port, () => {
        this.emit("health-server-started", { port });
        resolve();
      });

      this.healthServer.on("error", (err) => {
        this.emit("health-server-error", err);
        reject(err);
      });

      // Don't keep the process alive just for health checks
      this.healthServer.unref();
    });
  }
}
