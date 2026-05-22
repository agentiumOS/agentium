import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

export interface DuckDuckGoConfig {
  /** Enable web search (default true). */
  enableSearch?: boolean;
  /** Enable news search (default true). */
  enableNews?: boolean;
  /** Fixed max results per query (default 5). */
  maxResults?: number;
}

/**
 * DuckDuckGo Toolkit — search the web and news without any API key.
 *
 * Uses the DuckDuckGo HTML API (no key required).
 *
 * @example
 * ```ts
 * const ddg = new DuckDuckGoToolkit();
 * const agent = new Agent({ tools: [...ddg.getTools()] });
 * ```
 */
export class DuckDuckGoToolkit extends Toolkit {
  readonly name = "duckduckgo";
  private config: DuckDuckGoConfig;

  constructor(config: DuckDuckGoConfig = {}) {
    super();
    this.config = {
      enableSearch: config.enableSearch ?? true,
      enableNews: config.enableNews ?? true,
      maxResults: config.maxResults ?? 5,
    };
  }

  getTools(): ToolDef[] {
    const tools: ToolDef[] = [];

    if (this.config.enableSearch) {
      tools.push(this.buildSearchTool());
    }

    if (this.config.enableNews) {
      tools.push(this.buildNewsTool());
    }

    return tools;
  }

  private buildSearchTool(): ToolDef {
    const self = this;
    return {
      name: "duckduckgo_search",
      description: "Search the web using DuckDuckGo. Returns titles, URLs, and snippets. No API key required.",
      parameters: z.object({
        query: z.string().describe("The search query"),
        maxResults: z.number().optional().describe("Maximum number of results (default 5)"),
      }),
      async execute(args: Record<string, unknown>, _ctx: RunContext): Promise<string> {
        const query = args.query as string;
        const max = (args.maxResults as number) ?? self.config.maxResults ?? 5;
        return self.search(query, max);
      },
    };
  }

  private buildNewsTool(): ToolDef {
    const self = this;
    return {
      name: "duckduckgo_news",
      description: "Get the latest news from DuckDuckGo. Returns headlines, sources, URLs, and dates.",
      parameters: z.object({
        query: z.string().describe("The news search query"),
        maxResults: z.number().optional().describe("Maximum number of results (default 5)"),
      }),
      async execute(args: Record<string, unknown>, _ctx: RunContext): Promise<string> {
        const query = args.query as string;
        const max = (args.maxResults as number) ?? self.config.maxResults ?? 5;
        return self.searchNews(query, max);
      },
    };
  }

  private async search(query: string, maxResults: number): Promise<string> {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;

    const res = await fetch(url, {
      headers: { "User-Agent": "Agentium/1.0" },
    });

    if (!res.ok) {
      throw new Error(`DuckDuckGo search failed: ${res.status}`);
    }

    const data = (await res.json()) as any;
    const results: string[] = [];

    if (data.Abstract) {
      results.push(`Answer: ${data.Abstract}\nSource: ${data.AbstractSource}\nURL: ${data.AbstractURL}`);
    }

    const topics = data.RelatedTopics ?? [];
    for (const topic of topics.slice(0, maxResults)) {
      if (topic.Text && topic.FirstURL) {
        results.push(`${topic.Text}\nURL: ${topic.FirstURL}`);
      }
      if (topic.Topics) {
        for (const sub of topic.Topics.slice(0, 2)) {
          if (sub.Text && sub.FirstURL) {
            results.push(`${sub.Text}\nURL: ${sub.FirstURL}`);
          }
        }
      }
    }

    if (results.length === 0 && data.Redirect) {
      return `Redirect: ${data.Redirect}`;
    }

    if (results.length === 0) {
      const htmlResults = await this.scrapeHtmlSearch(query, maxResults);
      if (htmlResults) return htmlResults;
      return "No results found.";
    }

    return results.join("\n\n---\n\n");
  }

  private async scrapeHtmlSearch(query: string, maxResults: number): Promise<string | null> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Agentium/1.0; +https://agentium.dev)",
      },
    });

    if (!res.ok) return null;

    const html = await res.text();

    const results: string[] = [];
    const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

    const links: { url: string; title: string }[] = [];
    let match;
    while ((match = linkRegex.exec(html)) !== null) {
      const rawUrl = match[1];
      const title = match[2].replace(/<[^>]*>/g, "").trim();
      const decoded = this.decodeDdgUrl(rawUrl);
      if (title && decoded) {
        links.push({ url: decoded, title });
      }
    }

    const snippets: string[] = [];
    while ((match = snippetRegex.exec(html)) !== null) {
      snippets.push(match[1].replace(/<[^>]*>/g, "").trim());
    }

    for (let i = 0; i < Math.min(links.length, maxResults); i++) {
      results.push(`Title: ${links[i].title}\nURL: ${links[i].url}\nSnippet: ${snippets[i] ?? ""}`);
    }

    return results.length > 0 ? results.join("\n\n---\n\n") : null;
  }

  private decodeDdgUrl(url: string): string | null {
    if (url.startsWith("//duckduckgo.com/l/?uddg=")) {
      const match = url.match(/uddg=([^&]*)/);
      if (match) return decodeURIComponent(match[1]);
    }
    if (url.startsWith("http")) return url;
    return null;
  }

  private async searchNews(query: string, maxResults: number): Promise<string> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${query} news`)}&iar=news`;

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Agentium/1.0; +https://agentium.dev)",
      },
    });

    if (!res.ok) {
      throw new Error(`DuckDuckGo news search failed: ${res.status}`);
    }

    const html = await res.text();
    const results: string[] = [];

    const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

    const links: { url: string; title: string }[] = [];
    let match;
    while ((match = linkRegex.exec(html)) !== null) {
      const rawUrl = match[1];
      const title = match[2].replace(/<[^>]*>/g, "").trim();
      const decoded = this.decodeDdgUrl(rawUrl);
      if (title && decoded) {
        links.push({ url: decoded, title });
      }
    }

    const snippets: string[] = [];
    while ((match = snippetRegex.exec(html)) !== null) {
      snippets.push(match[1].replace(/<[^>]*>/g, "").trim());
    }

    for (let i = 0; i < Math.min(links.length, maxResults); i++) {
      results.push(`Title: ${links[i].title}\nURL: ${links[i].url}\nSnippet: ${snippets[i] ?? ""}`);
    }

    return results.length > 0 ? results.join("\n\n---\n\n") : "No news results found.";
  }
}
