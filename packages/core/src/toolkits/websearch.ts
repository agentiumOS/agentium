import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

export interface WebSearchConfig {
  /** Search provider: "tavily" or "serpapi". */
  provider: "tavily" | "serpapi";
  /** API key for the search provider. Falls back to TAVILY_API_KEY or SERPAPI_API_KEY env vars. */
  apiKey?: string;
  /** Max results to return per search (default 5). */
  maxResults?: number;
}

/**
 * Web Search Toolkit — search the web from your agent.
 *
 * Supports Tavily and SerpAPI backends.
 *
 * @example
 * ```ts
 * const search = new WebSearchToolkit({ provider: "tavily" });
 * const agent = new Agent({ tools: [...search.getTools()] });
 * ```
 */
export class WebSearchToolkit extends Toolkit {
  readonly name = "websearch";
  private config: WebSearchConfig;

  constructor(config: WebSearchConfig) {
    super();
    this.config = config;
  }

  private getApiKey(): string {
    if (this.config.apiKey) return this.config.apiKey;

    const envKey = this.config.provider === "tavily" ? process.env.TAVILY_API_KEY : process.env.SERPAPI_API_KEY;

    if (!envKey) {
      const envName = this.config.provider === "tavily" ? "TAVILY_API_KEY" : "SERPAPI_API_KEY";
      throw new Error(`WebSearchToolkit: No API key provided. Set ${envName} env var or pass apiKey in config.`);
    }
    return envKey;
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "web_search",
        description: "Search the web for current information. Returns titles, URLs, and snippets from search results.",
        parameters: z.object({
          query: z.string().describe("The search query"),
          maxResults: z.number().optional().describe("Maximum number of results (default 5)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const query = args.query as string;
          const max = (args.maxResults as number) ?? this.config.maxResults ?? 5;

          if (this.config.provider === "tavily") {
            return this.searchTavily(query, max);
          }
          return this.searchSerpApi(query, max);
        },
      },
    ];
  }

  private async searchTavily(query: string, maxResults: number): Promise<string> {
    const apiKey = this.getApiKey();
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: maxResults,
        include_answer: true,
      }),
    });

    if (!res.ok) {
      throw new Error(`Tavily search failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as any;
    const results: string[] = [];

    if (data.answer) {
      results.push(`Answer: ${data.answer}\n`);
    }

    for (const r of data.results ?? []) {
      results.push(`Title: ${r.title}\nURL: ${r.url}\nSnippet: ${r.content}\n`);
    }

    return results.join("\n---\n") || "No results found.";
  }

  private async searchSerpApi(query: string, maxResults: number): Promise<string> {
    const apiKey = this.getApiKey();
    const params = new URLSearchParams({
      q: query,
      api_key: apiKey,
      engine: "google",
      num: String(maxResults),
    });

    const res = await fetch(`https://serpapi.com/search.json?${params.toString()}`);

    if (!res.ok) {
      throw new Error(`SerpAPI search failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as any;
    const results: string[] = [];

    if (data.answer_box?.answer) {
      results.push(`Answer: ${data.answer_box.answer}\n`);
    }

    for (const r of (data.organic_results ?? []).slice(0, maxResults)) {
      results.push(`Title: ${r.title}\nURL: ${r.link}\nSnippet: ${r.snippet ?? ""}\n`);
    }

    return results.join("\n---\n") || "No results found.";
  }
}
