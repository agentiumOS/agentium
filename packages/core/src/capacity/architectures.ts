import type { GpuSpec, ModelArchitecture } from "./types.js";

/**
 * Model architecture specs sourced from HuggingFace config.json.
 * Key fields: num_hidden_layers, num_attention_heads, num_key_value_heads,
 * hidden_size / num_attention_heads → head_dim.
 */
export const DEFAULT_ARCHITECTURES: Record<string, ModelArchitecture> = {
  // ── Llama 3.1 ───────────────────────────────────────────────────────
  "llama-3.1-8b": {
    id: "llama-3.1-8b",
    displayName: "Llama 3.1 8B",
    family: "llama",
    params: "8B",
    layers: 32,
    attentionHeads: 32,
    kvHeads: 8,
    headDim: 128,
    hiddenDim: 4096,
    ffnDim: 14336,
    maxContext: 131072,
    attentionType: "gqa",
    weightSizeBf16Gb: 16,
  },
  "llama-3.1-70b": {
    id: "llama-3.1-70b",
    displayName: "Llama 3.1 70B",
    family: "llama",
    params: "70B",
    layers: 80,
    attentionHeads: 64,
    kvHeads: 8,
    headDim: 128,
    hiddenDim: 8192,
    ffnDim: 28672,
    maxContext: 131072,
    attentionType: "gqa",
    weightSizeBf16Gb: 140,
  },
  "llama-3.1-405b": {
    id: "llama-3.1-405b",
    displayName: "Llama 3.1 405B",
    family: "llama",
    params: "405B",
    layers: 126,
    attentionHeads: 128,
    kvHeads: 8,
    headDim: 128,
    hiddenDim: 16384,
    ffnDim: 53248,
    maxContext: 131072,
    attentionType: "gqa",
    weightSizeBf16Gb: 810,
  },

  // ── Llama 2 ─────────────────────────────────────────────────────────
  "llama-2-7b": {
    id: "llama-2-7b",
    displayName: "Llama 2 7B",
    family: "llama",
    params: "7B",
    layers: 32,
    attentionHeads: 32,
    kvHeads: 32,
    headDim: 128,
    hiddenDim: 4096,
    ffnDim: 11008,
    maxContext: 4096,
    attentionType: "mha",
    weightSizeBf16Gb: 14,
  },
  "llama-2-13b": {
    id: "llama-2-13b",
    displayName: "Llama 2 13B",
    family: "llama",
    params: "13B",
    layers: 40,
    attentionHeads: 40,
    kvHeads: 40,
    headDim: 128,
    hiddenDim: 5120,
    ffnDim: 13824,
    maxContext: 4096,
    attentionType: "mha",
    weightSizeBf16Gb: 26,
  },
  "llama-2-70b": {
    id: "llama-2-70b",
    displayName: "Llama 2 70B",
    family: "llama",
    params: "70B",
    layers: 80,
    attentionHeads: 64,
    kvHeads: 8,
    headDim: 128,
    hiddenDim: 8192,
    ffnDim: 28672,
    maxContext: 4096,
    attentionType: "gqa",
    weightSizeBf16Gb: 140,
  },

  // ── Mixtral (MoE — weight size includes all experts) ────────────────
  "mixtral-8x7b": {
    id: "mixtral-8x7b",
    displayName: "Mixtral 8x7B",
    family: "mixtral",
    params: "8x7B",
    layers: 32,
    attentionHeads: 32,
    kvHeads: 8,
    headDim: 128,
    hiddenDim: 4096,
    ffnDim: 14336,
    maxContext: 32768,
    attentionType: "gqa",
    weightSizeBf16Gb: 93,
  },
  "mixtral-8x22b": {
    id: "mixtral-8x22b",
    displayName: "Mixtral 8x22B",
    family: "mixtral",
    params: "8x22B",
    layers: 56,
    attentionHeads: 48,
    kvHeads: 8,
    headDim: 128,
    hiddenDim: 6144,
    ffnDim: 16384,
    maxContext: 65536,
    attentionType: "gqa",
    weightSizeBf16Gb: 281,
  },

  // ── Falcon ──────────────────────────────────────────────────────────
  "falcon-7b": {
    id: "falcon-7b",
    displayName: "Falcon 7B",
    family: "falcon",
    params: "7B",
    layers: 32,
    attentionHeads: 71,
    kvHeads: 1,
    headDim: 64,
    hiddenDim: 4544,
    ffnDim: 18176,
    maxContext: 8192,
    attentionType: "mqa",
    weightSizeBf16Gb: 14,
  },
  "falcon-40b": {
    id: "falcon-40b",
    displayName: "Falcon 40B",
    family: "falcon",
    params: "40B",
    layers: 60,
    attentionHeads: 128,
    kvHeads: 8,
    headDim: 64,
    hiddenDim: 8192,
    ffnDim: 32768,
    maxContext: 8192,
    attentionType: "gqa",
    weightSizeBf16Gb: 80,
  },

  // ── Mistral ─────────────────────────────────────────────────────────
  "mistral-7b": {
    id: "mistral-7b",
    displayName: "Mistral 7B",
    family: "mistral",
    params: "7B",
    layers: 32,
    attentionHeads: 32,
    kvHeads: 8,
    headDim: 128,
    hiddenDim: 4096,
    ffnDim: 14336,
    maxContext: 32768,
    attentionType: "gqa",
    weightSizeBf16Gb: 14,
  },

  // ── Phi-3 ───────────────────────────────────────────────────────────
  "phi-3-mini": {
    id: "phi-3-mini",
    displayName: "Phi-3 Mini (3.8B)",
    family: "phi",
    params: "3.8B",
    layers: 32,
    attentionHeads: 32,
    kvHeads: 32,
    headDim: 96,
    hiddenDim: 3072,
    ffnDim: 8192,
    maxContext: 131072,
    attentionType: "mha",
    weightSizeBf16Gb: 7.6,
  },

  // ── Gemma 2 ─────────────────────────────────────────────────────────
  "gemma-2-9b": {
    id: "gemma-2-9b",
    displayName: "Gemma 2 9B",
    family: "gemma",
    params: "9B",
    layers: 42,
    attentionHeads: 16,
    kvHeads: 8,
    headDim: 256,
    hiddenDim: 3584,
    ffnDim: 14336,
    maxContext: 8192,
    attentionType: "gqa",
    weightSizeBf16Gb: 18,
  },
  "gemma-2-27b": {
    id: "gemma-2-27b",
    displayName: "Gemma 2 27B",
    family: "gemma",
    params: "27B",
    layers: 46,
    attentionHeads: 32,
    kvHeads: 16,
    headDim: 128,
    hiddenDim: 4608,
    ffnDim: 36864,
    maxContext: 8192,
    attentionType: "gqa",
    weightSizeBf16Gb: 54,
  },
};

export const DEFAULT_GPU_SPECS: Record<string, GpuSpec> = {
  "h100-sxm": {
    id: "h100-sxm",
    name: "NVIDIA H100 SXM",
    hbmGb: 80,
    bandwidthTBs: 3.35,
    bf16Tflops: 989,
    nvlinkBwGBs: 900,
  },
  "a100-sxm": {
    id: "a100-sxm",
    name: "NVIDIA A100 SXM 80GB",
    hbmGb: 80,
    bandwidthTBs: 2.0,
    bf16Tflops: 312,
    nvlinkBwGBs: 600,
  },
  l40s: {
    id: "l40s",
    name: "NVIDIA L40S",
    hbmGb: 48,
    bandwidthTBs: 0.864,
    bf16Tflops: 366,
    nvlinkBwGBs: 0,
  },
  "rtx-4090": {
    id: "rtx-4090",
    name: "NVIDIA RTX 4090",
    hbmGb: 24,
    bandwidthTBs: 1.008,
    bf16Tflops: 330,
    nvlinkBwGBs: 0,
  },
  "rtx-a5000": {
    id: "rtx-a5000",
    name: "NVIDIA RTX A5000",
    hbmGb: 22.5,
    bandwidthTBs: 0.768,
    bf16Tflops: 65,
    nvlinkBwGBs: 0,
  },
};

/**
 * Look up a model architecture by ID. Uses exact match first, then
 * prefix match, then substring match — same strategy as `lookupPricing()`.
 */
export function lookupArchitecture(
  modelId: string,
  custom?: Record<string, ModelArchitecture>,
): ModelArchitecture | undefined {
  const merged = { ...DEFAULT_ARCHITECTURES, ...custom };
  const lower = modelId.toLowerCase();

  if (merged[lower]) return merged[lower];

  for (const key of Object.keys(merged)) {
    if (lower.startsWith(key) || lower.includes(key)) {
      return merged[key];
    }
  }
  return undefined;
}
