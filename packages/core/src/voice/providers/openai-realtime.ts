import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { buildOpenAIRealtimeSession, DEFAULT_REALTIME_MODEL } from "../openai-session.js";
import type {
  CreateResponseOpts,
  RealtimeConnection,
  RealtimeEvent,
  RealtimeEventMap,
  RealtimeProvider,
  RealtimeSessionConfig,
  RealtimeToolCall,
} from "../types.js";

const _require = createRequire(import.meta.url);

export interface OpenAIRealtimeConfig {
  apiKey?: string;
  baseURL?: string;
}

function toDataUrl(image: Buffer | string, mimeType = "image/png"): string {
  if (typeof image === "string") {
    if (image.startsWith("data:")) return image;
    if (image.startsWith("http://") || image.startsWith("https://")) return image;
    return `data:${mimeType};base64,${image}`;
  }
  return `data:${mimeType};base64,${image.toString("base64")}`;
}

class OpenAIRealtimeConnection extends EventEmitter implements RealtimeConnection {
  private ws: any;
  private closed = false;
  private pendingFunctionCalls = new Map<string, { name: string; args: string }>();

  constructor(ws: any) {
    super();
    this.ws = ws;
  }

  sendAudio(data: Buffer): void {
    if (this.closed) return;
    this.send({ type: "input_audio_buffer.append", audio: data.toString("base64") });
  }

  sendText(text: string): void {
    if (this.closed) return;
    this.send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    });
    this.send({ type: "response.create" });
  }

  sendImage(image: Buffer | string, opts?: { mimeType?: string; text?: string }): void {
    if (this.closed) return;
    const content: Array<Record<string, unknown>> = [
      { type: "input_image", image_url: toDataUrl(image, opts?.mimeType) },
    ];
    if (opts?.text) content.push({ type: "input_text", text: opts.text });
    this.send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content },
    });
    this.send({ type: "response.create" });
  }

  sendToolResult(callId: string, result: string): void {
    if (this.closed) return;
    this.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: result },
    });
    this.send({ type: "response.create" });
  }

  createResponse(opts?: CreateResponseOpts): void {
    if (this.closed) return;
    const response: Record<string, unknown> = {};
    if (opts?.instructions) response.instructions = opts.instructions;
    if (opts?.conversation) response.conversation = opts.conversation;
    if (opts?.modalities) response.output_modalities = opts.modalities;
    this.send({ type: "response.create", ...(Object.keys(response).length ? { response } : {}) });
  }

  commitAudio(): void {
    if (this.closed) return;
    this.send({ type: "input_audio_buffer.commit" });
  }

  interrupt(): void {
    if (this.closed) return;
    this.send({ type: "response.cancel" });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close();
    } catch (err) {
      console.warn("[agentium/openai-realtime] Error closing WebSocket:", err instanceof Error ? err.message : err);
    }
    this.emit("disconnected", {});
  }

  on<K extends RealtimeEvent>(event: K, handler: (data: RealtimeEventMap[K]) => void): this {
    return super.on(event, handler as any);
  }

  off<K extends RealtimeEvent>(event: K, handler: (data: RealtimeEventMap[K]) => void): this {
    return super.off(event, handler as any);
  }

  private send(event: Record<string, unknown>): void {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(event));
  }

  _bindServerEvents(): void {
    this.ws.on("message", (raw: Buffer | string) => {
      try {
        const data = JSON.parse(typeof raw === "string" ? raw : raw.toString());
        this.handleServerEvent(data);
      } catch (err) {
        console.warn(
          "[agentium/openai-realtime] Error handling server message:",
          err instanceof Error ? err.message : err,
        );
      }
    });
    this.ws.on("error", (err: Error) => this.emit("error", { error: err }));
    this.ws.on("close", () => {
      if (!this.closed) {
        this.closed = true;
        this.emit("disconnected", {});
      }
    });
  }

  private handleServerEvent(event: any): void {
    switch (event.type) {
      case "session.created":
        this.emit("connected", {});
        break;

      case "response.audio.delta":
      case "response.output_audio.delta":
        if (event.delta) {
          this.emit("audio", { data: Buffer.from(event.delta, "base64"), mimeType: "audio/pcm" });
        }
        break;

      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta":
        if (event.delta) this.emit("transcript", { text: event.delta, role: "assistant" });
        break;

      case "response.text.delta":
      case "response.output_text.delta":
        if (event.delta) this.emit("text", { text: event.delta });
        break;

      case "input_audio_buffer.speech_started":
        this.emit("interrupted", {});
        break;

      case "input_audio_buffer.timeout_triggered":
        this.emit("idle", {});
        break;

      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) this.emit("transcript", { text: event.transcript, role: "user" });
        break;

      case "response.function_call_arguments.delta":
        if (event.item_id) {
          const pending = this.pendingFunctionCalls.get(event.item_id);
          if (pending) pending.args += event.delta ?? "";
        }
        break;

      case "response.output_item.added":
        if (event.item?.type === "function_call") {
          this.pendingFunctionCalls.set(event.item.id, { name: event.item.name ?? "", args: "" });
        }
        break;

      case "response.output_item.done":
        if (event.item?.type === "function_call") {
          const pending = this.pendingFunctionCalls.get(event.item.id);
          this.pendingFunctionCalls.delete(event.item.id);
          const toolCall: RealtimeToolCall = {
            id: event.item.call_id ?? event.item.id,
            name: pending?.name ?? event.item.name ?? "",
            arguments: pending?.args ?? event.item.arguments ?? "{}",
          };
          this.emit("tool_call", toolCall);
        }
        break;

      case "response.done":
        if (event.response?.usage) {
          const u = event.response.usage;
          this.emit("usage", {
            promptTokens: u.input_tokens ?? 0,
            completionTokens: u.output_tokens ?? 0,
            totalTokens: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
          });
        }
        break;

      case "error":
        this.emit("error", { error: new Error(event.error?.message ?? "Realtime API error") });
        break;
    }
  }
}

export class OpenAIRealtimeProvider implements RealtimeProvider {
  readonly providerId = "openai-realtime";
  readonly modelId: string;
  private apiKey?: string;
  private baseURL?: string;

  constructor(modelId?: string, config?: OpenAIRealtimeConfig) {
    this.modelId = modelId ?? DEFAULT_REALTIME_MODEL;
    this.apiKey = config?.apiKey;
    this.baseURL = config?.baseURL;
  }

  async connect(config: RealtimeSessionConfig): Promise<RealtimeConnection> {
    let WebSocket: any;
    try {
      WebSocket = _require("ws");
    } catch (e: any) {
      if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error("ws package is required for OpenAIRealtimeProvider. Install it: npm install ws");
      }
      throw e;
    }

    const key = config.apiKey ?? this.apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error("No OpenAI API key provided for realtime connection. Set OPENAI_API_KEY env var or pass apiKey.");
    }

    const base = this.baseURL ?? "wss://api.openai.com";
    const url = `${base}/v1/realtime?model=${encodeURIComponent(this.modelId)}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
    if (config.safetyIdentifier) headers["OpenAI-Safety-Identifier"] = config.safetyIdentifier;

    const ws = new WebSocket(url, { headers });
    const connection = new OpenAIRealtimeConnection(ws);

    return new Promise<RealtimeConnection>((resolve, reject) => {
      const TIMEOUT_MS = 30_000;
      const timeout = setTimeout(() => {
        reject(new Error(`OpenAI Realtime connection timed out after ${TIMEOUT_MS / 1000}s`));
        try {
          ws.close();
        } catch (err) {
          console.warn(
            "[agentium/openai-realtime] Error closing WebSocket on timeout:",
            err instanceof Error ? err.message : err,
          );
        }
      }, TIMEOUT_MS);

      ws.on("open", () => {
        clearTimeout(timeout);
        connection._bindServerEvents();
        ws.send(
          JSON.stringify({
            type: "session.update",
            session: buildOpenAIRealtimeSession(this.modelId, config),
          }),
        );
        resolve(connection);
      });

      ws.on("error", (err: Error) => {
        clearTimeout(timeout);
        reject(new Error(`OpenAI Realtime WebSocket error: ${err.message}`));
      });

      ws.on("unexpected-response", (_req: any, res: any) => {
        clearTimeout(timeout);
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          reject(new Error(`OpenAI Realtime rejected (HTTP ${res.statusCode}): ${body}`));
        });
      });
    });
  }
}
