import type { Agent } from "@agentium/core";

export interface A2AServerOptions {
  agents: Record<string, Agent>;
  basePath?: string;
  provider?: {
    organization: string;
    url?: string;
  };
  version?: string;
}
