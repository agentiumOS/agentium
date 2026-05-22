import type { WebhookDestination } from "../types.js";

export interface SlackWebhookConfig {
  webhookUrl: string;
  channel?: string;
  formatMessage?: (event: string, payload: unknown) => string;
}

function defaultFormat(event: string, payload: unknown): string {
  const p = payload as Record<string, unknown>;
  const lines = [`*[Agentium]* \`${event}\``];

  if (p.agentName) lines.push(`Agent: ${p.agentName}`);
  if (p.runId) lines.push(`Run: \`${(p.runId as string).slice(0, 8)}\``);

  if (p.output && typeof p.output === "object") {
    const out = p.output as Record<string, unknown>;
    if (out.usage && typeof out.usage === "object") {
      const u = out.usage as Record<string, number>;
      lines.push(`Tokens: ${u.promptTokens ?? 0} prompt + ${u.completionTokens ?? 0} completion`);
    }
    if (out.durationMs) {
      lines.push(`Duration: ${((out.durationMs as number) / 1000).toFixed(1)}s`);
    }
  }

  if (p.error && typeof p.error === "object" && (p.error as Error).message) {
    lines.push(`Error: ${(p.error as Error).message}`);
  }

  return lines.join("\n");
}

export function slackWebhook(config: SlackWebhookConfig): WebhookDestination {
  const format = config.formatMessage ?? defaultFormat;

  return {
    name: "slack",
    async send(event: string, payload: unknown): Promise<void> {
      const text = format(event, payload);

      const body: Record<string, unknown> = { text };
      if (config.channel) body.channel = config.channel;

      const res = await fetch(config.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        throw new Error(`Slack webhook failed: ${res.status}`);
      }
    },
  };
}
