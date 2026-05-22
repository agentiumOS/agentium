import type { RunOpts, RunOutput, StreamChunk } from "../agent/types.js";

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
    this.url = config.url.replace(/\/$/, "");
    this.name = config.name ?? "remote-team";
    this.headers = config.headers ?? {};
    this.timeoutMs = config.timeoutMs ?? 120_000;
  }

  async run(input: string, opts?: RunOpts): Promise<RunOutput> {
    const startMs = Date.now();
    const res = await fetch(`${this.url}/teams/${this.name}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers },
      body: JSON.stringify({
        input,
        sessionId: opts?.sessionId,
        userId: opts?.userId,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`Remote team run failed: ${res.status} ${res.statusText}`);
    }

    const result = (await res.json()) as RunOutput;
    result.durationMs = Date.now() - startMs;
    return result;
  }

  async *stream(input: string, opts?: RunOpts): AsyncGenerator<StreamChunk> {
    const res = await fetch(`${this.url}/teams/${this.name}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers },
      body: JSON.stringify({
        input,
        sessionId: opts?.sessionId,
        userId: opts?.userId,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`Remote team stream failed: ${res.status} ${res.statusText}`);
    }

    if (!res.body) throw new Error("No response body for SSE");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === "[DONE]") continue;

        try {
          const chunk = JSON.parse(jsonStr) as StreamChunk;
          yield chunk;
        } catch {
          // skip unparseable
        }
      }
    }
  }
}
