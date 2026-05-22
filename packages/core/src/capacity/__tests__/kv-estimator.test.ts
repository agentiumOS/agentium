import { describe, expect, it } from "vitest";
import { DEFAULT_ARCHITECTURES } from "../architectures.js";
import { kvBytesPerToken, kvCacheForContext, maxContextForMemory, weightMemory } from "../kv-estimator.js";

const llama70b = DEFAULT_ARCHITECTURES["llama-3.1-70b"];
const llama8b = DEFAULT_ARCHITECTURES["llama-3.1-8b"];
const falcon7b = DEFAULT_ARCHITECTURES["falcon-7b"];

describe("kvBytesPerToken", () => {
  it("computes correct bf16 KV size for Llama 3.1 70B", () => {
    // 2 * 80 layers * 8 kv_heads * 128 head_dim * 2 bytes = 327,680
    expect(kvBytesPerToken(llama70b, "bf16")).toBe(327_680);
  });

  it("computes correct fp8 KV size for Llama 3.1 70B", () => {
    // 2 * 80 * 8 * 128 * 1 = 163,840
    expect(kvBytesPerToken(llama70b, "fp8")).toBe(163_840);
  });

  it("computes correct int4 KV size for Llama 3.1 70B", () => {
    // 2 * 80 * 8 * 128 * 0.5 = 81,920
    expect(kvBytesPerToken(llama70b, "int4")).toBe(81_920);
  });

  it("computes correct bf16 KV size for Llama 3.1 8B (GQA with 8 KV heads)", () => {
    // 2 * 32 * 8 * 128 * 2 = 131,072
    expect(kvBytesPerToken(llama8b, "bf16")).toBe(131_072);
  });

  it("handles MQA (single KV head) correctly for Falcon 7B", () => {
    // 2 * 32 * 1 * 64 * 2 = 8,192
    expect(kvBytesPerToken(falcon7b, "bf16")).toBe(8_192);
  });
});

describe("kvCacheForContext", () => {
  it("computes ~40 GB for 128K context on Llama 70B bf16", () => {
    const result = kvCacheForContext(llama70b, 131_072, "bf16");
    expect(result.gb).toBeCloseTo(40, 0);
  });

  it("computes ~1.25 GB for 4K context on Llama 70B bf16", () => {
    const result = kvCacheForContext(llama70b, 4_096, "bf16");
    expect(result.gb).toBeCloseTo(1.25, 1);
  });

  it("halves with fp8 precision", () => {
    const bf16 = kvCacheForContext(llama70b, 4_096, "bf16");
    const fp8 = kvCacheForContext(llama70b, 4_096, "fp8");
    expect(fp8.gb).toBeCloseTo(bf16.gb / 2, 4);
  });
});

describe("maxContextForMemory", () => {
  it("computes ~62,500 tokens for 20 GB on Llama 70B bf16", () => {
    const tokens = maxContextForMemory(llama70b, 20, "bf16");
    expect(tokens).toBeGreaterThan(62_000);
    expect(tokens).toBeLessThan(66_000);
  });

  it("doubles capacity with fp8", () => {
    const bf16 = maxContextForMemory(llama70b, 20, "bf16");
    const fp8 = maxContextForMemory(llama70b, 20, "fp8");
    expect(fp8).toBeCloseTo(bf16 * 2, -2);
  });
});

describe("weightMemory", () => {
  it("returns full bf16 size for Llama 70B", () => {
    expect(weightMemory(llama70b, "bf16")).toBe(140);
  });

  it("halves for int8", () => {
    expect(weightMemory(llama70b, "int8")).toBe(70);
  });

  it("quarters for int4", () => {
    expect(weightMemory(llama70b, "int4")).toBe(35);
  });
});
