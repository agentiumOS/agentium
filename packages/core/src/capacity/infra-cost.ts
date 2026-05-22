import { planCapacity } from "./capacity-planner.js";
import type {
  CapacityPlan,
  ConfigComparison,
  GpuPricing,
  HardwareConfig,
  KvPrecision,
  ModelArchitecture,
  WeightPrecision,
  WorkloadMix,
} from "./types.js";

const HOURS_PER_MONTH = 730;

/**
 * On-demand GPU pricing (USD/hour) for major cloud providers.
 * Keyed by GpuSpec.id so `planCapacity` can auto-resolve pricing.
 */
export const DEFAULT_GPU_PRICING: Record<string, GpuPricing> = {
  "h100-sxm": {
    id: "h100-sxm",
    name: "H100 SXM (AWS p5)",
    perHourOnDemand: 3.99,
    perHourReserved: 2.49,
    perHourSpot: 1.5,
  },
  "a100-sxm": {
    id: "a100-sxm",
    name: "A100 80GB (AWS p4de)",
    perHourOnDemand: 3.06,
    perHourReserved: 1.91,
    perHourSpot: 1.2,
  },
  l40s: {
    id: "l40s",
    name: "L40S (GCP g2)",
    perHourOnDemand: 1.84,
    perHourReserved: 1.15,
    perHourSpot: 0.7,
  },
  "rtx-a5000": {
    id: "rtx-a5000",
    name: "RTX A5000 (cloud/colo est.)",
    perHourOnDemand: 1.1,
    perHourReserved: 0.75,
    perHourSpot: 0.55,
  },
  "rtx-4090": {
    id: "rtx-4090",
    name: "RTX 4090 (self-hosted est.)",
    perHourOnDemand: 0.74,
    perHourReserved: 0.74,
    perHourSpot: 0.74,
  },
};

/**
 * Monthly GPU infrastructure cost.
 */
export function monthlyGpuCost(
  gpuCount: number,
  pricing: GpuPricing,
  tier: "onDemand" | "reserved" | "spot" = "onDemand",
): number {
  const rate =
    tier === "reserved"
      ? (pricing.perHourReserved ?? pricing.perHourOnDemand)
      : tier === "spot"
        ? (pricing.perHourSpot ?? pricing.perHourOnDemand)
        : pricing.perHourOnDemand;
  return gpuCount * rate * HOURS_PER_MONTH;
}

/**
 * Cost per managed session per month (monthly GPU cost / total sessions).
 */
export function costPerSession(plan: CapacityPlan, pricing?: GpuPricing): number {
  const p = pricing ?? DEFAULT_GPU_PRICING[plan.hardware.gpu.id];
  if (!p || plan.totalSessions === 0) return 0;
  return monthlyGpuCost(plan.hardware.gpuCount, p) / plan.totalSessions;
}

/**
 * Compare multiple hardware configurations side-by-side for the same model
 * and workload, returning a summary for each.
 */
export function compareConfigs(
  arch: ModelArchitecture,
  configs: { label: string; hardware: HardwareConfig }[],
  workload: WorkloadMix,
  kvPrecision: KvPrecision = "bf16",
  weightPrecision: WeightPrecision = "bf16",
): ConfigComparison[] {
  return configs.map(({ label, hardware }) => {
    const plan = planCapacity(arch, hardware, workload, kvPrecision, weightPrecision);
    const pricing = DEFAULT_GPU_PRICING[hardware.gpu.id];
    const monthly = pricing ? monthlyGpuCost(hardware.gpuCount, pricing) : 0;
    return {
      label,
      hardware,
      plan,
      monthlyCost: monthly,
      costPerSession: plan.totalSessions > 0 ? monthly / plan.totalSessions : 0,
    };
  });
}
