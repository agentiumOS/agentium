import type { ChatMessage, ModelConfig, ModelResponse, StreamChunk, ToolDefinition } from "./types.js";

export interface ModelProvider {
  readonly providerId: string;
  readonly modelId: string;

  generate(messages: ChatMessage[], options?: ModelConfig & { tools?: ToolDefinition[] }): Promise<ModelResponse>;

  stream(messages: ChatMessage[], options?: ModelConfig & { tools?: ToolDefinition[] }): AsyncGenerator<StreamChunk>;
}
