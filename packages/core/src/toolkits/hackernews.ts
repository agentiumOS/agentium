import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

export interface HackerNewsConfig {
  /** Enable fetching top stories (default true). */
  enableGetTopStories?: boolean;
  /** Enable fetching user details (default true). */
  enableGetUserDetails?: boolean;
}

/**
 * Hacker News Toolkit — search top stories and user details from HN.
 *
 * No API key required — uses the public Hacker News API.
 *
 * @example
 * ```ts
 * const hn = new HackerNewsToolkit();
 * const agent = new Agent({ tools: [...hn.getTools()] });
 * ```
 */
export class HackerNewsToolkit extends Toolkit {
  readonly name = "hackernews";
  private config: HackerNewsConfig;

  constructor(config: HackerNewsConfig = {}) {
    super();
    this.config = {
      enableGetTopStories: config.enableGetTopStories ?? true,
      enableGetUserDetails: config.enableGetUserDetails ?? true,
    };
  }

  getTools(): ToolDef[] {
    const tools: ToolDef[] = [];

    if (this.config.enableGetTopStories) {
      tools.push({
        name: "hackernews_top_stories",
        description: "Get the top stories from Hacker News. Returns title, URL, score, author, and comment count.",
        parameters: z.object({
          numStories: z.number().optional().describe("Number of top stories to fetch (default 10, max 30)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const num = Math.min((args.numStories as number) ?? 10, 30);

          const idsRes = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json");
          if (!idsRes.ok) throw new Error(`HN API failed: ${idsRes.status}`);
          const ids = (await idsRes.json()) as number[];

          const stories = await Promise.all(
            ids.slice(0, num).map(async (id) => {
              const res = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
              return res.json() as Promise<any>;
            }),
          );

          return stories
            .map(
              (s, i) =>
                `${i + 1}. ${s.title}\n   URL: ${s.url ?? `https://news.ycombinator.com/item?id=${s.id}`}\n   Score: ${s.score} | By: ${s.by} | Comments: ${s.descendants ?? 0}`,
            )
            .join("\n\n");
        },
      });
    }

    if (this.config.enableGetUserDetails) {
      tools.push({
        name: "hackernews_user",
        description:
          "Get details about a Hacker News user by username. Returns karma, about, and account creation date.",
        parameters: z.object({
          username: z.string().describe("The HN username to look up"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const username = args.username as string;
          const res = await fetch(`https://hacker-news.firebaseio.com/v0/user/${username}.json`);

          if (!res.ok) throw new Error(`HN user API failed: ${res.status}`);

          const user = (await res.json()) as any;
          if (!user) return `User "${username}" not found.`;

          const created = new Date(user.created * 1000).toISOString().split("T")[0];

          return [
            `Username: ${user.id}`,
            `Karma: ${user.karma}`,
            `Created: ${created}`,
            user.about ? `About: ${user.about}` : null,
            `Submitted: ${user.submitted?.length ?? 0} items`,
          ]
            .filter(Boolean)
            .join("\n");
        },
      });
    }

    return tools;
  }
}
