import type { Logger } from "../logger/logger.js";
import type { ModelProvider } from "../models/provider.js";
import { countTokens } from "../utils/token-counter.js";
import type { ToolDef } from "./types.js";

export interface ToolRouterConfig {
  /** Cheap/fast model used to select relevant tools. */
  model: ModelProvider;
  /** Maximum tools to select per query. Default: 8 */
  maxTools?: number;
  /** Minimum tools to always return (in case selection fails). Default: 0 (fallback sends all) */
  minTools?: number;
  /** Temperature for the selection model. Default: 0 */
  temperature?: number;
  /** Optional logger for diagnostic output. When omitted, the router is silent. */
  logger?: Logger;
}

/**
 * Pre-selects a subset of relevant tools for a given user query using a
 * cheap model. This dramatically reduces prompt tokens when agents have
 * many tools (e.g. 50+ MCP tools) by only sending relevant tool schemas.
 *
 * If the selection fails for any reason, all tools are returned as a fallback.
 */
export class ToolRouter {
  private config: ToolRouterConfig;
  private maxTools: number;
  private logger?: Logger;

  constructor(config: ToolRouterConfig) {
    this.config = config;
    this.maxTools = config.maxTools ?? 8;
    this.logger = config.logger;
  }

  async select(query: string, tools: ToolDef[]): Promise<ToolDef[]> {
    this.logger?.debug(`[ToolRouter] ${tools.length} total tools, maxTools=${this.maxTools}`);
    if (tools.length <= this.maxTools) {
      this.logger?.debug(`[ToolRouter] Skipping selection — tool count within limit`);
      return tools;
    }

    const toolIndex = tools.map((t) => `${t.name} — ${(t.description ?? "").slice(0, 100)}`).join("\n");
    this.logger?.debug(
      `[ToolRouter] Tool index size: ${toolIndex.length} chars (~${countTokens(toolIndex)} tokens)`,
    );

    try {
      const response = await this.config.model.generate(
        [
          {
            role: "system",
            content: `You are a tool selector. Given a user query, pick the most relevant tools from the list below.
Return ONLY a JSON array of tool name strings. Pick at most ${this.maxTools} tools. No explanation, no markdown fences.`,
          },
          {
            role: "user",
            content: `Tools:\n${toolIndex}\n\nQuery: "${query}"`,
          },
        ],
        { temperature: this.config.temperature ?? 0, maxTokens: 400 },
      );

      const text = typeof response.message.content === "string" ? response.message.content : "";
      this.logger?.debug(`[ToolRouter] Model response: ${text.slice(0, 500)}`);
      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        const names: string[] = JSON.parse(match[0]);
        const toolMap = new Map(tools.map((t) => [t.name, t]));
        const selected = names.map((n) => toolMap.get(n)).filter(Boolean) as ToolDef[];
        this.logger?.debug(
          `[ToolRouter] Selected ${selected.length} tools: ${selected.map((t) => t.name).join(", ")}`,
        );
        if (selected.length >= (this.config.minTools ?? 0)) {
          return selected;
        }
        this.logger?.warn(
          `[ToolRouter] Selected ${selected.length} < minTools ${this.config.minTools ?? 0}, falling back to ALL tools`,
        );
      } else {
        this.logger?.warn(`[ToolRouter] No JSON array found in response, falling back to ALL tools`);
      }
    } catch (e) {
      this.logger?.warn(`[ToolRouter] Selection FAILED, sending ALL tools: ${(e as Error)?.message ?? e}`);
    }

    this.logger?.warn(`[ToolRouter] FALLBACK: sending all ${tools.length} tools to main model`);
    return tools;
  }
}
