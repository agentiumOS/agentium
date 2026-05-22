import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

export interface TelegramConfig {
  /** Telegram Bot token from @BotFather. Falls back to TELEGRAM_BOT_TOKEN env var. */
  botToken?: string;
}

/**
 * Telegram Toolkit — send messages, photos, and read updates via the Telegram Bot API.
 *
 * No external dependencies — uses the pure HTTP Bot API via `fetch`.
 *
 * @example
 * ```ts
 * const telegram = new TelegramToolkit({ botToken: process.env.TELEGRAM_BOT_TOKEN });
 * const agent = new Agent({ tools: [...telegram.getTools()] });
 * ```
 */
export class TelegramToolkit extends Toolkit {
  readonly name = "telegram";
  private botToken: string;
  private baseUrl: string;

  constructor(config: TelegramConfig = {}) {
    super();
    this.botToken = config.botToken ?? process.env.TELEGRAM_BOT_TOKEN ?? "";
    if (!this.botToken) throw new Error("Telegram bot token is required. Set botToken or TELEGRAM_BOT_TOKEN env var.");
    this.baseUrl = `https://api.telegram.org/bot${this.botToken}`;
  }

  private async api(method: string, body?: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json()) as any;
    if (!data.ok) throw new Error(`Telegram API error: ${data.description ?? res.status}`);
    return data.result;
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "telegram_send_message",
        description: "Send a text message to a Telegram chat.",
        parameters: z.object({
          chatId: z.union([z.string(), z.number()]).describe("Chat ID or @username"),
          text: z.string().describe("Message text (supports Markdown)"),
          parseMode: z.enum(["Markdown", "HTML", "MarkdownV2"]).optional().describe("Parse mode (default Markdown)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const result = await this.api("sendMessage", {
              chat_id: args.chatId,
              text: args.text,
              parse_mode: (args.parseMode as string) ?? "Markdown",
            });
            return JSON.stringify({ messageId: result.message_id, chat: result.chat?.title ?? result.chat?.id });
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "telegram_send_photo",
        description: "Send a photo to a Telegram chat.",
        parameters: z.object({
          chatId: z.union([z.string(), z.number()]).describe("Chat ID or @username"),
          photo: z.string().describe("Photo URL or file_id"),
          caption: z.string().optional().describe("Photo caption"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const result = await this.api("sendPhoto", {
              chat_id: args.chatId,
              photo: args.photo,
              caption: args.caption,
            });
            return JSON.stringify({ messageId: result.message_id });
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "telegram_get_updates",
        description: "Get recent messages/updates received by the bot.",
        parameters: z.object({
          limit: z.number().optional().describe("Max updates to return (default 10)"),
          offset: z.number().optional().describe("Offset for pagination"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const result = await this.api("getUpdates", {
              limit: (args.limit as number) ?? 10,
              offset: args.offset,
            });
            const updates = (result as any[]).map((u: any) => ({
              updateId: u.update_id,
              from: u.message?.from?.username ?? u.message?.from?.first_name,
              chat: u.message?.chat?.title ?? u.message?.chat?.id,
              text: u.message?.text,
              date: u.message?.date,
            }));
            return JSON.stringify(updates, null, 2);
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
    ];
  }
}
