import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";

function safeUptime(): number {
  try {
    return os.uptime();
  } catch {
    return 0;
  }
}

export interface GpuSnapshot {
  name: string;
  memoryUsedGb: number;
  memoryTotalGb: number;
  utilizationPercent: number;
  temperatureC: number;
}

export interface ResourceSnapshot {
  timestamp: number;
  cpu: {
    temperature_c: number | null;
    usage_percent: number;
  };
  memory: {
    total_bytes: number;
    used_bytes: number;
    free_bytes: number;
    usage_percent: number;
  };
  disk: {
    total_bytes: number;
    used_bytes: number;
    free_bytes: number;
    usage_percent: number;
  };
  gpu?: GpuSnapshot;
  uptime_seconds: number;
}

export interface ResourceThresholds {
  /** CPU temperature (°C) — emit "thermal-warning" above this. */
  thermalThrottleC: number;
  /** Memory usage ratio (0-1) — emit "memory-warning" above this. */
  memoryThreshold: number;
  /** Disk usage ratio (0-1) — emit "disk-warning" above this. */
  diskThreshold: number;
}

export interface ResourceMonitorEvents {
  snapshot: [ResourceSnapshot];
  "thermal-warning": [{ temperature: number; threshold: number }];
  "memory-warning": [{ usage_percent: number; threshold: number }];
  "disk-warning": [{ usage_percent: number; threshold: number }];
  "gpu-warning": [{ memoryUsedGb: number; memoryTotalGb: number; utilizationPercent: number }];
}

const DEFAULT_THRESHOLDS: ResourceThresholds = {
  thermalThrottleC: 75,
  memoryThreshold: 0.85,
  diskThreshold: 0.9,
};

function readFileQuiet(path: string): string | null {
  try {
    return fs.readFileSync(path, "utf-8").trim();
  } catch {
    return null;
  }
}

function getCpuTemp(): number | null {
  const raw = readFileQuiet("/sys/class/thermal/thermal_zone0/temp");
  if (raw) return Number(raw) / 1000;
  return null;
}

let prevCpuTimes: { idle: number; total: number } | null = null;

function getCpuUsage(): number {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }

  if (!prevCpuTimes) {
    prevCpuTimes = { idle, total };
    return 0;
  }

  const idleDelta = idle - prevCpuTimes.idle;
  const totalDelta = total - prevCpuTimes.total;
  prevCpuTimes = { idle, total };

  if (totalDelta === 0) return 0;
  return Math.round((1 - idleDelta / totalDelta) * 1000) / 10;
}

function getDiskUsage(): { total: number; free: number; used: number; usedPercent: number } {
  try {
    const { bavail, blocks, bsize } = fs.statfsSync("/");
    const total = blocks * bsize;
    const free = bavail * bsize;
    const used = total - free;
    return {
      total,
      free,
      used,
      usedPercent: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
    };
  } catch {
    return { total: 0, free: 0, used: 0, usedPercent: 0 };
  }
}

function getGpuInfo(): GpuSnapshot | null {
  try {
    const raw = execSync(
      "nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu --format=csv,noheader,nounits",
      { timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
    )
      .toString()
      .trim();
    if (!raw) return null;
    const parts = raw.split(",").map((s) => s.trim());
    if (parts.length < 5) return null;
    return {
      name: parts[0],
      memoryUsedGb: Number(parts[1]) / 1024,
      memoryTotalGb: Number(parts[2]) / 1024,
      utilizationPercent: Number(parts[3]),
      temperatureC: Number(parts[4]),
    };
  } catch {
    return null;
  }
}

/**
 * Monitors system resources (CPU, memory, disk, GPU, temperature) at a
 * configurable interval. Emits events when thresholds are exceeded.
 */
export class ResourceMonitor extends EventEmitter {
  private intervalMs: number;
  private thresholds: ResourceThresholds;
  private timer: ReturnType<typeof setInterval> | null = null;
  private _lastSnapshot: ResourceSnapshot | null = null;

  constructor(opts: { intervalMs?: number; thresholds?: Partial<ResourceThresholds> } = {}) {
    super();
    this.intervalMs = opts.intervalMs ?? 10_000;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };
  }

  get lastSnapshot(): ResourceSnapshot | null {
    return this._lastSnapshot;
  }

  /** Take a single snapshot right now. */
  snapshot(): ResourceSnapshot {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const disk = getDiskUsage();
    const gpu = getGpuInfo();

    const snap: ResourceSnapshot = {
      timestamp: Date.now(),
      cpu: {
        temperature_c: getCpuTemp(),
        usage_percent: getCpuUsage(),
      },
      memory: {
        total_bytes: totalMem,
        used_bytes: usedMem,
        free_bytes: freeMem,
        usage_percent: Math.round((usedMem / totalMem) * 1000) / 10,
      },
      disk: {
        total_bytes: disk.total,
        used_bytes: disk.used,
        free_bytes: disk.free,
        usage_percent: disk.usedPercent,
      },
      gpu: gpu ?? undefined,
      uptime_seconds: safeUptime(),
    };

    this._lastSnapshot = snap;
    return snap;
  }

  /** Start periodic monitoring. */
  start(): void {
    if (this.timer) return;

    // Take initial snapshot
    this.check();

    this.timer = setInterval(() => this.check(), this.intervalMs);

    // Don't keep the process alive just for monitoring
    if (this.timer.unref) this.timer.unref();
  }

  /** Stop periodic monitoring. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private check(): void {
    const snap = this.snapshot();
    this.emit("snapshot", snap);

    if (snap.cpu.temperature_c !== null && snap.cpu.temperature_c > this.thresholds.thermalThrottleC) {
      this.emit("thermal-warning", {
        temperature: snap.cpu.temperature_c,
        threshold: this.thresholds.thermalThrottleC,
      });
    }

    if (snap.memory.usage_percent / 100 > this.thresholds.memoryThreshold) {
      this.emit("memory-warning", {
        usage_percent: snap.memory.usage_percent,
        threshold: this.thresholds.memoryThreshold * 100,
      });
    }

    if (snap.disk.usage_percent / 100 > this.thresholds.diskThreshold) {
      this.emit("disk-warning", {
        usage_percent: snap.disk.usage_percent,
        threshold: this.thresholds.diskThreshold * 100,
      });
    }

    if (snap.gpu && snap.gpu.memoryTotalGb > 0) {
      const gpuUsageRatio = snap.gpu.memoryUsedGb / snap.gpu.memoryTotalGb;
      if (gpuUsageRatio > this.thresholds.memoryThreshold) {
        this.emit("gpu-warning", {
          memoryUsedGb: snap.gpu.memoryUsedGb,
          memoryTotalGb: snap.gpu.memoryTotalGb,
          utilizationPercent: snap.gpu.utilizationPercent,
        });
      }
    }
  }
}
