import { createHmac } from "node:crypto";
import type { WebhookDestination } from "../types.js";

export interface HttpWebhookConfig {
  url: string;
  headers?: Record<string, string>;
  method?: "POST" | "PUT";
  secret?: string;
}

export function httpWebhook(config: HttpWebhookConfig): WebhookDestination {
  return {
    name: `http:${new URL(config.url).hostname}`,
    async send(event: string, payload: unknown): Promise<void> {
      const body = JSON.stringify({ event, payload, timestamp: Date.now() });

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...config.headers,
      };

      if (config.secret) {
        const signature = createHmac("sha256", config.secret).update(body).digest("hex");
        headers["X-Webhook-Signature"] = `sha256=${signature}`;
      }

      const res = await fetch(config.url, {
        method: config.method ?? "POST",
        headers,
        body,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
    },
  };
}
