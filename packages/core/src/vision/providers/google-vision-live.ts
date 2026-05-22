import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type {
  VisionConnection,
  VisionEvent,
  VisionEventMap,
  VisionProvider,
  VisionSessionConfig,
  VisionToolCall,
} from "../types.js";

const _require = createRequire(import.meta.url);

export interface GoogleVisionLiveConfig {
  apiKey?: string;
}

class GoogleVisionLiveConnection extends EventEmitter implements VisionConnection {
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

  sendImage(data: Buffer, mimeType = "image/jpeg"): void {
    if (this.closed) return;
    this.session.sendRealtimeInput({
      video: {
        data: data.toString("base64"),
        mimeType,
      },
    });
  }

  sendText(text: string): void {
    if (this.closed) return;
    this.session.sendRealtimeInput({ text });
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
    // Gemini Live API handles interruption automatically via VAD.
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.session.close();
    } catch (err) {
      console.warn("[agentium/google-vision-live] Error closing session:", err instanceof Error ? err.message : err);
    }
    this.emit("disconnected", {});
  }

  on<K extends VisionEvent>(event: K, handler: (data: VisionEventMap[K]) => void): this {
    return super.on(event, handler as any);
  }

  off<K extends VisionEvent>(event: K, handler: (data: VisionEventMap[K]) => void): this {
    return super.off(event, handler as any);
  }

  _handleMessage(message: any): void {
    const keys = Object.keys(message || {});
    console.log(`[GoogleVisionLive] Message received: ${keys.join(", ")}`);

    if (message.serverContent?.interrupted) {
      this.emit("interrupted", {});
      return;
    }

    if (message.toolCall?.functionCalls) {
      for (const fc of message.toolCall.functionCalls) {
        const toolCall: VisionToolCall = {
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
          const mime = part.inlineData.mimeType ?? "audio/pcm";
          const buf =
            typeof part.inlineData.data === "string"
              ? Buffer.from(part.inlineData.data, "base64")
              : Buffer.from(part.inlineData.data);
          this.emit("audio", { data: buf, mimeType: mime });
        }

        if (part.text) {
          this.emit("text", { text: part.text });
          this.emit("transcript", { text: part.text, role: "assistant" as const });
        }

        if (part.functionCall) {
          const toolCall: VisionToolCall = {
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

/**
 * Vision-capable provider using Gemini 3.1 Flash Live.
 * Supports audio + video frame input via the Live API.
 */
export class GoogleVisionLiveProvider implements VisionProvider {
  readonly providerId = "google-vision-live";
  readonly modelId: string;
  private apiKey?: string;

  constructor(modelId?: string, config?: GoogleVisionLiveConfig) {
    this.modelId = modelId ?? "gemini-3.1-flash-live-preview";
    console.log(`[GoogleVisionLive] Using model: ${this.modelId}`);
    this.apiKey = config?.apiKey;
  }

  async connect(config: VisionSessionConfig): Promise<VisionConnection> {
    let GoogleGenAI: any;
    let Modality: any;
    try {
      const mod = _require("@google/genai");
      GoogleGenAI = mod.GoogleGenAI;
      Modality = mod.Modality;
    } catch (e: any) {
      if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error(
          "@google/genai package is required for GoogleVisionLiveProvider. Install it: npm install @google/genai",
        );
      }
      throw e;
    }

    const key = config.apiKey ?? this.apiKey ?? process.env.GOOGLE_API_KEY;
    if (!key) {
      throw new Error("No Google API key provided. Set GOOGLE_API_KEY env var or pass apiKey.");
    }

    const ai = new GoogleGenAI({ apiKey: key });

    const liveConfig: Record<string, unknown> = {
      responseModalities: [Modality.AUDIO],
    };

    if (config.instructions) {
      liveConfig.systemInstruction = config.instructions;
    }

    if (config.voice || config.language) {
      const speechConfig: Record<string, unknown> = {};
      if (config.voice) {
        speechConfig.voiceConfig = { prebuiltVoiceConfig: { voiceName: config.voice } };
      }
      if (config.language) {
        speechConfig.languageCode = config.language;
      }
      liveConfig.speechConfig = speechConfig;
    }

    if (config.temperature !== undefined) {
      liveConfig.temperature = config.temperature;
    }

    if (config.thinkingLevel && this.modelId.includes("3.1")) {
      liveConfig.thinkingConfig = { thinkingLevel: config.thinkingLevel.toUpperCase() };
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

    const connection = new GoogleVisionLiveConnection(null as any);

    return new Promise<VisionConnection>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Google Vision Live connection timed out after 15s"));
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
              console.error("[GoogleVisionLive] WebSocket error:", error.message);
              connection.emit("error", { error });
            },
            onclose: (e: any) => {
              console.log("[GoogleVisionLive] WebSocket closed:", e?.code ?? "unknown", e?.reason ?? "");
              connection.emit("disconnected", {});
            },
          },
        })
        .then((session: any) => {
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
