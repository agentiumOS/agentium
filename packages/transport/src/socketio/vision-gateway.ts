import type { VisionAgent } from "@agentium/core";

export interface VisionGatewayOptions {
  agents: Record<string, VisionAgent>;
  io: any;
  namespace?: string;
  authMiddleware?: (socket: any, next: (err?: Error) => void) => void;
}

export function createVisionGateway(opts: VisionGatewayOptions): void {
  const ns = opts.io.of(opts.namespace ?? "/agentium-vision");

  if (opts.authMiddleware) {
    ns.use(opts.authMiddleware);
  }

  const activeSessions = new Map<string, any>();

  ns.on("connection", (socket: any) => {
    socket.on(
      "vision.start",
      async (data: { agentName: string; apiKey?: string; userId?: string; sessionId?: string }) => {
        const agent = opts.agents[data.agentName];
        if (!agent) {
          socket.emit("vision.error", { error: `Vision agent "${data.agentName}" not found` });
          return;
        }

        if (activeSessions.has(socket.id)) {
          socket.emit("vision.error", { error: "A vision session is already active for this connection" });
          return;
        }

        try {
          const apiKey = data.apiKey ?? socket.handshake?.auth?.apiKey;
          const userId = data.userId ?? socket.handshake?.auth?.userId;
          const sessionId = data.sessionId ?? socket.handshake?.auth?.sessionId;

          const session = await agent.connect({ apiKey, userId, sessionId });
          activeSessions.set(socket.id, session);

          session.on("audio", (ev: { data: Buffer; mimeType?: string }) => {
            socket.emit("vision.audio", {
              data: ev.data.toString("base64"),
              mimeType: ev.mimeType ?? "audio/pcm",
            });
          });

          session.on("transcript", (ev: { text: string; role: string }) => {
            socket.emit("vision.transcript", { text: ev.text, role: ev.role });
          });

          session.on("text", (ev: { text: string }) => {
            socket.emit("vision.text", { text: ev.text });
          });

          session.on("tool_call_start", (ev: { name: string; args: unknown }) => {
            socket.emit("vision.tool.call", { name: ev.name, args: ev.args });
          });

          session.on("tool_result", (ev: { name: string; result: string }) => {
            socket.emit("vision.tool.result", { name: ev.name, result: ev.result });
          });

          session.on("usage", (ev: any) => {
            socket.emit("vision.usage", ev);
          });

          session.on("interrupted", () => {
            socket.emit("vision.interrupted");
          });

          session.on("error", (ev: { error: Error }) => {
            socket.emit("vision.error", { error: ev.error.message });
          });

          session.on("disconnected", () => {
            activeSessions.delete(socket.id);
            socket.emit("vision.stopped");
          });

          socket.emit("vision.started", { userId });
        } catch (error: any) {
          socket.emit("vision.error", { error: error.message });
        }
      },
    );

    socket.on("vision.audio", (data: { data: string }) => {
      const session = activeSessions.get(socket.id);
      if (!session) return;
      if (typeof data?.data !== "string" || data.data.length > 1_000_000) return;
      try {
        session.sendAudio(Buffer.from(data.data, "base64"));
      } catch {
        socket.emit("vision.error", { error: "Invalid audio data" });
      }
    });

    socket.on("vision.image", (data: { data: string; mimeType?: string }) => {
      const session = activeSessions.get(socket.id);
      if (!session) return;
      if (typeof data?.data !== "string" || data.data.length > 5_000_000) return;
      try {
        session.sendImage(Buffer.from(data.data, "base64"), data.mimeType ?? "image/jpeg");
      } catch {
        socket.emit("vision.error", { error: "Invalid image data" });
      }
    });

    socket.on("vision.text", (data: { text: string }) => {
      const session = activeSessions.get(socket.id);
      if (!session) return;
      if (typeof data?.text !== "string" || data.text.length > 10_000) return;
      session.sendText(data.text);
    });

    socket.on("vision.interrupt", () => {
      const session = activeSessions.get(socket.id);
      if (!session) return;
      session.interrupt();
    });

    socket.on("vision.stop", async () => {
      const session = activeSessions.get(socket.id);
      if (!session) return;
      try {
        await session.close();
      } catch (err) {
        console.warn("[vision-gateway] Error closing session:", err);
      }
      activeSessions.delete(socket.id);
      socket.emit("vision.stopped");
    });

    socket.on("disconnect", async () => {
      const session = activeSessions.get(socket.id);
      if (session) {
        try {
          await session.close();
        } catch (err) {
          console.warn(
            "[agentium/vision-gateway] Error closing session on disconnect:",
            err instanceof Error ? err.message : err,
          );
        }
        activeSessions.delete(socket.id);
      }
    });
  });
}
