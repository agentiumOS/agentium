import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

export interface WikipediaConfig {
  /** Wikipedia language code (default "en"). */
  language?: string;
  /** Max search results per query (default 5). */
  maxResults?: number;
}

/**
 * Wikipedia Toolkit — search articles and get summaries from Wikipedia.
 *
 * Uses the free MediaWiki REST API. No API key required.
 *
 * @example
 * ```ts
 * const wiki = new WikipediaToolkit({ language: "en" });
 * const agent = new Agent({ tools: [...wiki.getTools()] });
 * ```
 */
export class WikipediaToolkit extends Toolkit {
  readonly name = "wikipedia";
  private lang: string;
  private maxResults: number;

  constructor(config: WikipediaConfig = {}) {
    super();
    this.lang = config.language ?? "en";
    this.maxResults = config.maxResults ?? 5;
  }

  private get baseUrl(): string {
    return `https://${this.lang}.wikipedia.org`;
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "wikipedia_search",
        description: "Search Wikipedia for articles matching a query. Returns titles, descriptions, and URLs.",
        parameters: z.object({
          query: z.string().describe("The search query"),
          maxResults: z.number().optional().describe("Maximum results to return (default 5)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const query = args.query as string;
          const max = (args.maxResults as number) ?? this.maxResults;

          const params = new URLSearchParams({
            action: "query",
            list: "search",
            srsearch: query,
            srlimit: String(max),
            format: "json",
            origin: "*",
          });

          const res = await fetch(`${this.baseUrl}/w/api.php?${params.toString()}`);
          if (!res.ok) throw new Error(`Wikipedia search failed: ${res.status}`);

          const data = (await res.json()) as any;
          const results = data.query?.search ?? [];

          if (results.length === 0) return "No Wikipedia articles found.";

          return results
            .map((r: any, i: number) => {
              const snippet = r.snippet.replace(/<[^>]*>/g, "").trim();
              return `${i + 1}. ${r.title}\n   URL: ${this.baseUrl}/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}\n   ${snippet}`;
            })
            .join("\n\n");
        },
      },
      {
        name: "wikipedia_summary",
        description: "Get a summary of a Wikipedia article by title. Returns the extract text and article URL.",
        parameters: z.object({
          title: z.string().describe("The exact Wikipedia article title"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const title = args.title as string;

          const res = await fetch(`${this.baseUrl}/api/rest_v1/page/summary/${encodeURIComponent(title)}`, {
            headers: { "User-Agent": "Agentium/1.0" },
          });

          if (res.status === 404) return `Article "${title}" not found on Wikipedia.`;
          if (!res.ok) throw new Error(`Wikipedia API failed: ${res.status}`);

          const data = (await res.json()) as any;

          return [
            `Title: ${data.title}`,
            `URL: ${data.content_urls?.desktop?.page ?? ""}`,
            `Description: ${data.description ?? ""}`,
            "",
            data.extract ?? "(no extract available)",
          ].join("\n");
        },
      },
    ];
  }
}
