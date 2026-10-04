import { randomUUID } from "node:crypto";
import type { JSONRPCMessage, Transport, TransportSendOptions } from "@modelcontextprotocol/client";

/** Shares a transport without sharing request IDs with SDK requests. Tasks is an
 * extension; the base v2 SDK intentionally rejects resultType:task. */
export class MCPTaskTransport implements Transport {
  onmessage?: Transport["onmessage"];
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  private pending = new Map<
    string,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: unknown) => void }
  >();
  constructor(private readonly inner: Transport) {}
  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }
  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }
  async start(): Promise<void> {
    this.inner.onmessage = (message, extra) => {
      if ("id" in message && typeof message.id === "string" && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)!;
        if ("error" in message) {
          const error = Object.assign(new Error(message.error.message), {
            code: message.error.code,
            data: message.error.data,
          });
          pending.reject(error);
        } else if ("result" in message) pending.resolve(message.result);
        else pending.reject(new Error("Invalid MCP task response"));
      } else this.onmessage?.(message, extra);
    };
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onclose = () => {
      this.rejectAll();
      this.onclose?.();
    };
    await this.inner.start();
  }
  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.inner.send(message, options);
  }
  private rejectAll(): void {
    for (const pending of this.pending.values()) pending.reject(new Error("MCP connection closed"));
  }
  async close(): Promise<void> {
    this.rejectAll();
    await this.inner.close();
  }
  async request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    timeout = 60000,
  ): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    const id = `agentium-task:${randomUUID()}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        abort = () => reject(signal?.reason ?? new Error("MCP request aborted"));
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => reject(new Error("MCP task request timed out")), timeout);
        void this.inner.send({ jsonrpc: "2.0", id, method, params }, { requestSignal: signal }).catch(reject);
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
      this.pending.delete(id);
    }
  }
}
