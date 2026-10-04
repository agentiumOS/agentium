import { createRequire } from "node:module";
import { BoundedVoiceQueue, VoiceBackpressureError } from "../bounded-queue.js";

export interface SpeechSocket {
  readyState: number;
  bufferedAmount?: number;
  send(data: string): void;
  close(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}
export type SpeechSocketFactory = (
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
) => Promise<SpeechSocket>;
export interface SpeechWireOptions {
  apiKey?: string;
  socketFactory?: SpeechSocketFactory;
  maxQueueBytes?: number;
  onUsage?: (usage: import("../speech-types.js").SpeechUsage) => void;
}
const require = createRequire(import.meta.url);
export const defaultSpeechSocketFactory: SpeechSocketFactory = async (url, headers, signal) => {
  signal.throwIfAborted();
  let WS: any;
  try {
    WS = require("ws");
  } catch {
    throw new Error("Speech WebSocket adapters require optional 'ws'; install ws or inject socketFactory");
  }
  return new Promise((resolve, reject) => {
    const socket = new WS(url, { headers, maxPayload: 1024 * 1024 });
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      finish();
      socket.close();
      reject(new Error("Speech connection cancelled"));
    };
    const timer = setTimeout(() => {
      finish();
      socket.close();
      reject(new Error("Speech connection timed out"));
    }, 10_000);
    signal.addEventListener("abort", abort, { once: true });
    socket.once("open", () => {
      finish();
      resolve(socket);
    });
    socket.once("error", (error: Error) => {
      finish();
      reject(error);
    });
  });
};
export class SpeechWire<T> {
  readonly queue: BoundedVoiceQueue<T>;
  private closed = false;
  private complete = false;
  private readonly abort: () => void;
  private readonly message: (data: unknown) => void;
  private readonly error: (error: Error) => void;
  private readonly disconnect: () => void;
  constructor(
    private socket: SpeechSocket,
    private signal: AbortSignal,
    decode: (event: any, wire: SpeechWire<T>) => void,
    private maxBytes = 1024 * 1024,
    private onFailure?: (error: Error) => void,
  ) {
    this.queue = new BoundedVoiceQueue(256, maxBytes);
    this.abort = () => this.fail(new Error("Speech generation cancelled"));
    this.message = (raw) => {
      if (this.closed || signal.aborted) return;
      try {
        const text = typeof raw === "string" ? raw : Buffer.from(raw as Uint8Array).toString();
        if (Buffer.byteLength(text) > maxBytes) throw new VoiceBackpressureError("Speech wire event exceeds bound");
        decode(JSON.parse(text), this);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error("Invalid speech event"));
      }
    };
    this.error = (error) => this.fail(error);
    this.disconnect = () => {
      if (!this.closed)
        this.complete ? this.close() : this.fail(new Error("Speech connection ended before completion"));
    };
    socket.on("message", this.message);
    socket.on("error", this.error);
    socket.on("close", this.disconnect);
    signal.addEventListener("abort", this.abort, { once: true });
    if (signal.aborted) this.abort();
  }
  send(event: unknown): void {
    this.signal.throwIfAborted();
    if (this.closed || this.socket.readyState !== 1) throw new Error("Speech connection is closed");
    const payload = JSON.stringify(event);
    if ((this.socket.bufferedAmount ?? 0) + Buffer.byteLength(payload) > this.maxBytes) {
      const error = new VoiceBackpressureError("Speech socket send buffer exceeded");
      this.fail(error);
      throw error;
    }
    this.socket.send(payload);
  }
  push(value: T, bytes: number): void {
    this.queue.push(value, bytes);
  }
  finish(): void {
    this.complete = true;
    this.queue.close();
  }
  fail(error: Error): void {
    if (this.closed) return;
    try {
      this.onFailure?.(error);
    } finally {
      this.queue.fail(error);
      this.close();
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.signal.removeEventListener("abort", this.abort);
    this.socket.off("message", this.message);
    this.socket.off("error", this.error);
    this.socket.off("close", this.disconnect);
    this.socket.on("error", () => {});
    this.socket.close();
    this.queue.close();
  }
}
export function speechKey(config: SpeechWireOptions, environment: string): string {
  const key = config.apiKey ?? process.env[environment];
  if (!key) throw new Error(`Missing speech API key; configure apiKey or ${environment}`);
  return key;
}
