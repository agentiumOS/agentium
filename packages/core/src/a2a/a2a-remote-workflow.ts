import type { WorkflowResult } from "../workflow/types.js";
import { legacyEndpoint, legacySignal } from "./legacy-http.js";

export interface A2ARemoteWorkflowConfig {
  url: string;
  name?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * A2ARemoteWorkflow wraps a remote workflow endpoint.
 */
export class A2ARemoteWorkflow {
  readonly kind = "workflow" as const;
  readonly name: string;
  private url: string;
  private headers: Record<string, string>;
  private timeoutMs: number;

  constructor(config: A2ARemoteWorkflowConfig) {
    this.url = legacyEndpoint(config.url, config.timeoutMs ?? 120_000);
    this.name = config.name ?? "remote-workflow";
    this.headers = { ...config.headers };
    this.timeoutMs = config.timeoutMs ?? 120_000;
  }

  async run(
    initialState?: Record<string, unknown>,
    opts?: { signal?: AbortSignal },
  ): Promise<WorkflowResult<Record<string, unknown>>> {
    const res = await fetch(`${this.url}/workflows/${encodeURIComponent(this.name)}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers },
      body: JSON.stringify(initialState ?? {}),
      signal: legacySignal(this.timeoutMs, opts?.signal),
      redirect: "error",
    });

    if (!res.ok) {
      throw new Error(`Remote workflow run failed: ${res.status} ${res.statusText}`);
    }

    return (await res.json()) as WorkflowResult<Record<string, unknown>>;
  }
}
