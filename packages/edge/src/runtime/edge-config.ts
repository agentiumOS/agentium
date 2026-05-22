export interface EdgePreset {
  /** Preset identifier. */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Recommended Ollama model for this device class. */
  recommendedModel: string;
  /** Max tokens to generate per request. */
  maxTokens: number;
  /** Max context window (tokens) — limits conversation history. */
  contextWindow: number;
  /** Memory budget for the Node.js process in MB. */
  memoryLimitMb: number;
  /** Watchdog timeout in ms — restart agent if unresponsive longer than this. */
  watchdogTimeoutMs: number;
  /** Resource monitor polling interval in ms. */
  monitorIntervalMs: number;
  /** CPU temperature threshold (°C) — start throttling above this. */
  thermalThrottleC: number;
  /** Memory usage threshold (0-1) — start shedding tools above this. */
  memoryThreshold: number;
  /** Disable heavyweight features on edge by default. */
  disableFeatures: string[];
}

const BASE_DISABLED = ["swagger", "fileUpload", "voiceAgent"];

const PRESETS: Record<string, EdgePreset> = {
  "pi4-2gb": {
    id: "pi4-2gb",
    label: "Raspberry Pi 4 (2 GB)",
    recommendedModel: "tinyllama:1.1b",
    maxTokens: 256,
    contextWindow: 2048,
    memoryLimitMb: 512,
    watchdogTimeoutMs: 30_000,
    monitorIntervalMs: 10_000,
    thermalThrottleC: 75,
    memoryThreshold: 0.85,
    disableFeatures: [...BASE_DISABLED, "knowledgeBase", "semanticCache"],
  },
  "pi4-4gb": {
    id: "pi4-4gb",
    label: "Raspberry Pi 4 (4 GB)",
    recommendedModel: "tinyllama:1.1b",
    maxTokens: 512,
    contextWindow: 4096,
    memoryLimitMb: 1024,
    watchdogTimeoutMs: 30_000,
    monitorIntervalMs: 10_000,
    thermalThrottleC: 75,
    memoryThreshold: 0.85,
    disableFeatures: [...BASE_DISABLED],
  },
  "pi4-8gb": {
    id: "pi4-8gb",
    label: "Raspberry Pi 4 (8 GB)",
    recommendedModel: "llama3.2:1b",
    maxTokens: 1024,
    contextWindow: 8192,
    memoryLimitMb: 2048,
    watchdogTimeoutMs: 30_000,
    monitorIntervalMs: 10_000,
    thermalThrottleC: 75,
    memoryThreshold: 0.8,
    disableFeatures: [...BASE_DISABLED],
  },
  "pi5-4gb": {
    id: "pi5-4gb",
    label: "Raspberry Pi 5 (4 GB)",
    recommendedModel: "llama3.2:1b",
    maxTokens: 1024,
    contextWindow: 8192,
    memoryLimitMb: 1536,
    watchdogTimeoutMs: 20_000,
    monitorIntervalMs: 10_000,
    thermalThrottleC: 80,
    memoryThreshold: 0.8,
    disableFeatures: [...BASE_DISABLED],
  },
  "pi5-8gb": {
    id: "pi5-8gb",
    label: "Raspberry Pi 5 (8 GB)",
    recommendedModel: "phi3:mini",
    maxTokens: 2048,
    contextWindow: 16384,
    memoryLimitMb: 3072,
    watchdogTimeoutMs: 20_000,
    monitorIntervalMs: 10_000,
    thermalThrottleC: 80,
    memoryThreshold: 0.8,
    disableFeatures: [...BASE_DISABLED],
  },
};

/**
 * Get an edge configuration preset by device identifier.
 *
 * @example
 * ```ts
 * const config = edgePreset("pi5-8gb");
 * console.log(config.recommendedModel); // "phi3:mini"
 * ```
 */
export function edgePreset(id: string): EdgePreset {
  const preset = PRESETS[id];
  if (!preset) {
    const available = Object.keys(PRESETS).join(", ");
    throw new Error(`Unknown edge preset "${id}". Available: ${available}`);
  }
  return { ...preset };
}

/** List all available preset IDs and labels. */
export function listEdgePresets(): Array<{ id: string; label: string }> {
  return Object.values(PRESETS).map((p) => ({ id: p.id, label: p.label }));
}

/** Create a custom preset by overriding fields of an existing one. */
export function customEdgePreset(base: string, overrides: Partial<EdgePreset>): EdgePreset {
  const preset = edgePreset(base);
  return { ...preset, ...overrides, id: overrides.id ?? `${base}-custom` };
}
