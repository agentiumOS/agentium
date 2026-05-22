export interface ModelArchitecture {
  id: string;
  displayName: string;
  family: string;
  params: string;
  layers: number;
  attentionHeads: number;
  kvHeads: number;
  headDim: number;
  hiddenDim: number;
  ffnDim: number;
  maxContext: number;
  attentionType: "mha" | "gqa" | "mqa";
  weightSizeBf16Gb: number;
}

export type KvPrecision = "bf16" | "fp8" | "int8" | "int4";
export type WeightPrecision = "bf16" | "int8" | "int4";

export interface GpuSpec {
  id: string;
  name: string;
  hbmGb: number;
  bandwidthTBs: number;
  bf16Tflops: number;
  nvlinkBwGBs: number;
}

export interface HardwareConfig {
  gpu: GpuSpec;
  gpuCount: number;
  /** Per-GPU NAND SSD capacity in GB. 0 = no SSD offload. */
  nandPerGpuGb: number;
  /** Sustained SSD read bandwidth in GB/s (7 for Gen4, 14 for Gen5). */
  nandBandwidthGBs: number;
  cpuDramGb?: number;
}

export type SessionCategory = "light" | "medium" | "heavy" | "extreme";

export interface WorkloadMix {
  extreme: number;
  heavy: number;
  medium: number;
  light: number;
}

export interface CapacityPlan {
  model: ModelArchitecture;
  hardware: HardwareConfig;
  kvPrecision: KvPrecision;
  weightPrecision: WeightPrecision;

  totalHbmGb: number;
  weightMemoryGb: number;
  freeHbmForKvGb: number;
  kvBytesPerToken: number;

  hbmSlots: number;
  nandSlots: number;
  totalSessions: number;

  tpotMs: number;
  ttftMs: number;
  restoreLatencyMs: number | null;
  ttftBreachPoint: number;

  monthlyGpuCostUsd: number;
}

/** Default token midpoints for each session category (used in workload sizing). */
export const SESSION_TOKEN_MIDPOINTS: Record<SessionCategory, number> = {
  light: 35_000,
  medium: 130_000,
  heavy: 325_000,
  extreme: 1_250_000,
};

/** Thresholds (upper bounds) for classifying sessions by cumulative token count. */
export const SESSION_CATEGORY_THRESHOLDS: Record<SessionCategory, number> = {
  light: 50_000,
  medium: 200_000,
  heavy: 500_000,
  extreme: Number.POSITIVE_INFINITY,
};

export interface GpuPricing {
  id: string;
  name: string;
  perHourOnDemand: number;
  perHourReserved?: number;
  perHourSpot?: number;
}

export interface ConfigComparison {
  label: string;
  hardware: HardwareConfig;
  plan: CapacityPlan;
  monthlyCost: number;
  costPerSession: number;
}

/** Precision → bytes per element. */
export const PRECISION_BYTES: Record<KvPrecision | WeightPrecision, number> = {
  bf16: 2,
  fp8: 1,
  int8: 1,
  int4: 0.5,
};

/** Activation / framework overhead estimate in GB. */
export const OVERHEAD_GB = 5;
