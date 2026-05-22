import { spawn } from "node:child_process";

export interface OllamaStatus {
  running: boolean;
  version?: string;
  models?: string[];
  error?: string;
}

export interface ModelRecommendation {
  model: string;
  label: string;
  parameterSize: string;
  ramRequired: number;
}

const MODEL_TIERS: ModelRecommendation[] = [
  { model: "tinyllama:1.1b", label: "fast", parameterSize: "1.1B", ramRequired: 1000 },
  { model: "llama3.2:1b", label: "balanced", parameterSize: "1B", ramRequired: 2000 },
  { model: "phi3:mini", label: "capable", parameterSize: "3.8B", ramRequired: 4000 },
  { model: "llama3.2:3b", label: "advanced", parameterSize: "3B", ramRequired: 4500 },
  { model: "mistral:7b", label: "powerful", parameterSize: "7B", ramRequired: 8000 },
];

/**
 * Check whether Ollama is running and accessible.
 */
export async function checkOllama(baseUrl = "http://localhost:11434"): Promise<OllamaStatus> {
  try {
    const resp = await fetch(`${baseUrl}/api/version`);
    if (!resp.ok) return { running: false, error: `HTTP ${resp.status}` };
    const data = (await resp.json()) as { version?: string };

    const modelsResp = await fetch(`${baseUrl}/api/tags`);
    let models: string[] = [];
    if (modelsResp.ok) {
      const modelsData = (await modelsResp.json()) as { models?: Array<{ name: string }> };
      models = (modelsData.models ?? []).map((m) => m.name);
    }

    return { running: true, version: data.version, models };
  } catch {
    return { running: false };
  }
}

/**
 * Ensure Ollama is running. If not, attempt to start the `ollama serve` process.
 * Returns the status after attempting to start.
 */
export async function ensureOllama(baseUrl = "http://localhost:11434"): Promise<OllamaStatus> {
  const status = await checkOllama(baseUrl);
  if (status.running) return status;

  try {
    const child = spawn("ollama", ["serve"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    // Wait up to 10s for Ollama to become available
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const s = await checkOllama(baseUrl);
      if (s.running) return s;
    }

    return { running: false, error: "Started ollama serve but it did not become available within 10s" };
  } catch (err: any) {
    return { running: false, error: `Failed to start Ollama: ${err.message}. Is it installed?` };
  }
}

/**
 * Pull a model if it's not already cached locally.
 * Uses the Ollama HTTP API's /api/pull endpoint.
 */
export async function pullModel(
  model: string,
  opts: { baseUrl?: string; onProgress?: (status: string) => void } = {},
): Promise<{ success: boolean; model: string; error?: string }> {
  const baseUrl = opts.baseUrl ?? "http://localhost:11434";

  try {
    const resp = await fetch(`${baseUrl}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model, stream: false }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { success: false, model, error: `HTTP ${resp.status}: ${text}` };
    }

    const data = (await resp.json()) as { status?: string; error?: string };
    if (data.error) {
      return { success: false, model, error: data.error };
    }

    return { success: true, model };
  } catch (err: any) {
    return { success: false, model, error: err.message };
  }
}

/**
 * Recommend the best model for the available RAM.
 *
 * @param ramMb - Available RAM in megabytes.
 * @returns The best model that fits, or the smallest if none fit comfortably.
 */
export function recommendModel(ramMb: number): ModelRecommendation {
  // Pick the largest model that fits with 30% RAM headroom for the OS and Node.js
  const budget = ramMb * 0.7;
  let best = MODEL_TIERS[0];
  for (const tier of MODEL_TIERS) {
    if (tier.ramRequired <= budget) {
      best = tier;
    }
  }
  return best;
}

/** List all known model tiers with their RAM requirements. */
export function listModelTiers(): ModelRecommendation[] {
  return [...MODEL_TIERS];
}

/**
 * Check if a specific model is cached locally.
 */
export async function hasModel(model: string, baseUrl = "http://localhost:11434"): Promise<boolean> {
  try {
    const resp = await fetch(`${baseUrl}/api/tags`);
    if (!resp.ok) return false;
    const data = (await resp.json()) as { models?: Array<{ name: string }> };
    return (data.models ?? []).some((m) => m.name === model || m.name.startsWith(`${model}:`));
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
