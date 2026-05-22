import type { ModelProvider } from "../provider.js";
import { type OpenAICompatibleConfig, OpenAICompatibleProvider } from "./openai-compatible.js";

export type XAIConfig = OpenAICompatibleConfig;

export class XAIProvider extends OpenAICompatibleProvider implements ModelProvider {
  constructor(modelId: string, config?: XAIConfig) {
    super("xai", modelId, { baseURL: "https://api.x.ai/v1", apiKeyEnvVar: "XAI_API_KEY" }, config);
  }
}
