import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

export interface NotionConfig {
  /** Notion integration token. Falls back to NOTION_API_KEY env var. */
  token?: string;
}

function extractPlainText(blocks: any[]): string {
  return blocks
    .map((block: any) => {
      const type = block.type;
      const content = block[type];
      if (!content?.rich_text) return "";
      return content.rich_text.map((t: any) => t.plain_text ?? "").join("");
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Notion Toolkit — search, read, and create pages in Notion.
 *
 * Requires a Notion internal integration token.
 *
 * @example
 * ```ts
 * const notion = new NotionToolkit({ token: "ntn_..." });
 * const agent = new Agent({ tools: [...notion.getTools()] });
 * ```
 */
export class NotionToolkit extends Toolkit {
  readonly name = "notion";
  private tokenValue: string | undefined;

  constructor(config: NotionConfig = {}) {
    super();
    this.tokenValue = config.token;
  }

  private getToken(): string {
    const token = this.tokenValue ?? process.env.NOTION_API_KEY;
    if (!token) throw new Error("NotionToolkit: token required. Set NOTION_API_KEY env var or pass token in config.");
    return token;
  }

  private async api(path: string, options: RequestInit = {}): Promise<any> {
    const res = await fetch(`https://api.notion.com/v1${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.getToken()}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
        ...((options.headers as Record<string, string>) ?? {}),
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Notion API ${res.status}: ${body.slice(0, 300)}`);
    }

    return res.json();
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "notion_search",
        description: "Search Notion for pages and databases by title or content.",
        parameters: z.object({
          query: z.string().describe("Search query"),
          maxResults: z.number().optional().describe("Max results (default 10)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const data = await this.api("/search", {
            method: "POST",
            body: JSON.stringify({
              query: args.query,
              page_size: (args.maxResults as number) ?? 10,
            }),
          });

          const results = data.results ?? [];
          if (results.length === 0) return "No results found.";

          return results
            .map((r: any, i: number) => {
              const title =
                r.properties?.title?.title?.[0]?.plain_text ??
                r.properties?.Name?.title?.[0]?.plain_text ??
                "(untitled)";
              return `${i + 1}. [${r.object}] ${title}\n   ID: ${r.id}\n   URL: ${r.url ?? ""}`;
            })
            .join("\n\n");
        },
      },
      {
        name: "notion_get_page",
        description: "Get the content of a Notion page by ID. Returns the page text.",
        parameters: z.object({
          pageId: z.string().describe("Notion page ID"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const page = await this.api(`/pages/${args.pageId}`);
          const blocks = await this.api(`/blocks/${args.pageId}/children?page_size=100`);

          const title =
            page.properties?.title?.title?.[0]?.plain_text ??
            page.properties?.Name?.title?.[0]?.plain_text ??
            "(untitled)";

          const content = extractPlainText(blocks.results ?? []);

          return [
            `Title: ${title}`,
            `URL: ${page.url ?? ""}`,
            `Last edited: ${page.last_edited_time}`,
            "",
            content || "(empty page)",
          ].join("\n");
        },
      },
      {
        name: "notion_create_page",
        description: "Create a new page in a Notion database or as a child of another page.",
        parameters: z.object({
          parentId: z.string().describe("Parent page ID or database ID"),
          parentType: z.enum(["database", "page"]).optional().describe('Parent type (default "database")'),
          title: z.string().describe("Page title"),
          content: z.string().optional().describe("Page body text (plain text, added as a paragraph)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const parentType = (args.parentType as string) ?? "database";
          const parent =
            parentType === "database" ? { database_id: args.parentId as string } : { page_id: args.parentId as string };

          const properties: Record<string, unknown> =
            parentType === "database"
              ? { Name: { title: [{ text: { content: args.title as string } }] } }
              : { title: { title: [{ text: { content: args.title as string } }] } };

          const children: any[] = [];
          if (args.content) {
            children.push({
              object: "block",
              type: "paragraph",
              paragraph: {
                rich_text: [{ type: "text", text: { content: args.content as string } }],
              },
            });
          }

          const page = await this.api("/pages", {
            method: "POST",
            body: JSON.stringify({ parent, properties, children }),
          });

          return `Page created: ${page.id}\nURL: ${page.url ?? ""}`;
        },
      },
      {
        name: "notion_query_database",
        description: "Query a Notion database with optional filters and sorts. Returns page titles and properties.",
        parameters: z.object({
          databaseId: z.string().describe("Database ID"),
          filter: z.record(z.any()).optional().describe("Notion filter object (see Notion API docs)"),
          maxResults: z.number().optional().describe("Max results (default 20)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const body: Record<string, unknown> = {
            page_size: (args.maxResults as number) ?? 20,
          };
          if (args.filter) body.filter = args.filter;

          const data = await this.api(`/databases/${args.databaseId}/query`, {
            method: "POST",
            body: JSON.stringify(body),
          });

          const results = data.results ?? [];
          if (results.length === 0) return "No results found.";

          return results
            .map((r: any, i: number) => {
              const title =
                r.properties?.Name?.title?.[0]?.plain_text ??
                r.properties?.title?.title?.[0]?.plain_text ??
                "(untitled)";

              const props = Object.entries(r.properties ?? {})
                .filter(([k]) => k !== "Name" && k !== "title")
                .map(([k, v]: [string, any]) => {
                  if (v.type === "select") return `${k}: ${v.select?.name ?? ""}`;
                  if (v.type === "multi_select") return `${k}: ${v.multi_select?.map((s: any) => s.name).join(", ")}`;
                  if (v.type === "number") return `${k}: ${v.number ?? ""}`;
                  if (v.type === "date") return `${k}: ${v.date?.start ?? ""}`;
                  if (v.type === "rich_text") return `${k}: ${v.rich_text?.[0]?.plain_text ?? ""}`;
                  if (v.type === "checkbox") return `${k}: ${v.checkbox}`;
                  return null;
                })
                .filter(Boolean)
                .join(" | ");

              return `${i + 1}. ${title}${props ? `\n   ${props}` : ""}`;
            })
            .join("\n\n");
        },
      },
    ];
  }
}
