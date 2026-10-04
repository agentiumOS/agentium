import type { RunOpts, RunOutput, StreamChunk } from "../agent/types.js";
import { legacyEndpoint, legacySignal, readLegacySSE } from "./legacy-http.js";

export interface A2ARemoteTeamConfig {
  url: string;
  name?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * A2ARemoteTeam wraps a remote team endpoint.
 * Duck-types the Team interface so it can be used interchangeably.
 */
export class A2ARemoteTeam {
  readonly kind = "team" as const;
  readonly name: string;
  private url: string;
  private headers: Record<string, string>;
  private timeoutMs: number;

  constructor(config: A2ARemoteTeamConfig) {
    this.url = legacyEndpoint(config.url, config.timeoutMs ?? 120_000);
    this.name = config.name ?? "remote-team";
    this.headers = { ...config.headers };
    this.timeoutMs = config.timeoutMs ?? 120_000;
  }

  async run(input: string, opts?: RunOpts): Promise<RunOutput> {
    const startMs = Date.now();
    const res = await fetch(`${this.url}/teams/${encodeURIComponent(this.name)}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers },
      body: JSON.stringify({
        input,
        sessionId: opts?.sessionId,
        userId: opts?.userId,
      }),
      signal: legacySignal(this.timeoutMs, opts?.signal),
      redirect: "error",
    });

    if (!res.ok) {
      throw new Error(`Remote team run failed: ${res.status} ${res.statusText}`);
    }

    const result = (await res.json()) as RunOutput;
    result.durationMs = Date.now() - startMs;
    return result;
  }

  async *stream(input: string, opts?: RunOpts): AsyncGenerator<StreamChunk> {
    const signal = legacySignal(this.timeoutMs, opts?.signal);
    const res = await fetch(`${this.url}/teams/${encodeURIComponent(this.name)}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers },
      body: JSON.stringify({
        input,
        sessionId: opts?.sessionId,
        userId: opts?.userId,
      }),
      signal,
      redirect: "error",
    });

    if (!res.ok) {
      throw new Error(`Remote team stream failed: ${res.status} ${res.statusText}`);
    }

    if (!res.body) throw new Error("No response body for SSE");

    for await (const value of readLegacySSE(res.body, signal)) yield value as StreamChunk;
  }
}
