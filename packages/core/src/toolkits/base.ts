import type { ToolDef } from "../tools/types.js";

/**
 * Base class for all Agentium Toolkits.
 * A Toolkit is a collection of related tools that share configuration.
 */
export abstract class Toolkit {
  abstract readonly name: string;

  /**
   * Returns all tools provided by this toolkit as ToolDef[].
   * Spread them into an Agent's `tools` array.
   */
  abstract getTools(): ToolDef[];
}

export interface ToolkitConfigField {
  /** Machine-readable name matching the config interface property. */
  name: string;
  /** Human-readable label for the UI. */
  label: string;
  type: "string" | "number" | "boolean" | "select";
  /** Field is required to instantiate the toolkit. */
  required?: boolean;
  /** Field contains a secret (API key, token) — mask in responses. */
  secret?: boolean;
  /** Environment variable fallback name. */
  envVar?: string;
  default?: unknown;
  /** Options for "select" type. */
  options?: string[];
  /** Help text shown under the field. */
  hint?: string;
}

export interface ToolkitMeta {
  /** Unique identifier (e.g. "github", "slack"). */
  id: string;
  /** Display name (e.g. "GitHub", "Slack"). */
  name: string;
  description: string;
  category: "utility" | "search" | "api" | "enterprise" | "communication" | "iot";
  /** Whether the toolkit needs credentials / API keys to work. */
  requiresCredentials: boolean;
  configFields: ToolkitConfigField[];
  /** Create a live Toolkit instance from a config object. */
  factory: (config: Record<string, unknown>) => Toolkit;
}

/**
 * Collect all tools from one or more toolkit instances into a named
 * `Record<string, ToolDef>` — ready to pass as `toolLibrary` to the
 * admin package or for any tool-by-name lookup.
 *
 * @example
 * ```ts
 * const library = collectToolkitTools([
 *   new CalculatorToolkit(),
 *   new DuckDuckGoToolkit(),
 *   new GitHubToolkit({ token: "..." }),
 * ]);
 * // { calculate: ToolDef, duckduckgo_search: ToolDef, ... }
 * ```
 */
export function collectToolkitTools(toolkits: Toolkit[]): Record<string, ToolDef> {
  const library: Record<string, ToolDef> = {};
  for (const tk of toolkits) {
    for (const tool of tk.getTools()) {
      library[tool.name] = tool;
    }
  }
  return library;
}

/**
 * Describe a tool library as a serializable array of tool metadata
 * (name, description, parameter names). Useful for API responses
 * that list available tools for a UI.
 */
export function describeToolLibrary(
  library: Record<string, ToolDef>,
): Array<{ name: string; description: string; parameters: string[] }> {
  return Object.values(library).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: Object.keys(tool.parameters.shape ?? {}),
  }));
}
