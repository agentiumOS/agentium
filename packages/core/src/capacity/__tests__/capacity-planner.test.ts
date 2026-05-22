import { describe, expect, it } from "vitest";
import { DEFAULT_ARCHITECTURES, DEFAULT_GPU_SPECS } from "../architectures.js";
import { estimateGpuCount, maxConcurrentSessions, planCapacity } from "../capacity-planner.js";
import type { HardwareConfig, WorkloadMix } from "../types.js";

const llama70b = DEFAULT_ARCHITECTURES["llama-3.1-70b"];
const h100 = DEFAULT_GPU_SPECS["h100-sxm"];

function hw(gpuCount: number, nandPerGpuGb = 0): HardwareConfig {
  return { gpu: h100, gpuCount, nandPerGpuGb, nandBandwidthGBs: 7 };
}

describe("maxConcurrentSessions", () => {
  it("2x H100 bf16 → ~62K tokens max context (from 20 GB free HBM)", () => {
    // 2x80=160 GB total, -140 weights, -5 overhead = 15 GB free
    // 15 GB / (4096 * 327,680 bytes/tok) GB per session at 4K ctx
    const result = maxConcurrentSessions(llama70b, hw(2), 4096, "bf16", "bf16");
    expect(result.hbmSlots).toBeGreaterThan(0);
    expect(result.hbmSlots).toBeLessThan(15);
  });

  it("4x H100 bf16 → much more KV headroom", () => {
    const s2 = maxConcurrentSessions(llama70b, hw(2), 4096, "bf16", "bf16");
    const s4 = maxConcurrentSessions(llama70b, hw(4), 4096, "bf16", "bf16");
    expect(s4.hbmSlots).toBeGreaterThan(s2.hbmSlots * 2);
  });

  it("includes NAND slots when SSD is configured", () => {
    const result = maxConcurrentSessions(llama70b, hw(4, 4000), 4096, "fp8", "bf16");
    expect(result.nandSlots).toBeGreaterThan(0);
    expect(result.total).toBe(result.hbmSlots + result.nandSlots);
  });

  it("returns zero NAND slots when no SSD", () => {
    const result = maxConcurrentSessions(llama70b, hw(4, 0), 4096, "bf16", "bf16");
    expect(result.nandSlots).toBe(0);
  });

  it("fp8 KV doubles HBM slots vs bf16", () => {
    const bf16 = maxConcurrentSessions(llama70b, hw(4), 4096, "bf16", "bf16");
    const fp8 = maxConcurrentSessions(llama70b, hw(4), 4096, "fp8", "bf16");
    expect(fp8.hbmSlots).toBeGreaterThanOrEqual(bf16.hbmSlots * 2 - 1);
  });
});

describe("estimateGpuCount", () => {
  it("needs at least 2 H100s for Llama 70B bf16 weights alone", () => {
    const count = estimateGpuCount(llama70b, 1, 4096, "bf16", "bf16", h100);
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("needs 1 H100 for int4 weights", () => {
    const count = estimateGpuCount(llama70b, 1, 4096, "bf16", "int4", h100);
    expect(count).toBe(1);
  });

  it("scales with user count", () => {
    const few = estimateGpuCount(llama70b, 10, 4096, "fp8", "bf16", h100);
    const many = estimateGpuCount(llama70b, 100, 4096, "fp8", "bf16", h100);
    expect(many).toBeGreaterThan(few);
  });
});

describe("planCapacity", () => {
  const workload: WorkloadMix = { extreme: 1, heavy: 2, medium: 3, light: 4 };

  it("returns a complete plan", () => {
    const plan = planCapacity(llama70b, hw(8), workload, "fp8", "bf16");
    expect(plan.model.id).toBe("llama-3.1-70b");
    expect(plan.totalHbmGb).toBe(640);
    expect(plan.weightMemoryGb).toBe(140);
    expect(plan.freeHbmForKvGb).toBe(495);
    expect(plan.hbmSlots).toBeGreaterThan(0);
    expect(plan.tpotMs).toBeGreaterThan(0);
    expect(plan.ttftMs).toBeGreaterThan(0);
    expect(plan.ttftBreachPoint).toBeGreaterThan(0);
    expect(plan.monthlyGpuCostUsd).toBeGreaterThan(0);
  });

  it("includes NAND slots when SSD is configured", () => {
    const plan = planCapacity(llama70b, hw(8, 2000), workload, "fp8", "bf16");
    expect(plan.nandSlots).toBeGreaterThan(0);
    expect(plan.restoreLatencyMs).not.toBeNull();
    expect(plan.totalSessions).toBe(plan.hbmSlots + plan.nandSlots);
  });

  it("restoreLatencyMs is null when no SSD", () => {
    const plan = planCapacity(llama70b, hw(8), workload, "fp8", "bf16");
    expect(plan.restoreLatencyMs).toBeNull();
  });
});
