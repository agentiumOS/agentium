import { createRequire } from "node:module";
import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

const _require = createRequire(import.meta.url);

export interface DiscordConfig {
  /** Discord bot token. Falls back to DISCORD_BOT_TOKEN env var. */
  botToken?: string;
}

/**
 * Discord Toolkit — send messages, read messages, and list channels.
 *
 * Requires the `discord.js` peer dependency.
 *
 * @example
 * ```ts
 * const discord = new DiscordToolkit({ botToken: process.env.DISCORD_BOT_TOKEN });
 * const agent = new Agent({ tools: [...discord.getTools()] });
 * ```
 */
export class DiscordToolkit extends Toolkit {
  readonly name = "discord";
  private botToken: string;
  private client: any;
  private ready = false;

  constructor(config: DiscordConfig = {}) {
    super();
    this.botToken = config.botToken ?? process.env.DISCORD_BOT_TOKEN ?? "";
    if (!this.botToken) throw new Error("Discord bot token is required. Set botToken or DISCORD_BOT_TOKEN env var.");
  }

  private async getClient(): Promise<any> {
    if (this.client && this.ready) return this.client;

    const { Client, GatewayIntentBits } = _require("discord.js");
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    });

    if (!this.ready) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Discord login timeout")), 15000);
        this.client.once("ready", () => {
          clearTimeout(timeout);
          this.ready = true;
          resolve();
        });
        this.client.login(this.botToken).catch(reject);
      });
    }

    return this.client;
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "discord_send_message",
        description: "Send a message to a Discord channel.",
        parameters: z.object({
          channelId: z.string().describe("Discord channel ID"),
          content: z.string().describe("Message content"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const client = await this.getClient();
            const channel = await client.channels.fetch(args.channelId as string);
            if (!channel?.isTextBased?.()) return JSON.stringify({ error: "Channel not found or not a text channel" });
            const msg = await channel.send(args.content as string);
            return JSON.stringify({
              messageId: msg.id,
              channel: channel.name ?? channel.id,
            });
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "discord_read_messages",
        description: "Read recent messages from a Discord channel.",
        parameters: z.object({
          channelId: z.string().describe("Discord channel ID"),
          limit: z.number().optional().describe("Number of messages to fetch (default 10, max 100)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const client = await this.getClient();
            const channel = await client.channels.fetch(args.channelId as string);
            if (!channel?.isTextBased?.()) return JSON.stringify({ error: "Channel not found or not a text channel" });
            const limit = Math.min((args.limit as number) ?? 10, 100);
            const messages = await channel.messages.fetch({ limit });
            const result = messages.map((m: any) => ({
              id: m.id,
              author: m.author?.username,
              content: m.content,
              timestamp: m.createdAt?.toISOString(),
            }));
            return JSON.stringify(Array.from(result.values()), null, 2);
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "discord_list_channels",
        description: "List text channels in a Discord server (guild).",
        parameters: z.object({
          guildId: z.string().describe("Discord server (guild) ID"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const client = await this.getClient();
            const guild = await client.guilds.fetch(args.guildId as string);
            const channels = await guild.channels.fetch();
            const textChannels = channels
              .filter((c: any) => c?.isTextBased?.())
              .map((c: any) => ({
                id: c.id,
                name: c.name,
                type: c.type,
                topic: c.topic ?? null,
              }));
            return JSON.stringify(Array.from(textChannels.values()), null, 2);
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "discord_reply_thread",
        description: "Reply to a message in a thread.",
        parameters: z.object({
          channelId: z.string().describe("Channel or thread ID"),
          messageId: z.string().describe("Message ID to reply to"),
          content: z.string().describe("Reply content"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const client = await this.getClient();
            const channel = await client.channels.fetch(args.channelId as string);
            if (!channel?.isTextBased?.()) return JSON.stringify({ error: "Channel not found or not a text channel" });
            const msg = await channel.messages.fetch(args.messageId as string);
            const reply = await msg.reply(args.content as string);
            return JSON.stringify({ messageId: reply.id });
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
    ];
  }
}
