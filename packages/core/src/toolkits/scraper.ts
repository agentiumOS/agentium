import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef } from "../tools/types.js";
import { assertHostAllowed } from "../utils/path-safety.js";
import { Toolkit } from "./base.js";

export interface ScraperConfig {
  /** Max characters of extracted text to return (default 15000). */
  maxLength?: number;
  /** Custom User-Agent header. */
  userAgent?: string;
  /** Request timeout in milliseconds (default 15000). */
  timeout?: number;
  /**
   * SSRF protection: when set, only URLs whose hostname matches one of these
   * entries (exact or sub-domain suffix) will be fetched. Otherwise all hosts
   * are allowed.
   */
  allowedHosts?: string[];
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLinks(html: string, baseUrl: string): Array<{ text: string; href: string }> {
  const links: Array<{ text: string; href: string }> = [];
  const linkRegex = /<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(html)) !== null) {
    let href = match[1];
    const text = match[2].replace(/<[^>]*>/g, "").trim();

    if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;

    try {
      href = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }

    if (text) links.push({ text, href });
  }

  return links;
}

/**
 * Web Scraper Toolkit — extract text content and links from web pages.
 *
 * Uses native `fetch` and lightweight HTML stripping. No browser or heavy dependencies.
 *
 * @example
 * ```ts
 * const scraper = new ScraperToolkit({ maxLength: 5000 });
 * const agent = new Agent({ tools: [...scraper.getTools()] });
 * ```
 */
export class ScraperToolkit extends Toolkit {
  readonly name = "scraper";
  private config: ScraperConfig;

  constructor(config: ScraperConfig = {}) {
    super();
    this.config = config;
  }

  private async fetchPage(url: string): Promise<string> {
    assertHostAllowed(url, this.config.allowedHosts);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeout ?? 15_000);

    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": this.config.userAgent ?? "Mozilla/5.0 (compatible; Agentium/1.0)",
          Accept: "text/html,application/xhtml+xml",
        },
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "scrape_url",
        description:
          "Fetch a web page and extract its text content (scripts, styles, and navigation stripped). Good for reading articles, documentation, etc.",
        parameters: z.object({
          url: z.string().describe("The URL to scrape"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const url = args.url as string;
          const html = await this.fetchPage(url);
          let text = stripHtml(html);
          const maxLen = this.config.maxLength ?? 15_000;

          if (text.length > maxLen) {
            text = `${text.slice(0, maxLen)}\n...(truncated, ${text.length} total chars)`;
          }

          return `URL: ${url}\n\n${text || "(no text content extracted)"}`;
        },
      },
      {
        name: "scrape_links",
        description: "Extract all links from a web page. Returns link text and URLs.",
        parameters: z.object({
          url: z.string().describe("The URL to extract links from"),
          maxLinks: z.number().optional().describe("Maximum links to return (default 50)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const url = args.url as string;
          const maxLinks = (args.maxLinks as number) ?? 50;
          const html = await this.fetchPage(url);
          const links = extractLinks(html, url).slice(0, maxLinks);

          if (links.length === 0) return "No links found.";

          return links.map((l, i) => `${i + 1}. ${l.text}\n   ${l.href}`).join("\n\n");
        },
      },
    ];
  }
}
