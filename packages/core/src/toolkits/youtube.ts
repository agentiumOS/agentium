import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

export interface YouTubeConfig {
  /** YouTube Data API key for search. Falls back to YOUTUBE_API_KEY env var. */
  apiKey?: string;
  /** Enable video search tool (default true, requires API key). */
  enableSearch?: boolean;
  /** Enable transcript extraction tool (default true, no API key needed). */
  enableTranscript?: boolean;
}

function extractVideoId(input: string): string | null {
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.hostname.includes("youtu.be")) return url.pathname.slice(1).split("/")[0] ?? null;
    return url.searchParams.get("v");
  } catch {
    return null;
  }
}

/**
 * YouTube Toolkit — search videos and extract transcripts.
 *
 * Transcript extraction uses the free YouTube timedtext endpoint.
 * Video search requires a YouTube Data API v3 key.
 *
 * @example
 * ```ts
 * const yt = new YouTubeToolkit({ apiKey: "..." });
 * const agent = new Agent({ tools: [...yt.getTools()] });
 * ```
 */
export class YouTubeToolkit extends Toolkit {
  readonly name = "youtube";
  private config: YouTubeConfig;

  constructor(config: YouTubeConfig = {}) {
    super();
    this.config = {
      enableSearch: config.enableSearch ?? true,
      enableTranscript: config.enableTranscript ?? true,
      apiKey: config.apiKey,
    };
  }

  private getApiKey(): string {
    const key = this.config.apiKey ?? process.env.YOUTUBE_API_KEY;
    if (!key)
      throw new Error("YouTubeToolkit: API key required for search. Set YOUTUBE_API_KEY env var or pass apiKey.");
    return key;
  }

  getTools(): ToolDef[] {
    const tools: ToolDef[] = [];

    if (this.config.enableTranscript) {
      tools.push({
        name: "youtube_transcript",
        description: "Get the transcript/captions for a YouTube video. Provide a video URL or ID. No API key needed.",
        parameters: z.object({
          video: z.string().describe("YouTube video URL or video ID"),
          language: z.string().optional().describe('Caption language code (default "en")'),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const videoId = extractVideoId(args.video as string);
          if (!videoId) return "Error: Could not extract video ID from the provided input.";

          const lang = (args.language as string) ?? "en";

          const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
            headers: { "User-Agent": "Mozilla/5.0 (compatible; Agentium/1.0)" },
          });
          if (!pageRes.ok) return `Error: Failed to fetch video page (${pageRes.status})`;

          const pageHtml = await pageRes.text();

          const captionMatch = pageHtml.match(/"captionTracks":\s*(\[[\s\S]*?\])/);
          if (!captionMatch) return "No captions available for this video.";

          let tracks: Array<{ baseUrl: string; languageCode: string; name?: { simpleText?: string } }>;
          try {
            tracks = JSON.parse(captionMatch[1]);
          } catch {
            return "Error: Could not parse caption track data.";
          }

          const track = tracks.find((t) => t.languageCode === lang) ?? tracks[0];
          if (!track) return "No caption tracks found.";

          const captionRes = await fetch(`${track.baseUrl}&fmt=srv3`);
          if (!captionRes.ok) return `Error: Failed to fetch captions (${captionRes.status})`;

          const xml = await captionRes.text();
          const lines: string[] = [];
          const textRegex = /<text[^>]*>([\s\S]*?)<\/text>/gi;
          let match: RegExpExecArray | null;
          while ((match = textRegex.exec(xml)) !== null) {
            const text = match[1]
              .replace(/&amp;/g, "&")
              .replace(/&lt;/g, "<")
              .replace(/&gt;/g, ">")
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .trim();
            if (text) lines.push(text);
          }

          if (lines.length === 0) return "Captions file was empty.";

          return `Transcript for video ${videoId} (${track.languageCode}):\n\n${lines.join(" ")}`;
        },
      });
    }

    if (this.config.enableSearch) {
      tools.push({
        name: "youtube_search",
        description: "Search YouTube for videos. Returns video titles, channels, URLs, and descriptions.",
        parameters: z.object({
          query: z.string().describe("Search query"),
          maxResults: z.number().optional().describe("Max results (default 5, max 25)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const apiKey = this.getApiKey();
          const query = args.query as string;
          const max = Math.min((args.maxResults as number) ?? 5, 25);

          const params = new URLSearchParams({
            part: "snippet",
            q: query,
            maxResults: String(max),
            type: "video",
            key: apiKey,
          });

          const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params.toString()}`);
          if (!res.ok) {
            const err = await res.text();
            throw new Error(`YouTube search failed: ${res.status} ${err}`);
          }

          const data = (await res.json()) as any;
          const items = data.items ?? [];

          if (items.length === 0) return "No videos found.";

          return items
            .map((item: any, i: number) => {
              const s = item.snippet;
              const videoId = item.id?.videoId ?? "";
              return `${i + 1}. ${s.title}\n   Channel: ${s.channelTitle}\n   URL: https://www.youtube.com/watch?v=${videoId}\n   ${s.description?.slice(0, 150) ?? ""}`;
            })
            .join("\n\n");
        },
      });
    }

    return tools;
  }
}
