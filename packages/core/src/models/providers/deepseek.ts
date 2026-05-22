import type { ModelProvider } from "../provider.js";
import { type OpenAICompatibleConfig, OpenAICompatibleProvider } from "./openai-compatible.js";

export type DeepSeekConfig = OpenAICompatibleConfig;

export class DeepSeekProvider extends OpenAICompatibleProvider implements ModelProvider {
  constructor(modelId: string, config?: DeepSeekConfig) {
    super("deepseek", modelId, { baseURL: "https://api.deepseek.com", apiKeyEnvVar: "DEEPSEEK_API_KEY" }, config);
  }
}
