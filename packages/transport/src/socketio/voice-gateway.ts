import type { VoiceAgent } from "@agentium/core";

export interface VoiceGatewayOptions {
  agents: Record<string, VoiceAgent>;
  io: any;
  namespace?: string;
  authMiddleware?: (socket: any, next: (err?: Error) => void) => void;
}

export function createVoiceGateway(opts: VoiceGatewayOptions): void {
  const ns = opts.io.of(opts.namespace ?? "/agentium-voice");

  if (opts.authMiddleware) {
    ns.use(opts.authMiddleware);
  }

  const activeSessions = new Map<string, any>();

  ns.on("connection", (socket: any) => {
    socket.on(
      "voice.start",
      async (data: { agentName: string; apiKey?: string; userId?: string; sessionId?: string }) => {
        const agent = opts.agents[data.agentName];
        if (!agent) {
          socket.emit("voice.error", {
            error: `Voice agent "${data.agentName}" not found`,
          });
          return;
        }

        if (activeSessions.has(socket.id)) {
          socket.emit("voice.error", {
            error: "A voice session is already active for this connection",
          });
          return;
        }

        try {
          const apiKey = data.apiKey ?? socket.handshake?.auth?.apiKey;
          const userId = data.userId ?? socket.handshake?.auth?.userId;
          const sessionId = data.sessionId ?? socket.handshake?.auth?.sessionId;

          const session = await agent.connect({
            apiKey,
            userId,
            sessionId,
          });

          activeSessions.set(socket.id, session);

          session.on("audio", (ev: { data: Buffer; mimeType?: string }) => {
            socket.emit("voice.audio", {
              data: ev.data.toString("base64"),
              mimeType: ev.mimeType ?? "audio/pcm",
            });
          });

          session.on("transcript", (ev: { text: string; role: string }) => {
            socket.emit("voice.transcript", {
              text: ev.text,
              role: ev.role,
            });
          });

          session.on("text", (ev: { text: string }) => {
            socket.emit("voice.text", { text: ev.text });
          });

          session.on("tool_call_start", (ev: { name: string; args: unknown }) => {
            socket.emit("voice.tool.call", {
              name: ev.name,
              args: ev.args,
            });
          });

          session.on("tool_result", (ev: { name: string; result: string }) => {
            socket.emit("voice.tool.result", {
              name: ev.name,
              result: ev.result,
            });
          });

          session.on(
            "usage",
            (ev: {
              promptTokens: number;
              completionTokens: number;
              totalTokens: number;
              reasoningTokens?: number;
              cachedTokens?: number;
              audioInputTokens?: number;
              audioOutputTokens?: number;
              providerMetrics?: Record<string, unknown>;
            }) => {
              socket.emit("voice.usage", ev);
            },
          );

          session.on("interrupted", () => {
            socket.emit("voice.interrupted");
          });

          session.on("error", (ev: { error: Error }) => {
            socket.emit("voice.error", { error: ev.error.message });
          });

          session.on("disconnected", () => {
            activeSessions.delete(socket.id);
            socket.emit("voice.stopped");
          });

          socket.emit("voice.started", { userId });
        } catch (error: any) {
          socket.emit("voice.error", { error: error.message });
        }
      },
    );

    socket.on("voice.audio", (data: { data: string }) => {
      const session = activeSessions.get(socket.id);
      if (!session) return;
      if (typeof data?.data !== "string" || data.data.length > 1_000_000) return;
      try {
        session.sendAudio(Buffer.from(data.data, "base64"));
      } catch {
        socket.emit("voice.error", { error: "Invalid audio data" });
      }
    });

    socket.on("voice.text", (data: { text: string }) => {
      const session = activeSessions.get(socket.id);
      if (!session) return;
      if (typeof data?.text !== "string" || data.text.length > 10_000) return;
      session.sendText(data.text);
    });

    socket.on("voice.interrupt", () => {
      const session = activeSessions.get(socket.id);
      if (!session) return;
      session.interrupt();
    });

    socket.on("voice.stop", async () => {
      const session = activeSessions.get(socket.id);
      if (!session) return;
      try {
        await session.close();
      } catch (err) {
        console.warn("[voice-gateway] Error closing session:", err);
      }
      activeSessions.delete(socket.id);
      socket.emit("voice.stopped");
    });

    socket.on("disconnect", async () => {
      const session = activeSessions.get(socket.id);
      if (session) {
        try {
          await session.close();
        } catch (err) {
          console.warn(
            "[agentium/voice-gateway] Error closing session on disconnect:",
            err instanceof Error ? err.message : err,
          );
        }
        activeSessions.delete(socket.id);
      }
    });
  });
}
