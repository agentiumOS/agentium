import type { StorageDriver, ToolDef, Toolkit } from "@agentium/core";

/**
 * Serializable agent configuration — no class instances or functions.
 * Persisted to storage and resolved into a live Agent via EntityFactory.
 */
export interface AgentBlueprint {
  name: string;
  /** Model provider id, e.g. "openai", "anthropic", "google", "ollama" */
  provider: string;
  /** Model id, e.g. "gpt-4o", "claude-sonnet-4-20250514" */
  model: string;
  instructions?: string;
  /** Human-readable description of the agent's purpose. */
  description?: string;
  /** Detected capabilities (e.g. "tools", "streaming", "memory", "cost_tracking"). */
  capabilities?: string[];
  /** Tool names resolved from the toolLibrary at creation time. */
  tools?: string[];
  temperature?: number;
  /** Provider-specific config (apiKey, baseURL, etc.) — passed to modelRegistry.resolve(). */
  providerConfig?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Serializable team configuration.
 * Members are agent names resolved from the registry at creation time.
 */
export interface TeamBlueprint {
  name: string;
  /** One of: "coordinate", "route", "broadcast", "collaborate", "handoff" */
  mode: string;
  provider: string;
  model: string;
  /** Agent names — must already exist in the registry. */
  members: string[];
  instructions?: string;
  providerConfig?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Serializable workflow configuration.
 * Workflows with typed state and function steps cannot be fully serialized,
 * so this is a lightweight placeholder for name-based registration.
 */
export interface WorkflowBlueprint {
  name: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface AdminOptions {
  /** Storage driver for persisting blueprints across restarts. */
  storage: StorageDriver;
  /** Named tools available for agent creation. Users reference tools by key. */
  toolLibrary?: Record<string, ToolDef>;
  /**
   * Toolkit instances whose tools are automatically added to the tool library.
   * Tools from toolkits are merged with `toolLibrary` (explicit entries take precedence).
   */
  toolkits?: Toolkit[];
  /** Express middleware applied to all admin routes (e.g., auth). */
  middleware?: any[];
}
