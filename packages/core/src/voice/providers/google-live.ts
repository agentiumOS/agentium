import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type {
  RealtimeConnection,
  RealtimeEvent,
  RealtimeEventMap,
  RealtimeProvider,
  RealtimeSessionConfig,
  RealtimeToolCall,
} from "../types.js";

const _require = createRequire(import.meta.url);

export interface GoogleLiveConfig {
  apiKey?: string;
}

class GoogleLiveConnection extends EventEmitter implements RealtimeConnection {
  private session: any;
  private closed = false;

  constructor(session: any) {
    super();
    this.session = session;
  }

  sendAudio(data: Buffer): void {
    if (this.closed) return;
    this.session.sendRealtimeInput({
      audio: {
        data: data.toString("base64"),
        mimeType: "audio/pcm;rate=16000",
      },
    });
  }

  sendText(text: string): void {
    if (this.closed) return;
    this.session.sendClientContent({
      turns: text,
      turnComplete: true,
    });
  }

  sendToolResult(callId: string, result: string): void {
    if (this.closed) return;
    let responseObj: unknown;
    try {
      responseObj = JSON.parse(result);
    } catch {
      responseObj = { result };
    }

    this.session.sendToolResponse({
      functionResponses: [
        {
          id: callId,
          name: callId,
          response: responseObj,
        },
      ],
    });
  }

  interrupt(): void {
    // Google Live API handles interruption automatically via VAD.
    // No explicit interrupt command available.
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.session.close();
    } catch (err) {
      console.warn("[agentium/google-live] Error closing session:", err instanceof Error ? err.message : err);
    }
    this.emit("disconnected", {});
  }

  on<K extends RealtimeEvent>(event: K, handler: (data: RealtimeEventMap[K]) => void): this {
    return super.on(event, handler as any);
  }

  off<K extends RealtimeEvent>(event: K, handler: (data: RealtimeEventMap[K]) => void): this {
    return super.off(event, handler as any);
  }

  /** Internal: handle server messages from the Live API. */
  _handleMessage(message: any): void {
    if (message.serverContent?.interrupted) {
      this.emit("interrupted", {});
      return;
    }

    if (message.toolCall?.functionCalls) {
      for (const fc of message.toolCall.functionCalls) {
        const toolCall: RealtimeToolCall = {
          id: fc.id ?? fc.name,
          name: fc.name,
          arguments: JSON.stringify(fc.args ?? {}),
        };
        this.emit("tool_call", toolCall);
      }
      return;
    }

    if (message.serverContent?.modelTurn?.parts) {
      for (const part of message.serverContent.modelTurn.parts) {
        if (part.inlineData?.data) {
          const mimeType = part.inlineData.mimeType ?? "audio/pcm";
          const buf =
            typeof part.inlineData.data === "string"
              ? Buffer.from(part.inlineData.data, "base64")
              : Buffer.from(part.inlineData.data);
          this.emit("audio", { data: buf, mimeType });
        }

        if (part.text) {
          this.emit("text", { text: part.text });
          this.emit("transcript", { text: part.text, role: "assistant" as const });
        }

        if (part.functionCall) {
          const toolCall: RealtimeToolCall = {
            id: part.functionCall.id ?? part.functionCall.name,
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args ?? {}),
          };
          this.emit("tool_call", toolCall);
        }
      }
    }
  }
}

export class GoogleLiveProvider implements RealtimeProvider {
  readonly providerId = "google-live";
  readonly modelId: string;
  private apiKey?: string;

  constructor(modelId?: string, config?: GoogleLiveConfig) {
    this.modelId = modelId ?? "gemini-2.5-flash-native-audio-preview-12-2025";
    this.apiKey = config?.apiKey;
  }

  async connect(config: RealtimeSessionConfig): Promise<RealtimeConnection> {
    let GoogleGenAI: any;
    let Modality: any;
    try {
      const mod = _require("@google/genai");
      GoogleGenAI = mod.GoogleGenAI;
      Modality = mod.Modality;
    } catch (e: any) {
      if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error(
          "@google/genai package is required for GoogleLiveProvider. Install it: npm install @google/genai",
        );
      }
      throw e;
    }

    const key = config.apiKey ?? this.apiKey ?? process.env.GOOGLE_API_KEY;
    if (!key) {
      throw new Error("No Google API key provided for live connection. Set GOOGLE_API_KEY env var or pass apiKey.");
    }

    const ai = new GoogleGenAI({ apiKey: key });

    const liveConfig: Record<string, unknown> = {
      responseModalities: [Modality.AUDIO],
    };

    if (config.instructions) {
      liveConfig.systemInstruction = config.instructions;
    }

    if (config.voice) {
      liveConfig.speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice } } };
    }

    if (config.temperature !== undefined) {
      liveConfig.temperature = config.temperature;
    }

    if (config.tools && config.tools.length > 0) {
      liveConfig.tools = [
        {
          functionDeclarations: config.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ];
    }

    const connection = new GoogleLiveConnection(null as any);

    return new Promise<RealtimeConnection>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Google Live connection timed out after 15s"));
      }, 15_000);

      ai.live
        .connect({
          model: this.modelId,
          config: liveConfig,
          callbacks: {
            onopen: () => {
              clearTimeout(timeout);
              connection.emit("connected", {});
            },
            onmessage: (message: any) => {
              connection._handleMessage(message);
            },
            onerror: (e: any) => {
              const err = e?.error ?? e?.message ?? e;
              const error = err instanceof Error ? err : new Error(String(err));
              connection.emit("error", { error });
            },
            onclose: () => {
              connection.emit("disconnected", {});
            },
          },
        })
        .then((session: any) => {
          // Patch the connection with the actual session
          (connection as any).session = session;
          resolve(connection);
        })
        .catch((err: Error) => {
          clearTimeout(timeout);
          reject(err);
        });
    });
  }
}
