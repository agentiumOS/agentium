import { createRequire } from "node:module";
import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

const _require = createRequire(import.meta.url);

export interface GmailConfig {
  /** Path to OAuth2 credentials JSON file. Falls back to GMAIL_CREDENTIALS_PATH env var. */
  credentialsPath?: string;
  /** Path to saved token JSON file. Falls back to GMAIL_TOKEN_PATH env var. */
  tokenPath?: string;
  /** Pre-authenticated OAuth2 client (if you handle auth yourself). */
  authClient?: any;
}

/**
 * Gmail Toolkit — send, search, and read emails from your agent.
 *
 * Requires: npm install googleapis
 *
 * @example
 * ```ts
 * const gmail = new GmailToolkit({ credentialsPath: "./credentials.json", tokenPath: "./token.json" });
 * const agent = new Agent({ tools: [...gmail.getTools()] });
 * ```
 */
export class GmailToolkit extends Toolkit {
  readonly name = "gmail";
  private config: GmailConfig;
  private gmail: any = null;

  constructor(config: GmailConfig = {}) {
    super();
    this.config = config;
  }

  private async getGmailClient(): Promise<any> {
    if (this.gmail) return this.gmail;

    if (this.config.authClient) {
      const { google } = _require("googleapis");
      this.gmail = google.gmail({ version: "v1", auth: this.config.authClient });
      return this.gmail;
    }

    const credPath = this.config.credentialsPath ?? process.env.GMAIL_CREDENTIALS_PATH;
    const tokenPath = this.config.tokenPath ?? process.env.GMAIL_TOKEN_PATH;

    if (!credPath || !tokenPath) {
      throw new Error(
        "GmailToolkit: Provide credentialsPath + tokenPath, or an authClient. " +
          "Set GMAIL_CREDENTIALS_PATH and GMAIL_TOKEN_PATH env vars, or pass them in config.",
      );
    }

    const { google } = _require("googleapis");
    const fs = await import("node:fs");
    const creds = JSON.parse(fs.readFileSync(credPath, "utf-8"));
    const token = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));

    const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
    const oAuth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris?.[0]);
    oAuth2.setCredentials(token);

    this.gmail = google.gmail({ version: "v1", auth: oAuth2 });
    return this.gmail;
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "gmail_send",
        description: "Send an email via Gmail. Provide recipient, subject, and body.",
        parameters: z.object({
          to: z.string().describe("Recipient email address"),
          subject: z.string().describe("Email subject line"),
          body: z.string().describe("Email body (plain text)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const gmail = await this.getGmailClient();
          const rawMessage = [
            `To: ${args.to}`,
            `Subject: ${args.subject}`,
            "Content-Type: text/plain; charset=utf-8",
            "",
            args.body,
          ].join("\n");

          const encoded = Buffer.from(rawMessage)
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");

          const res = await gmail.users.messages.send({
            userId: "me",
            requestBody: { raw: encoded },
          });

          return `Email sent successfully. Message ID: ${res.data.id}`;
        },
      },
      {
        name: "gmail_search",
        description: "Search emails in Gmail. Returns subject, from, date, and snippet for matching messages.",
        parameters: z.object({
          query: z.string().describe('Gmail search query (e.g. "from:john subject:meeting is:unread")'),
          maxResults: z.number().optional().describe("Maximum number of results (default 10)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const gmail = await this.getGmailClient();
          const max = (args.maxResults as number) ?? 10;

          const list = await gmail.users.messages.list({
            userId: "me",
            q: args.query as string,
            maxResults: max,
          });

          const messages = list.data.messages ?? [];
          if (messages.length === 0) return "No emails found.";

          const results: string[] = [];
          for (const msg of messages) {
            const detail = await gmail.users.messages.get({
              userId: "me",
              id: msg.id,
              format: "metadata",
              metadataHeaders: ["From", "Subject", "Date"],
            });

            const headers = detail.data.payload?.headers ?? [];
            const getHeader = (name: string) =>
              headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

            results.push(
              `ID: ${msg.id}\nFrom: ${getHeader("From")}\nSubject: ${getHeader("Subject")}\nDate: ${getHeader("Date")}\nSnippet: ${detail.data.snippet ?? ""}`,
            );
          }

          return results.join("\n\n---\n\n");
        },
      },
      {
        name: "gmail_read",
        description: "Read the full content of an email by its message ID.",
        parameters: z.object({
          messageId: z.string().describe("The Gmail message ID to read"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const gmail = await this.getGmailClient();

          const detail = await gmail.users.messages.get({
            userId: "me",
            id: args.messageId as string,
            format: "full",
          });

          const headers = detail.data.payload?.headers ?? [];
          const getHeader = (name: string) =>
            headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

          let body = "";
          const payload = detail.data.payload;
          if (payload?.body?.data) {
            body = Buffer.from(payload.body.data, "base64").toString("utf-8");
          } else if (payload?.parts) {
            const textPart = payload.parts.find((p: any) => p.mimeType === "text/plain");
            if (textPart?.body?.data) {
              body = Buffer.from(textPart.body.data, "base64").toString("utf-8");
            } else {
              const htmlPart = payload.parts.find((p: any) => p.mimeType === "text/html");
              if (htmlPart?.body?.data) {
                body = Buffer.from(htmlPart.body.data, "base64").toString("utf-8");
              }
            }
          }

          return `From: ${getHeader("From")}\nTo: ${getHeader("To")}\nSubject: ${getHeader("Subject")}\nDate: ${getHeader("Date")}\n\n${body || "(no body)"}`;
        },
      },
    ];
  }
}
