import type { ModelProvider } from "../models/provider.js";
import type { StorageDriver } from "../storage/driver.js";
import type { ToolDef } from "../tools/types.js";

export interface SerializedAgent {
  name: string;
  modelId: string;
  providerId: string;
  instructions?: string;
  toolNames: string[];
  temperature?: number;
  maxTokens?: number;
  maxToolRoundtrips?: number;
  sessionId?: string;
  userId?: string;
  logLevel?: string;
  reasoning?: { enabled?: boolean; budgetTokens?: number };
  metadata?: Record<string, unknown>;
}

export interface DeserializeRegistry {
  models: Record<string, ModelProvider>;
  tools?: Record<string, ToolDef>;
  storage?: StorageDriver;
}

export function serializeAgentConfig(config: any): SerializedAgent {
  return {
    name: config.name,
    modelId: config.model?.modelId ?? "",
    providerId: config.model?.providerId ?? "",
    instructions: typeof config.instructions === "string" ? config.instructions : undefined,
    toolNames: (config.tools ?? []).map((t: any) => t.name),
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    maxToolRoundtrips: config.maxToolRoundtrips,
    sessionId: config.sessionId,
    userId: config.userId,
    logLevel: config.logLevel,
    reasoning: config.reasoning,
  };
}

export function buildAgentConfigFromSerialized(data: SerializedAgent, registry: DeserializeRegistry) {
  const modelKey = `${data.providerId}:${data.modelId}`;
  const model = registry.models[modelKey] ?? registry.models[data.modelId];
  if (!model) {
    throw new Error(`Model "${modelKey}" not found in registry. Available: ${Object.keys(registry.models).join(", ")}`);
  }

  const tools = data.toolNames.map((name) => registry.tools?.[name]).filter((t): t is ToolDef => t != null);

  return {
    name: data.name,
    model,
    instructions: data.instructions,
    tools: tools.length > 0 ? tools : undefined,
    temperature: data.temperature,
    maxTokens: data.maxTokens,
    maxToolRoundtrips: data.maxToolRoundtrips,
    sessionId: data.sessionId,
    userId: data.userId,
    logLevel: data.logLevel as any,
    reasoning: data.reasoning ? { ...data.reasoning, enabled: data.reasoning.enabled ?? false } : undefined,
    register: false,
  };
}
