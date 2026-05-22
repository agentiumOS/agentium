import { kvBytesPerToken } from "./kv-estimator.js";
import type { HardwareConfig, KvPrecision, ModelArchitecture } from "./types.js";

/** GPU compute efficiency factor (real-world vs peak TFLOPS). */
const COMPUTE_EFFICIENCY = 0.35;

/**
 * Estimate Time Per Output Token (TPOT) in milliseconds.
 *
 * Decoding is memory-bandwidth-bound: each step streams the full KV cache
 * for all active sequences through HBM.
 *
 * TPOT = (contextTokens * batchSize * kvBytesPerToken) / aggregateBandwidth
 */
export function estimateTpot(
  arch: ModelArchitecture,
  contextTokens: number,
  batchSize: number,
  hardware: HardwareConfig,
  kvPrecision: KvPrecision = "bf16",
): number {
  const bpt = kvBytesPerToken(arch, kvPrecision);
  const totalBytes = contextTokens * batchSize * bpt;
  const bandwidthBytesPerSec = hardware.gpu.bandwidthTBs * hardware.gpuCount * 1e12;
  if (bandwidthBytesPerSec === 0) return Number.POSITIVE_INFINITY;
  return (totalBytes / bandwidthBytesPerSec) * 1000;
}

/**
 * Compute the prefill time for a single prompt (no queue).
 *
 * Prefill is compute-bound (attention is O(N^2), FFN is O(N)):
 *   prefillFlops = (4 * N^2 * hiddenDim + 4 * N * ffnDim) * layers
 *   time = prefillFlops / (gpuTflops * gpuCount * efficiency)
 */
export function singlePrefillMs(arch: ModelArchitecture, promptTokens: number, hardware: HardwareConfig): number {
  const n = promptTokens;
  const flops = (4 * n * n * arch.hiddenDim + 4 * n * arch.ffnDim) * arch.layers;
  const gpuFlops = hardware.gpu.bf16Tflops * hardware.gpuCount * COMPUTE_EFFICIENCY * 1e12;
  if (gpuFlops === 0) return Number.POSITIVE_INFINITY;
  return (flops / gpuFlops) * 1000;
}

/**
 * Estimate Time To First Token (TTFT) under concurrent load.
 *
 * With C concurrent users submitting prefills, a random user is at queue
 * position C/2 on average. Prefills are serialized on the compute path.
 *
 * TTFT(C) = singlePrefill * (C + 1) / 2
 */
export function estimateTtft(
  arch: ModelArchitecture,
  promptTokens: number,
  concurrentUsers: number,
  hardware: HardwareConfig,
): number {
  const single = singlePrefillMs(arch, promptTokens, hardware);
  return (single * (concurrentUsers + 1)) / 2;
}

/**
 * Compute the maximum number of concurrent users before TTFT exceeds the SLA.
 *
 * Solves: singlePrefill * (C + 1) / 2 = ttftSlaMs  →  C = 2 * ttftSlaMs / singlePrefill - 1
 */
export function ttftBreachPoint(
  arch: ModelArchitecture,
  hardware: HardwareConfig,
  ttftSlaMs: number,
  promptTokens?: number,
): number {
  const tokens = promptTokens ?? 4096;
  const single = singlePrefillMs(arch, tokens, hardware);
  if (single === 0) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.ceil((2 * ttftSlaMs) / single - 1));
}

/**
 * Time (ms) to restore a session's KV cache from NAND SSD to HBM.
 *
 * Each GPU restores its own shard in parallel. With multiple parallel
 * restore streams, bandwidth is divided among them.
 */
export function restoreLatency(kvSizeGb: number, nandBandwidthGBs: number, parallelism = 1): number {
  const effectiveBw = nandBandwidthGBs / Math.max(parallelism, 1);
  if (effectiveBw === 0) return Number.POSITIVE_INFINITY;
  return (kvSizeGb / effectiveBw) * 1000;
}
