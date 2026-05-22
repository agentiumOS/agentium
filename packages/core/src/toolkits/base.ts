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
