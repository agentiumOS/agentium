import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

export interface SlackConfig {
  /** Slack Bot User OAuth Token. Falls back to SLACK_BOT_TOKEN env var. */
  token?: string;
}

/**
 * Slack Toolkit — send/read messages, list channels, and reply in threads.
 *
 * Requires a Slack Bot User OAuth Token with appropriate scopes
 * (chat:write, channels:read, channels:history, groups:history).
 *
 * @example
 * ```ts
 * const slack = new SlackToolkit({ token: "xoxb-..." });
 * const agent = new Agent({ tools: [...slack.getTools()] });
 * ```
 */
export class SlackToolkit extends Toolkit {
  readonly name = "slack";
  private tokenValue: string | undefined;

  constructor(config: SlackConfig = {}) {
    super();
    this.tokenValue = config.token;
  }

  private getToken(): string {
    const token = this.tokenValue ?? process.env.SLACK_BOT_TOKEN;
    if (!token) throw new Error("SlackToolkit: token required. Set SLACK_BOT_TOKEN env var or pass token in config.");
    return token;
  }

  private async api(method: string, body: Record<string, unknown>): Promise<any> {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.getToken()}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Slack API HTTP ${res.status}`);

    const data = (await res.json()) as any;
    if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
    return data;
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "slack_send_message",
        description: "Send a message to a Slack channel.",
        parameters: z.object({
          channel: z.string().describe("Channel ID or name (e.g. #general or C01234567)"),
          text: z.string().describe("Message text (supports Slack markdown)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const data = await this.api("chat.postMessage", {
            channel: args.channel,
            text: args.text,
          });
          return `Message sent. Channel: ${data.channel}, Timestamp: ${data.ts}`;
        },
      },
      {
        name: "slack_list_channels",
        description: "List Slack channels the bot has access to.",
        parameters: z.object({
          limit: z.number().optional().describe("Max channels to return (default 50)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const data = await this.api("conversations.list", {
            limit: (args.limit as number) ?? 50,
            types: "public_channel,private_channel",
          });

          const channels = data.channels ?? [];
          if (channels.length === 0) return "No channels found.";

          return channels
            .map(
              (c: any) =>
                `#${c.name} (${c.id}) — ${c.num_members ?? "?"} members${c.topic?.value ? ` — ${c.topic.value}` : ""}`,
            )
            .join("\n");
        },
      },
      {
        name: "slack_read_messages",
        description: "Read recent messages from a Slack channel.",
        parameters: z.object({
          channel: z.string().describe("Channel ID"),
          limit: z.number().optional().describe("Number of messages to fetch (default 20)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const data = await this.api("conversations.history", {
            channel: args.channel,
            limit: (args.limit as number) ?? 20,
          });

          const messages = data.messages ?? [];
          if (messages.length === 0) return "No messages found.";

          return messages
            .reverse()
            .map((m: any) => {
              const time = m.ts ? new Date(Number.parseFloat(m.ts) * 1000).toISOString() : "";
              return `[${time}] ${m.user ?? "bot"}: ${m.text}`;
            })
            .join("\n");
        },
      },
      {
        name: "slack_reply_thread",
        description: "Reply to a message thread in Slack.",
        parameters: z.object({
          channel: z.string().describe("Channel ID"),
          threadTs: z.string().describe("Timestamp of the parent message to reply to"),
          text: z.string().describe("Reply text"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const data = await this.api("chat.postMessage", {
            channel: args.channel,
            thread_ts: args.threadTs,
            text: args.text,
          });
          return `Reply sent in thread ${args.threadTs}. Timestamp: ${data.ts}`;
        },
      },
    ];
  }
}
