import type { KvPrecision, ModelArchitecture, WeightPrecision } from "./types.js";
import { PRECISION_BYTES } from "./types.js";

const WEIGHT_PRECISION_RATIO: Record<WeightPrecision, number> = {
  bf16: 1,
  int8: 0.5,
  int4: 0.25,
};

/**
 * KV cache bytes required to store one token for this architecture.
 *
 * Formula: `2 (K+V) * layers * kvHeads * headDim * bytesPerElement`
 */
export function kvBytesPerToken(arch: ModelArchitecture, precision: KvPrecision = "bf16"): number {
  return 2 * arch.layers * arch.kvHeads * arch.headDim * PRECISION_BYTES[precision];
}

/**
 * Total KV cache memory for a given context length.
 */
export function kvCacheForContext(
  arch: ModelArchitecture,
  tokens: number,
  precision: KvPrecision = "bf16",
): { bytes: number; gb: number } {
  const bytes = tokens * kvBytesPerToken(arch, precision);
  return { bytes, gb: bytes / (1024 * 1024 * 1024) };
}

/**
 * Maximum context tokens that fit in the given memory budget.
 */
export function maxContextForMemory(
  arch: ModelArchitecture,
  memoryGb: number,
  precision: KvPrecision = "bf16",
): number {
  const bpt = kvBytesPerToken(arch, precision);
  if (bpt === 0) return 0;
  return Math.floor((memoryGb * 1024 * 1024 * 1024) / bpt);
}

/**
 * Model weight memory at the given precision.
 * `weightSizeBf16Gb` is the baseline; other precisions scale proportionally.
 */
export function weightMemory(arch: ModelArchitecture, precision: WeightPrecision = "bf16"): number {
  return arch.weightSizeBf16Gb * WEIGHT_PRECISION_RATIO[precision];
}
