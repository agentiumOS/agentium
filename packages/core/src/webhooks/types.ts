export interface WebhookDestination {
  name: string;
  send(event: string, payload: unknown): Promise<void>;
}

export interface WebhookConfig {
  destinations: WebhookDestination[];
  events?: string[];
  batchInterval?: number;
  retries?: number;
  onError?: "log" | "throw";
}
