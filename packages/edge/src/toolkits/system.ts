import * as fs from "node:fs";
import * as os from "node:os";
import type { ToolDef } from "@agentium/core";
import { Toolkit } from "@agentium/core";
import { z } from "zod";

export interface SystemConfig {
  /** Include per-process info in process list (default false — can be slow). */
  includeProcessDetails?: boolean;
}

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

  // macOS fallback — not available without native addons
  return null;
}

function getCpuFrequency(): number | null {
  const raw = readFileQuiet("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq");
  if (raw) return Number(raw) / 1000; // kHz → MHz
  return null;
}

function getDiskUsage(): { total: number; free: number; used: number; usedPercent: number } {
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
}

function safeUptime(): number {
  try {
    return os.uptime();
  } catch {
    return 0;
  }
}

function getNetworkInfo(): Array<{ iface: string; address: string; family: string; mac: string }> {
  let nets: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  try {
    nets = os.networkInterfaces();
  } catch {
    return [];
  }
  const results: Array<{ iface: string; address: string; family: string; mac: string }> = [];
  for (const [name, addrs] of Object.entries(nets)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.internal) continue;
      results.push({ iface: name, address: a.address, family: a.family, mac: a.mac });
    }
  }
  return results;
}

/**
 * SystemToolkit — zero-dependency system information tools.
 * Reads from `/proc/`, `/sys/`, and the Node.js `os` module.
 * Works on Linux (Raspberry Pi) and degrades gracefully on macOS/Windows.
 */
export class SystemToolkit extends Toolkit {
  readonly name = "system";
  private includeProcessDetails: boolean;

  constructor(config: SystemConfig = {}) {
    super();
    this.includeProcessDetails = config.includeProcessDetails ?? false;
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "system_info",
        description:
          "Get system information: CPU temperature, frequency, memory usage, disk usage, uptime, platform, and architecture.",
        parameters: z.object({}),
        execute: async () => {
          const totalMem = os.totalmem();
          const freeMem = os.freemem();
          const usedMem = totalMem - freeMem;
          const disk = getDiskUsage();

          const info: Record<string, unknown> = {
            platform: os.platform(),
            arch: os.arch(),
            hostname: os.hostname(),
            uptime_seconds: safeUptime(),
            cpu: {
              model: os.cpus()[0]?.model ?? "unknown",
              cores: os.cpus().length,
              temperature_c: getCpuTemp(),
              frequency_mhz: getCpuFrequency(),
            },
            memory: {
              total_bytes: totalMem,
              used_bytes: usedMem,
              free_bytes: freeMem,
              used_percent: Math.round((usedMem / totalMem) * 1000) / 10,
            },
            disk: {
              total_bytes: disk.total,
              used_bytes: disk.used,
              free_bytes: disk.free,
              used_percent: disk.usedPercent,
            },
          };

          return JSON.stringify(info, null, 2);
        },
      },
      {
        name: "system_process_list",
        description: "List running processes (Linux). Returns PID, command name, and memory usage.",
        parameters: z.object({
          limit: z.number().optional().describe("Max number of processes to return (default 20)"),
        }),
        execute: async (args) => {
          const limit = (args.limit as number) ?? 20;

          if (os.platform() !== "linux") {
            return JSON.stringify({ error: "Process list is only available on Linux" });
          }

          try {
            const procDirs = fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d));
            const procs: Array<{ pid: number; name: string; rss_kb: number }> = [];

            for (const pid of procDirs.slice(0, this.includeProcessDetails ? undefined : limit * 2)) {
              try {
                const status = fs.readFileSync(`/proc/${pid}/status`, "utf-8");
                const nameMatch = status.match(/^Name:\s+(.+)$/m);
                const rssMatch = status.match(/^VmRSS:\s+(\d+)/m);
                if (nameMatch) {
                  procs.push({
                    pid: Number(pid),
                    name: nameMatch[1],
                    rss_kb: rssMatch ? Number(rssMatch[1]) : 0,
                  });
                }
              } catch {
                /* process may have exited */
              }
            }

            procs.sort((a, b) => b.rss_kb - a.rss_kb);
            return JSON.stringify(procs.slice(0, limit));
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "system_network_info",
        description:
          "Get network interface information: IP addresses, MAC addresses, and interface names. On Linux may include WiFi SSID.",
        parameters: z.object({}),
        execute: async () => {
          const interfaces = getNetworkInfo();

          let wifiSsid: string | null = null;
          if (os.platform() === "linux") {
            const iwconfig = readFileQuiet("/proc/net/wireless");
            if (iwconfig) {
              const wifiIface = iwconfig
                .split("\n")
                .slice(2)
                .map((l) => l.trim().split(":")[0])
                .filter(Boolean)[0];
              if (wifiIface) {
                try {
                  const { execSync } = await import("node:child_process");
                  const ssid = execSync(`iwgetid -r 2>/dev/null`, { encoding: "utf-8" }).trim();
                  if (ssid) wifiSsid = ssid;
                } catch {
                  /* iwgetid not available */
                }
              }
            }
          }

          return JSON.stringify({ interfaces, wifi_ssid: wifiSsid }, null, 2);
        },
      },
    ];
  }
}
