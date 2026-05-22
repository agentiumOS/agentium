import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

export interface WhatsAppConfig {
  /** WhatsApp Business API access token. Falls back to WHATSAPP_ACCESS_TOKEN env var. */
  accessToken?: string;
  /** WhatsApp Business phone number ID. Falls back to WHATSAPP_PHONE_NUMBER_ID env var. */
  phoneNumberId?: string;
  /** API version (default "v22.0"). Falls back to WHATSAPP_VERSION env var. */
  version?: string;
  /** Default recipient WhatsApp ID. Falls back to WHATSAPP_RECIPIENT_WAID env var. */
  recipientWaid?: string;
}

/**
 * WhatsApp Toolkit — send messages via WhatsApp Business Cloud API (Meta).
 *
 * Uses the WhatsApp Cloud API directly (no Twilio).
 * Setup: https://developers.facebook.com/docs/whatsapp/cloud-api/get-started
 *
 * @example
 * ```ts
 * const whatsapp = new WhatsAppToolkit({
 *   accessToken: "...",
 *   phoneNumberId: "...",
 * });
 * const agent = new Agent({ tools: [...whatsapp.getTools()] });
 * ```
 */
export class WhatsAppToolkit extends Toolkit {
  readonly name = "whatsapp";
  private accessToken: string;
  private phoneNumberId: string;
  private version: string;
  private recipientWaid: string | undefined;

  constructor(config: WhatsAppConfig = {}) {
    super();
    this.accessToken = config.accessToken ?? process.env.WHATSAPP_ACCESS_TOKEN ?? "";
    this.phoneNumberId = config.phoneNumberId ?? process.env.WHATSAPP_PHONE_NUMBER_ID ?? "";
    this.version = config.version ?? process.env.WHATSAPP_VERSION ?? "v22.0";
    this.recipientWaid = config.recipientWaid ?? process.env.WHATSAPP_RECIPIENT_WAID;
  }

  private getBaseUrl(): string {
    return `https://graph.facebook.com/${this.version}/${this.phoneNumberId}/messages`;
  }

  private validate(): void {
    if (!this.accessToken) {
      throw new Error("WhatsAppToolkit: accessToken is required. Set WHATSAPP_ACCESS_TOKEN env var or pass in config.");
    }
    if (!this.phoneNumberId) {
      throw new Error(
        "WhatsAppToolkit: phoneNumberId is required. Set WHATSAPP_PHONE_NUMBER_ID env var or pass in config.",
      );
    }
  }

  private resolveRecipient(recipient?: string): string {
    const r = recipient ?? this.recipientWaid;
    if (!r) {
      throw new Error(
        "WhatsAppToolkit: recipient is required. Provide it in the tool call or set WHATSAPP_RECIPIENT_WAID env var.",
      );
    }
    return r.replace(/[^0-9]/g, "");
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "whatsapp_send_text",
        description: "Send a text message to a WhatsApp user via WhatsApp Business Cloud API.",
        parameters: z.object({
          text: z.string().describe("The text message to send"),
          recipient: z
            .string()
            .optional()
            .describe("Recipient WhatsApp number with country code (e.g. 919876543210). Uses default if omitted."),
          previewUrl: z.boolean().optional().describe("Enable URL previews in the message (default false)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          this.validate();
          const recipient = this.resolveRecipient(args.recipient as string);

          const res = await fetch(this.getBaseUrl(), {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              recipient_type: "individual",
              to: recipient,
              type: "text",
              text: {
                preview_url: (args.previewUrl as boolean) ?? false,
                body: args.text as string,
              },
            }),
          });

          if (!res.ok) {
            const err = await res.text();
            throw new Error(`WhatsApp send failed: ${res.status} ${err}`);
          }

          const data = (await res.json()) as any;
          const msgId = data.messages?.[0]?.id ?? "unknown";
          return `Message sent successfully to ${recipient}. Message ID: ${msgId}`;
        },
      },
      {
        name: "whatsapp_send_template",
        description:
          "Send a template message to a WhatsApp user. Required for first-time outreach (24-hour messaging window).",
        parameters: z.object({
          templateName: z.string().describe('The pre-approved template name (e.g. "hello_world")'),
          recipient: z
            .string()
            .optional()
            .describe("Recipient WhatsApp number with country code. Uses default if omitted."),
          languageCode: z.string().optional().describe('Template language code (default "en_US")'),
          components: z
            .array(z.record(z.any()))
            .optional()
            .describe("Template components for dynamic content (header, body, button parameters)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          this.validate();
          const recipient = this.resolveRecipient(args.recipient as string);
          const langCode = (args.languageCode as string) ?? "en_US";

          const template: Record<string, unknown> = {
            name: args.templateName as string,
            language: { code: langCode },
          };

          if (args.components) {
            template.components = args.components;
          }

          const res = await fetch(this.getBaseUrl(), {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              recipient_type: "individual",
              to: recipient,
              type: "template",
              template,
            }),
          });

          if (!res.ok) {
            const err = await res.text();
            throw new Error(`WhatsApp template send failed: ${res.status} ${err}`);
          }

          const data = (await res.json()) as any;
          const msgId = data.messages?.[0]?.id ?? "unknown";
          return `Template message "${args.templateName}" sent to ${recipient}. Message ID: ${msgId}`;
        },
      },
    ];
  }
}
