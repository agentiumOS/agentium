import type { ModelProvider } from "../provider.js";
import { type OpenAICompatibleConfig, OpenAICompatibleProvider } from "./openai-compatible.js";

export type VercelConfig = OpenAICompatibleConfig;

export class VercelProvider extends OpenAICompatibleProvider implements ModelProvider {
  constructor(modelId: string, config?: VercelConfig) {
    super("vercel", modelId, { baseURL: "https://api.v0.dev/v1", apiKeyEnvVar: "V0_API_KEY" }, config);
  }
}
