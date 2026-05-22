import { DEFAULT_GPU_PRICING, monthlyGpuCost } from "./infra-cost.js";
import { kvBytesPerToken, kvCacheForContext, weightMemory } from "./kv-estimator.js";
import { estimateTpot, estimateTtft, restoreLatency, ttftBreachPoint } from "./latency-estimator.js";
import type {
  CapacityPlan,
  HardwareConfig,
  KvPrecision,
  ModelArchitecture,
  WeightPrecision,
  WorkloadMix,
} from "./types.js";
import { OVERHEAD_GB, SESSION_TOKEN_MIDPOINTS } from "./types.js";

/**
 * Compute the number of sessions that fit in HBM and on NAND for the given
 * architecture, hardware, and average context size per session.
 */
export function maxConcurrentSessions(
  arch: ModelArchitecture,
  hardware: HardwareConfig,
  avgContextTokens: number,
  kvPrecision: KvPrecision = "bf16",
  weightPrecision: WeightPrecision = "bf16",
): { hbmSlots: number; nandSlots: number; total: number } {
  const totalHbm = hardware.gpu.hbmGb * hardware.gpuCount;
  const weights = weightMemory(arch, weightPrecision);
  const freeHbm = Math.max(0, totalHbm - weights - OVERHEAD_GB);

  const kvPerSession = kvCacheForContext(arch, avgContextTokens, kvPrecision).gb;
  const hbmSlots = kvPerSession > 0 ? Math.floor(freeHbm / kvPerSession) : 0;

  let nandSlots = 0;
  if (hardware.nandPerGpuGb > 0 && kvPerSession > 0) {
    const totalNand = hardware.nandPerGpuGb * hardware.gpuCount;
    nandSlots = Math.floor(totalNand / kvPerSession);
  }

  return { hbmSlots, nandSlots, total: hbmSlots + nandSlots };
}

/**
 * Solve for the minimum GPU count needed to serve `targetUsers` concurrent
 * active sessions (HBM-only, ignoring NAND).
 */
export function estimateGpuCount(
  arch: ModelArchitecture,
  targetUsers: number,
  avgContextTokens: number,
  kvPrecision: KvPrecision = "bf16",
  weightPrecision: WeightPrecision = "bf16",
  gpu?: import("./types.js").GpuSpec,
): number {
  const gpuSpec = gpu ?? {
    id: "h100-sxm",
    name: "H100",
    hbmGb: 80,
    bandwidthTBs: 3.35,
    bf16Tflops: 989,
    nvlinkBwGBs: 900,
  };
  const weights = weightMemory(arch, weightPrecision);
  const kvPerSession = kvCacheForContext(arch, avgContextTokens, kvPrecision).gb;
  if (kvPerSession === 0) return 1;

  const totalKvNeeded = targetUsers * kvPerSession;
  const totalHbmNeeded = weights + OVERHEAD_GB + totalKvNeeded;
  return Math.ceil(totalHbmNeeded / gpuSpec.hbmGb);
}

function weightedAvgContext(workload: WorkloadMix): number {
  const total = workload.extreme + workload.heavy + workload.medium + workload.light;
  if (total === 0) return SESSION_TOKEN_MIDPOINTS.medium;
  return (
    (workload.extreme * SESSION_TOKEN_MIDPOINTS.extreme +
      workload.heavy * SESSION_TOKEN_MIDPOINTS.heavy +
      workload.medium * SESSION_TOKEN_MIDPOINTS.medium +
      workload.light * SESSION_TOKEN_MIDPOINTS.light) /
    total
  );
}

/**
 * Build a full capacity plan for a given model, hardware config, and workload.
 */
export function planCapacity(
  arch: ModelArchitecture,
  hardware: HardwareConfig,
  workload: WorkloadMix,
  kvPrecision: KvPrecision = "bf16",
  weightPrecision: WeightPrecision = "bf16",
): CapacityPlan {
  const totalHbm = hardware.gpu.hbmGb * hardware.gpuCount;
  const weightMem = weightMemory(arch, weightPrecision);
  const freeHbm = Math.max(0, totalHbm - weightMem - OVERHEAD_GB);
  const bpt = kvBytesPerToken(arch, kvPrecision);

  const avgCtx = weightedAvgContext(workload);
  const sessions = maxConcurrentSessions(arch, hardware, avgCtx, kvPrecision, weightPrecision);

  const tpot = estimateTpot(arch, avgCtx, 1, hardware, kvPrecision);
  const totalUsers = workload.extreme + workload.heavy + workload.medium + workload.light;
  const ttft = estimateTtft(arch, avgCtx, Math.max(totalUsers, 1), hardware);
  const breach = ttftBreachPoint(arch, hardware, 5000);

  let restoreMs: number | null = null;
  if (hardware.nandPerGpuGb > 0) {
    const kvPerSessionGb = kvCacheForContext(arch, avgCtx, kvPrecision).gb;
    const perGpuKv = kvPerSessionGb / Math.max(hardware.gpuCount, 1);
    restoreMs = restoreLatency(perGpuKv, hardware.nandBandwidthGBs);
  }

  const pricing = DEFAULT_GPU_PRICING[hardware.gpu.id] ?? Object.values(DEFAULT_GPU_PRICING)[0];
  const monthlyCost = pricing ? monthlyGpuCost(hardware.gpuCount, pricing) : 0;

  return {
    model: arch,
    hardware,
    kvPrecision,
    weightPrecision,
    totalHbmGb: totalHbm,
    weightMemoryGb: weightMem,
    freeHbmForKvGb: freeHbm,
    kvBytesPerToken: bpt,
    hbmSlots: sessions.hbmSlots,
    nandSlots: sessions.nandSlots,
    totalSessions: sessions.total,
    tpotMs: tpot,
    ttftMs: ttft,
    restoreLatencyMs: restoreMs,
    ttftBreachPoint: breach,
    monthlyGpuCostUsd: monthlyCost,
  };
}
