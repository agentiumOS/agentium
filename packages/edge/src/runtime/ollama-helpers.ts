import { execFileSync, spawn } from "node:child_process";
import * as os from "node:os";

export interface OllamaStatus {
  running: boolean;
  version?: string;
  models?: string[];
}

export interface ModelRecommendation {
  model: string;
  displayName: string;
  parameterSize: string;
  minRamMb: number;
  tier: "fast" | "balanced" | "capable";
}

const MODEL_TIERS: ModelRecommendation[] = [
  {
    model: "tinyllama",
    displayName: "TinyLlama 1.1B",
    parameterSize: "1.1B",
    minRamMb: 1024,
    tier: "fast",
  },
  {
    model: "llama3.2:1b",
    displayName: "Llama 3.2 1B",
    parameterSize: "1B",
    minRamMb: 2048,
    tier: "balanced",
  },
  {
    model: "phi3:mini",
    displayName: "Phi-3 Mini 3.8B",
    parameterSize: "3.8B",
    minRamMb: 4096,
    tier: "capable",
  },
];

/**
 * Check if Ollama is running and return status info.
 */
export async function checkOllama(): Promise<OllamaStatus> {
  try {
    const resp = await fetch("http://localhost:11434/api/version");
    if (!resp.ok) return { running: false };
    const data = (await resp.json()) as { version?: string };
    let models: string[] = [];
    try {
      const modelsResp = await fetch("http://localhost:11434/api/tags");
      if (modelsResp.ok) {
        const modelsData = (await modelsResp.json()) as { models?: Array<{ name: string }> };
        models = modelsData.models?.map((m) => m.name) ?? [];
      }
    } catch {}
    return { running: true, version: data.version, models };
  } catch {
    return { running: false };
  }
}

/**
 * Ensure Ollama is running. If not, attempt to start it.
 * @returns Status after attempting to start.
 */
export async function ensureOllama(): Promise<OllamaStatus> {
  let status = await checkOllama();
  if (status.running) return status;

  try {
    const child = spawn("ollama", ["serve"], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();

    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      status = await checkOllama();
      if (status.running) return status;
    }
  } catch {}

  return { running: false };
}

/**
 * Pull a model if it's not already cached locally.
 * @param modelName - Ollama model name (e.g. "tinyllama", "phi3:mini")
 * @returns true if the model is now available.
 */
export async function pullModel(modelName: string): Promise<boolean> {
  try {
    const status = await checkOllama();
    if (!status.running) {
      throw new Error("Ollama is not running. Call ensureOllama() first.");
    }

    if (status.models?.includes(modelName)) return true;

    execFileSync("ollama", ["pull", modelName], {
      stdio: "pipe",
      timeout: 600000,
    });

    const after = await checkOllama();
    return after.models?.includes(modelName) ?? false;
  } catch {
    return false;
  }
}

/**
 * Recommend the best model for the available RAM.
 * @param availableRamMb - Available RAM in MB. If omitted, uses system free memory.
 */
export function recommendModel(availableRamMb?: number): ModelRecommendation {
  const ram = availableRamMb ?? Math.round(os.freemem() / 1024 / 1024);

  for (let i = MODEL_TIERS.length - 1; i >= 0; i--) {
    if (ram >= MODEL_TIERS[i].minRamMb) {
      return MODEL_TIERS[i];
    }
  }

  return MODEL_TIERS[0];
}

/**
 * Recommend model by tier name: "fast", "balanced", or "capable".
 */
export function getModelByTier(tier: "fast" | "balanced" | "capable"): ModelRecommendation {
  const model = MODEL_TIERS.find((m) => m.tier === tier);
  return model ?? MODEL_TIERS[0];
}

/**
 * List all known model tiers with their requirements.
 */
export function listModelTiers(): ModelRecommendation[] {
  return [...MODEL_TIERS];
}
