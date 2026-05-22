import type { ModelProvider } from "../provider.js";
import { type OpenAICompatibleConfig, OpenAICompatibleProvider } from "./openai-compatible.js";

export type MetaLlamaConfig = OpenAICompatibleConfig;

export class MetaLlamaProvider extends OpenAICompatibleProvider implements ModelProvider {
  constructor(modelId: string, config?: MetaLlamaConfig) {
    super("meta", modelId, { baseURL: "https://api.llama-api.com", apiKeyEnvVar: "LLAMA_API_KEY" }, config);
  }
}
