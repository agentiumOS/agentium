import type { CommunicationCapabilities } from "./public-messages.js";
import type { ChatMessage, ModelConfig, ModelResponse, StreamChunk, ToolDefinition } from "./types.js";

export interface ModelProvider {
  readonly providerId: string;
  readonly communicationCapabilities?: CommunicationCapabilities;
  readonly modelId: string;
  /** Composite adapters delegate metering to their leaf providers. */
  readonly accountingRole?: "leaf" | "composite";
  /** Physical requires documented retry control or transport instrumentation. */
  readonly attemptVisibility?: "physical" | "opaque";

  generate(messages: ChatMessage[], options?: ModelConfig & { tools?: ToolDefinition[] }): Promise<ModelResponse>;

  stream(messages: ChatMessage[], options?: ModelConfig & { tools?: ToolDefinition[] }): AsyncGenerator<StreamChunk>;
}
