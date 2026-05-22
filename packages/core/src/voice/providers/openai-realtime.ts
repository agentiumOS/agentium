import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type {
  AudioFormat,
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

function toOpenAIAudioFormat(fmt?: AudioFormat): string {
  if (!fmt) return "pcm16";
  switch (fmt) {
    case "pcm16":
      return "pcm16";
    case "g711_ulaw":
      return "g711_ulaw";
    case "g711_alaw":
      return "g711_alaw";
    default:
      return "pcm16";
  }
}

class OpenAIRealtimeConnection extends EventEmitter implements RealtimeConnection {
  private ws: any;
  private closed = false;

  constructor(ws: any) {
    super();
    this.ws = ws;
  }

  sendAudio(data: Buffer): void {
    if (this.closed) return;
    this.send({
      type: "input_audio_buffer.append",
      audio: data.toString("base64"),
    });
  }

  sendText(text: string): void {
    if (this.closed) return;
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    this.send({ type: "response.create" });
  }

  sendToolResult(callId: string, result: string): void {
    if (this.closed) return;
    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: result,
      },
    });
    this.send({ type: "response.create" });
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
    if (this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(event));
    }
  }

  /** Called by the provider to set up server event handling. */
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

    this.ws.on("error", (err: Error) => {
      this.emit("error", { error: err });
    });

    this.ws.on("close", () => {
      if (!this.closed) {
        this.closed = true;
        this.emit("disconnected", {});
      }
    });
  }

  private pendingFunctionCalls = new Map<string, { name: string; args: string }>();

  private handleServerEvent(event: any): void {
    switch (event.type) {
      case "session.created":
        this.emit("connected", {});
        break;

      case "response.audio.delta":
        if (event.delta) {
          this.emit("audio", {
            data: Buffer.from(event.delta, "base64"),
            mimeType: "audio/pcm",
          });
        }
        break;

      case "response.audio_transcript.delta":
        if (event.delta) {
          this.emit("transcript", { text: event.delta, role: "assistant" });
        }
        break;

      case "response.text.delta":
        if (event.delta) {
          this.emit("text", { text: event.delta });
        }
        break;

      case "input_audio_buffer.speech_started":
        this.emit("interrupted", {});
        break;

      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) {
          this.emit("transcript", { text: event.transcript, role: "user" });
        }
        break;

      case "response.function_call_arguments.delta":
        if (event.item_id) {
          const pending = this.pendingFunctionCalls.get(event.item_id);
          if (pending) {
            pending.args += event.delta ?? "";
          }
        }
        break;

      case "response.output_item.added":
        if (event.item?.type === "function_call") {
          this.pendingFunctionCalls.set(event.item.id, {
            name: event.item.name ?? "",
            args: "",
          });
        }
        break;

      case "response.output_item.done":
        if (event.item?.type === "function_call") {
          const pending = this.pendingFunctionCalls.get(event.item.id);
          const toolCall: RealtimeToolCall = {
            id: event.item.call_id ?? event.item.id,
            name: pending?.name ?? event.item.name ?? "",
            arguments: pending?.args ?? event.item.arguments ?? "{}",
          };
          this.pendingFunctionCalls.delete(event.item.id);
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
        this.emit("error", {
          error: new Error(event.error?.message ?? "Realtime API error"),
        });
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
    this.modelId = modelId ?? "gpt-4o-realtime-preview";
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

    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${key}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

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

        const sessionUpdate: Record<string, unknown> = {
          type: "session.update",
          session: this.buildSessionPayload(config),
        };
        ws.send(JSON.stringify(sessionUpdate));
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

  private buildSessionPayload(config: RealtimeSessionConfig): Record<string, unknown> {
    const session: Record<string, unknown> = {
      modalities: ["text", "audio"],
      model: this.modelId,
    };

    if (config.instructions) {
      session.instructions = config.instructions;
    }

    if (config.voice) {
      session.voice = config.voice;
    }

    if (config.inputAudioFormat) {
      session.input_audio_format = toOpenAIAudioFormat(config.inputAudioFormat);
    }

    if (config.outputAudioFormat) {
      session.output_audio_format = toOpenAIAudioFormat(config.outputAudioFormat);
    }

    if (config.turnDetection !== undefined) {
      if (config.turnDetection === null) {
        session.turn_detection = null;
      } else {
        session.turn_detection = {
          type: config.turnDetection.type,
          ...(config.turnDetection.threshold !== undefined && {
            threshold: config.turnDetection.threshold,
          }),
          ...(config.turnDetection.prefixPaddingMs !== undefined && {
            prefix_padding_ms: config.turnDetection.prefixPaddingMs,
          }),
          ...(config.turnDetection.silenceDurationMs !== undefined && {
            silence_duration_ms: config.turnDetection.silenceDurationMs,
          }),
        };
      }
    }

    if (config.temperature !== undefined) {
      session.temperature = config.temperature;
    }

    if (config.maxResponseOutputTokens !== undefined) {
      session.max_response_output_tokens = config.maxResponseOutputTokens;
    }

    session.input_audio_transcription = { model: "whisper-1" };

    if (config.tools && config.tools.length > 0) {
      session.tools = config.tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
    }

    return session;
  }
}
