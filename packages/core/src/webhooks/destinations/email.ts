import type { WebhookDestination } from "../types.js";

export interface EmailWebhookConfig {
  transport: "sendgrid";
  apiKey: string;
  to: string[];
  from: string;
  subject?: string | ((event: string) => string);
}

export function emailWebhook(config: EmailWebhookConfig): WebhookDestination {
  return {
    name: `email:${config.to.join(",")}`,
    async send(event: string, payload: unknown): Promise<void> {
      const subject =
        typeof config.subject === "function" ? config.subject(event) : (config.subject ?? `[Agentium] ${event}`);

      const body = JSON.stringify(payload, null, 2);

      const html = `<pre style="font-family:monospace;font-size:13px;background:#f5f5f5;padding:16px;border-radius:8px;">${escapeHtml(body)}</pre>`;

      if (config.transport === "sendgrid") {
        const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            personalizations: [{ to: config.to.map((email) => ({ email })) }],
            from: { email: config.from },
            subject,
            content: [
              { type: "text/plain", value: `[Agentium] ${event}\n\n${body}` },
              { type: "text/html", value: html },
            ],
          }),
        });

        if (!res.ok) {
          throw new Error(`SendGrid failed: ${res.status} ${res.statusText}`);
        }
      }
    },
  };
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
