import { describe, expect, it } from "vitest";
import { DEFAULT_ARCHITECTURES, DEFAULT_GPU_SPECS } from "../architectures.js";
import { estimateTpot, estimateTtft, restoreLatency, singlePrefillMs, ttftBreachPoint } from "../latency-estimator.js";
import type { HardwareConfig } from "../types.js";

const llama70b = DEFAULT_ARCHITECTURES["llama-3.1-70b"];
const h100 = DEFAULT_GPU_SPECS["h100-sxm"];
const a100 = DEFAULT_GPU_SPECS["a100-sxm"];

function hw(gpuCount: number, gpu = h100): HardwareConfig {
  return { gpu, gpuCount, nandPerGpuGb: 0, nandBandwidthGBs: 7 };
}

describe("estimateTpot", () => {
  it("produces positive latency", () => {
    const tpot = estimateTpot(llama70b, 4096, 1, hw(2), "bf16");
    expect(tpot).toBeGreaterThan(0);
  });

  it("scales linearly with context length", () => {
    const short = estimateTpot(llama70b, 1000, 1, hw(2), "bf16");
    const long = estimateTpot(llama70b, 2000, 1, hw(2), "bf16");
    expect(long).toBeCloseTo(short * 2, 4);
  });

  it("scales linearly with batch size", () => {
    const b1 = estimateTpot(llama70b, 4096, 1, hw(4), "bf16");
    const b4 = estimateTpot(llama70b, 4096, 4, hw(4), "bf16");
    expect(b4).toBeCloseTo(b1 * 4, 4);
  });

  it("halves with fp8 precision", () => {
    const bf16 = estimateTpot(llama70b, 4096, 1, hw(4), "bf16");
    const fp8 = estimateTpot(llama70b, 4096, 1, hw(4), "fp8");
    expect(fp8).toBeCloseTo(bf16 / 2, 4);
  });

  it("improves with more GPUs (more aggregate bandwidth)", () => {
    const g2 = estimateTpot(llama70b, 4096, 1, hw(2), "bf16");
    const g4 = estimateTpot(llama70b, 4096, 1, hw(4), "bf16");
    expect(g4).toBeCloseTo(g2 / 2, 4);
  });

  it("H100 is faster than A100 (higher bandwidth)", () => {
    const h = estimateTpot(llama70b, 4096, 1, hw(4, h100), "bf16");
    const a = estimateTpot(llama70b, 4096, 1, hw(4, a100), "bf16");
    expect(h).toBeLessThan(a);
  });
});

describe("singlePrefillMs", () => {
  it("produces positive value", () => {
    const ms = singlePrefillMs(llama70b, 4096, hw(4));
    expect(ms).toBeGreaterThan(0);
  });

  it("longer prompts take longer (quadratic attention)", () => {
    const short = singlePrefillMs(llama70b, 1000, hw(4));
    const long = singlePrefillMs(llama70b, 4000, hw(4));
    expect(long).toBeGreaterThan(short * 4);
  });
});

describe("estimateTtft", () => {
  it("TTFT grows with concurrent users", () => {
    const solo = estimateTtft(llama70b, 4096, 1, hw(4));
    const ten = estimateTtft(llama70b, 4096, 10, hw(4));
    expect(ten).toBeGreaterThan(solo);
  });

  it("more GPUs reduce TTFT", () => {
    const g2 = estimateTtft(llama70b, 4096, 10, hw(2));
    const g8 = estimateTtft(llama70b, 4096, 10, hw(8));
    expect(g8).toBeLessThan(g2);
  });
});

describe("ttftBreachPoint", () => {
  it("returns the max users before 5s SLA breach", () => {
    const breach = ttftBreachPoint(llama70b, hw(4), 5000, 4096);
    expect(breach).toBeGreaterThan(1);
    expect(breach).toBeLessThan(10_000);
  });

  it("more GPUs push breach point higher", () => {
    const b4 = ttftBreachPoint(llama70b, hw(4), 5000, 4096);
    const b8 = ttftBreachPoint(llama70b, hw(8), 5000, 4096);
    expect(b8).toBeGreaterThan(b4);
  });

  it("longer prompts reduce breach point", () => {
    const short = ttftBreachPoint(llama70b, hw(4), 5000, 1024);
    const long = ttftBreachPoint(llama70b, hw(4), 5000, 32768);
    expect(long).toBeLessThan(short);
  });
});

describe("restoreLatency", () => {
  it("computes correct restore time", () => {
    // 40 GB at 7 GB/s = 5714 ms
    const ms = restoreLatency(40, 7);
    expect(ms).toBeCloseTo(5714, -1);
  });

  it("parallelism increases per-stream restore time", () => {
    const single = restoreLatency(40, 7, 1);
    const quad = restoreLatency(40, 7, 4);
    expect(quad).toBeCloseTo(single * 4, 0);
  });

  it("Gen5 NVMe is faster than Gen4", () => {
    const gen4 = restoreLatency(10, 7);
    const gen5 = restoreLatency(10, 14);
    expect(gen5).toBeCloseTo(gen4 / 2, 0);
  });
});
