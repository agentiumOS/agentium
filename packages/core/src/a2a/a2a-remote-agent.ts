import { z } from "zod/v3";
import type { RunContext } from "../agent/run-context.js";
import type { RunOpts, RunOutput } from "../agent/types.js";
import type { StreamChunk } from "../models/types.js";
import type { ToolDef, ToolResult } from "../tools/types.js";
import { legacyEndpoint, legacySignal, readLegacySSE } from "./legacy-http.js";
import type { A2AAgentCard, A2AJsonRpcRequest, A2AJsonRpcResponse, A2AMessage, A2APart, A2ATask } from "./types.js";

export interface A2ARemoteAgentConfig {
  url: string;
  /** Custom headers for every request (e.g. auth tokens). */
  headers?: Record<string, string>;
  /** Override the discovered name. */
  name?: string;
  /** Request timeout in ms (default 60000). */
  timeoutMs?: number;
}

/**
 * A2ARemoteAgent wraps a remote A2A-compliant agent.
 * It can be used as a tool, a Team member, or called directly.
 */
export class A2ARemoteAgent {
  readonly url: string;
  name: string;
  instructions: string;
  skills: Array<{ id: string; name: string; description?: string }> = [];

  private headers: Record<string, string>;
  private timeoutMs: number;
  private card: A2AAgentCard | null = null;
  private rpcId = 0;

  get tools(): ToolDef[] {
    return [];
  }

  get modelId(): string {
    return "a2a-remote";
  }

  get providerId(): string {
    return "a2a";
  }

  get hasStructuredOutput(): boolean {
    return false;
  }

  constructor(config: A2ARemoteAgentConfig) {
    this.url = legacyEndpoint(config.url, config.timeoutMs ?? 60_000);
    this.name = config.name ?? "remote-agent";
    this.instructions = "";
    this.headers = { ...config.headers };
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  /**
   * Fetch the Agent Card from /.well-known/agent.json and populate metadata.
   */
  async discover(opts?: { signal?: AbortSignal }): Promise<A2AAgentCard> {
    const res = await fetch(`${this.url}/.well-known/agent.json`, {
      headers: this.headers,
      signal: legacySignal(this.timeoutMs, opts?.signal),
      redirect: "error",
    });

    if (!res.ok) {
      throw new Error(`A2A discover failed: ${res.status} ${res.statusText} from ${this.url}`);
    }

    this.card = (await res.json()) as A2AAgentCard;
    this.name = this.card.name;
    this.instructions = this.card.description ?? "";
    this.skills =
      this.card.skills?.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
      })) ?? [];

    return this.card;
  }

  /**
   * Synchronous run: sends message/send and returns RunOutput.
   */
  async run(input: string, opts?: RunOpts): Promise<RunOutput> {
    const message: A2AMessage = {
      role: "user",
      parts: [{ kind: "text", text: input }],
    };

    const rpcReq: A2AJsonRpcRequest = {
      jsonrpc: "2.0",
      id: ++this.rpcId,
      method: "message/send",
      params: {
        message,
        ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
      },
    };

    const startMs = Date.now();
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify(rpcReq),
      signal: legacySignal(this.timeoutMs, opts?.signal),
      redirect: "error",
    });

    if (!res.ok) {
      throw new Error(`A2A message/send failed: ${res.status} ${res.statusText}`);
    }

    const rpcRes = (await res.json()) as A2AJsonRpcResponse;
    if (rpcRes.error) {
      throw new Error(`A2A error: ${rpcRes.error.message}`);
    }

    const task = rpcRes.result as A2ATask;
    const agentMsg = task.status?.message;
    const text = agentMsg ? this.partsToText(agentMsg.parts) : "";

    return {
      text,
      status:
        task.status?.state === "completed"
          ? "completed"
          : task.status?.state === "canceled"
            ? "cancelled"
            : ["failed", "rejected"].includes(task.status?.state)
              ? "error"
              : "stopped",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      durationMs: Date.now() - startMs,
    };
  }

  /**
   * Streaming run: sends message/stream and yields StreamChunks from SSE.
   */
  async *stream(input: string, opts?: RunOpts): AsyncGenerator<StreamChunk> {
    const message: A2AMessage = {
      role: "user",
      parts: [{ kind: "text", text: input }],
    };

    const rpcReq: A2AJsonRpcRequest = {
      jsonrpc: "2.0",
      id: ++this.rpcId,
      method: "message/stream",
      params: {
        message,
        ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
      },
    };

    const signal = legacySignal(this.timeoutMs, opts?.signal);
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify(rpcReq),
      signal,
      redirect: "error",
    });

    if (!res.ok) {
      throw new Error(`A2A message/stream failed: ${res.status} ${res.statusText}`);
    }

    if (!res.body) {
      throw new Error("A2A message/stream: no response body for SSE");
    }

    let emittedText = false;
    for await (const value of readLegacySSE(res.body, signal)) {
      const event = value as A2AJsonRpcResponse;
      if (event.error) throw new Error(`A2A error: ${event.error.message}`);
      const task = event.result as A2ATask | undefined;
      if (!task) continue;
      if (task.status?.state === "working" && task.status.message?.parts?.length) {
        for (const part of task.status.message.parts) {
          if (part.kind === "text") {
            emittedText = true;
            yield { type: "text", text: part.text };
          }
        }
      }
      if (task.status?.state === "completed") {
        if (!emittedText && task.status.message) {
          const text = this.partsToText(task.status.message.parts);
          if (text) yield { type: "text", text };
        }
        yield { type: "finish", finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
        return;
      }
      if (["failed", "rejected", "canceled", "input-required"].includes(task.status?.state))
        throw new Error(`A2A task ended with status ${task.status.state}`);
    }
    throw new Error("A2A stream ended without a terminal result");
  }

  /**
   * Wrap this remote agent as a ToolDef so it can be used by an orchestrator agent.
   */
  asTool(): ToolDef {
    const self = this;
    return {
      name: `a2a_${this.name.replace(/[^a-zA-Z0-9_]/g, "_")}`,
      description: this.instructions || `Remote A2A agent: ${this.name}`,
      parameters: z.object({
        message: z.string().describe("The message to send to the remote agent"),
      }),
      async execute(args: Record<string, unknown>, _ctx: RunContext): Promise<string | ToolResult> {
        const result = await self.run(args.message as string, { signal: _ctx.signal, sessionId: _ctx.sessionId });
        if (result.status && result.status !== "completed")
          throw new Error(`A2A task ${result.status}: ${result.text}`);
        return result.text;
      },
    };
  }

  getAgentCard(): A2AAgentCard | null {
    return this.card;
  }

  private partsToText(parts: A2APart[]): string {
    return parts
      .filter((p): p is { kind: "text"; text: string } => p.kind === "text")
      .map((p) => p.text)
      .join("\n");
  }
}
