import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { providerTokenUsage } from "../../models/usage-normalizers.js";
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

export interface GoogleLiveConfig {
  apiKey?: string;
}

export class GoogleLiveConnection extends EventEmitter implements RealtimeConnection {
  private session: any;
  readonly toolContinuation = "provider" as const;
  private closed = false;
  get connectionState(): "open" | "closed" {
    return this.closed ? "closed" : "open";
  }
  private calls = new Map<string, string>();
  private turn = 0;
  private generationStarted = false;
  private suppressed = false;
  private transcripts = { user: "", assistant: "" };

  private audioStarted = false;
  constructor(
    session: any,
    private manualActivity = false,
  ) {
    super();
    this.session = session;
  }

  sendAudio(data: Buffer): void {
    if (this.closed) return;
    if (this.manualActivity && !this.audioStarted) {
      this.session.sendRealtimeInput({ activityStart: {} });
      this.audioStarted = true;
    }
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

  sendImage(image: Buffer | string, opts?: { mimeType?: string; text?: string }): void {
    if (this.closed) return;
    const data =
      typeof image === "string" && !image.startsWith("data:")
        ? image
        : Buffer.isBuffer(image)
          ? image.toString("base64")
          : image.replace(/^data:[^;]+;base64,/, "");
    this.session.sendRealtimeInput({
      media: { data, mimeType: opts?.mimeType ?? "image/jpeg" },
    });
    if (opts?.text) this.sendText(opts.text);
  }

  createResponse(_opts?: CreateResponseOpts): void {
    if (this.closed) return;
    throw new Error("Gemini Live owns continuation; send user input or a tool response instead");
  }

  commitAudio(): void {
    if (this.closed) return;
    this.session.sendRealtimeInput(this.manualActivity ? { activityEnd: {} } : { audioStreamEnd: true });
    this.audioStarted = false;
  }

  sendToolResult(callId: string, result: string): void {
    if (this.closed) return;
    let responseObj: unknown;
    try {
      responseObj = JSON.parse(result);
    } catch {
      responseObj = { result };
    }

    const name = this.calls.get(callId);
    if (!name) throw new Error("Unknown or already completed Gemini tool call");
    this.calls.delete(callId);
    this.session.sendToolResponse({
      functionResponses: [
        {
          id: callId,
          name,
          response: responseObj,
        },
      ],
    });
  }

  interrupt(): void {
    // Local cancellation: Gemini has no explicit server response.cancel command.
    this.suppressed = true;
    this.calls.clear();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.session?.close();
    } catch (err) {
      console.warn("[agentium/google-live] Error closing session:", err instanceof Error ? err.message : err);
    }
    this.emit("disconnected", {});
  }

  /** Internal: transport closure must also fence delayed SDK callbacks. */
  _disconnected(): void {
    if (this.closed) return;
    this.closed = true;
    this.calls.clear();
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
    if (this.closed) return;
    if (message.serverContent && !this.generationStarted) {
      this.generationStarted = true;
      this.emit("generation_start", { generationId: `google:${this.turn}` });
    }
    if (message.serverContent?.interrupted) {
      this.calls.clear();
      this.emit("interrupted", {});
    }

    if (!this.suppressed && message.toolCall?.functionCalls) {
      for (const fc of message.toolCall.functionCalls) {
        const toolCall: RealtimeToolCall = {
          id: fc.id ?? fc.name,
          name: fc.name,
          arguments: JSON.stringify(fc.args ?? {}),
        };
        if (!this.calls.has(toolCall.id)) {
          this.calls.set(toolCall.id, toolCall.name);
          this.emit("tool_call", toolCall);
        }
      }
    }

    if (!this.suppressed && message.serverContent?.modelTurn?.parts) {
      for (const part of message.serverContent.modelTurn.parts) {
        if (part.inlineData?.data) {
          const mimeType = part.inlineData.mimeType ?? "audio/pcm";
          const buf =
            typeof part.inlineData.data === "string"
              ? Buffer.from(part.inlineData.data, "base64")
              : Buffer.from(part.inlineData.data);
          this.emit("audio", { data: buf, mimeType, generationId: `google:${this.turn}` });
        }

        if (part.text && !part.thought) {
          this.emit("text", { text: part.text });
          // Spoken transcript is provided by outputTranscription, not model thought/text parts.
        }

        if (part.functionCall) {
          const toolCall: RealtimeToolCall = {
            id: part.functionCall.id ?? part.functionCall.name,
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args ?? {}),
          };
          if (!this.calls.has(toolCall.id)) {
            this.calls.set(toolCall.id, toolCall.name);
            this.emit("tool_call", toolCall);
          }
        }
      }
    }
    for (const [key, role] of [
      ["inputTranscription", "user"],
      ["outputTranscription", "assistant"],
    ] as const) {
      const value = message.serverContent?.[key];
      if (value?.text && (!this.suppressed || role === "user")) {
        this.transcripts[role] += value.text;
        this.emit("transcript", {
          text: this.transcripts[role],
          role,
          kind: "partial",
          segmentId: `google:${this.turn}:${role}`,
          generationId: `google:${this.turn}`,
        });
      }
    }
    if (message.serverContent?.turnComplete) {
      for (const role of ["user", "assistant"] as const)
        if (this.transcripts[role] && (!this.suppressed || role === "user"))
          this.emit("transcript", {
            text: this.transcripts[role],
            role,
            kind: "final",
            segmentId: `google:${this.turn}:${role}`,
            generationId: `google:${this.turn}`,
          });
      this.emit("turn_complete", { generationId: `google:${this.turn}` });
      this.transcripts = { user: "", assistant: "" };
      this.turn++;
      this.generationStarted = false;
      this.suppressed = false;
    }
    if (message.usageMetadata) {
      const usage = providerTokenUsage("google", "live", message.usageMetadata);
      if (usage.accounting) {
        usage.accounting.context = { ...usage.accounting.context, api: "live" };
        usage.accounting.coverage.unsupportedFeatures.push("live_modality_and_snapshot_semantics");
      }
      this.emit("usage", usage);
    }
    if (message.goAway) this.emit("go_away", { timeLeft: message.goAway.timeLeft });
    if (message.sessionResumptionUpdate)
      this.emit("session_resume", {
        handle: message.sessionResumptionUpdate.newHandle,
        resumable: message.sessionResumptionUpdate.resumable === true,
      });
  }
}

export class GoogleLiveProvider implements RealtimeProvider {
  readonly providerId = "google-live";
  readonly capabilities = {
    manualCommit: true,
    images: true,
    asyncTools: true,
    transcripts: true,
    resume: true,
    recovery: "session-resumption" as const,
    inputSampleRateHz: 16000,
    outputSampleRateHz: 24000,
  };
  readonly modelId: string;
  private apiKey?: string;

  constructor(modelId?: string, config?: GoogleLiveConfig) {
    this.modelId = modelId ?? "gemini-3.8-live";
    this.apiKey = config?.apiKey;
  }

  async connect(config: RealtimeSessionConfig): Promise<RealtimeConnection> {
    config.signal?.throwIfAborted();
    if ((config as unknown as { prompt?: unknown }).prompt !== undefined)
      throw new Error("Realtime prompt objects are no longer supported; resolve them to app-owned instructions");
    if (
      config.mcpServers?.length ||
      (config.reasoningEffort && config.reasoningEffort !== "none") ||
      (config.inputAudioFormat && config.inputAudioFormat !== "pcm16") ||
      (config.outputAudioFormat && config.outputAudioFormat !== "pcm16")
    )
      throw new Error("Unsupported Gemini Live option; use local instructions and PCM16 audio");
    if (
      config.turnDetection?.type === "semantic_vad" ||
      config.turnDetection?.createResponse === false ||
      (config.turnDetection?.type === "server_vad" &&
        (config.turnDetection.threshold !== undefined || config.turnDetection.idleTimeoutMs !== undefined)) ||
      config.noiseReduction ||
      config.transcriptionModel ||
      config.transcriptionContext ||
      config.translation ||
      config.safetyIdentifier
    )
      throw new Error("Unsupported Gemini Live setting; use its automatic VAD or null for manual activity");
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
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };
    if (config.sessionResumption) {
      if (config.sessionResumption.handle !== undefined && !config.sessionResumption.handle)
        throw new Error("Gemini session resumption handle must be nonempty");
      liveConfig.sessionResumption = { ...config.sessionResumption };
    }

    if (config.turnDetection === null)
      liveConfig.realtimeInputConfig = { automaticActivityDetection: { disabled: true } };
    else if (config.turnDetection?.type === "server_vad")
      liveConfig.realtimeInputConfig = {
        activityHandling:
          config.turnDetection.interruptResponse === false ? "NO_INTERRUPTION" : "START_OF_ACTIVITY_INTERRUPTS",
        automaticActivityDetection: {
          disabled: false,
          ...(config.turnDetection.prefixPaddingMs === undefined
            ? {}
            : { prefixPaddingMs: config.turnDetection.prefixPaddingMs }),
          ...(config.turnDetection.silenceDurationMs === undefined
            ? {}
            : { silenceDurationMs: config.turnDetection.silenceDurationMs }),
        },
      };
    if (config.maxResponseOutputTokens !== undefined) {
      if (config.maxResponseOutputTokens === "inf") throw new Error("Gemini maxResponseOutputTokens must be finite");
      liveConfig.maxOutputTokens = config.maxResponseOutputTokens;
    }
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

    const connection = new GoogleLiveConnection(null as any, config.turnDetection === null);

    return new Promise<RealtimeConnection>((resolve, reject) => {
      let expired = false;
      const fail = (error: Error) => {
        expired = true;
        clearTimeout(timeout);
        connection._disconnected();
        reject(error);
      };
      const timeout = setTimeout(() => fail(new Error("Google Live connection timed out after 15s")), 15_000);
      const abort = () => {
        void connection.close();
        fail(new Error("Gemini connection cancelled"));
      };
      config.signal?.addEventListener("abort", abort, { once: true });
      connection.once("disconnected", () => config.signal?.removeEventListener("abort", abort));
      if (config.signal?.aborted) {
        abort();
        return;
      }

      ai.live
        .connect({
          model: this.modelId,
          config: liveConfig,
          callbacks: {
            onopen: () => {
              connection.emit("connected", {});
            },
            onmessage: (message: any) => {
              connection._handleMessage(message);
            },
            onerror: (e: any) => {
              const err = e?.error ?? e?.message ?? e;
              const error = err instanceof Error ? err : new Error(String(err));
              if (connection.listenerCount("error")) connection.emit("error", { error });
              else fail(error);
            },
            onclose: () => fail(new Error("Gemini connection closed")),
          },
        })
        .then((session: any) => {
          clearTimeout(timeout);
          if (expired || config.signal?.aborted) {
            session.close();
            reject(new Error("Gemini connection cancelled"));
            return;
          }
          (connection as any).session = session;
          resolve(connection);
        })
        .catch((err: Error) => {
          fail(err);
        });
    });
  }
}
