import type { VoiceAgent, VoiceSession } from "@agentium/core";

export interface VoiceGatewayOptions {
  agents: Record<string, VoiceAgent>;
  io: any;
  namespace?: string;
  /** Establish trusted identity in socket.data.auth {userId,tenantId,sessionId}. */
  authMiddleware?: (socket: any, next: (err?: Error) => void) => void;
  maxAudioFrameBytes?: number;
  maxPendingAudioBytes?: number;
  playbackAckTimeoutMs?: number;
}

/** Bounded per-connection audio delivery; each output frame must be acknowledged by the client. */
export function createVoiceGateway(opts: VoiceGatewayOptions): void {
  const maxFrame = opts.maxAudioFrameBytes ?? 256 * 1024;
  const maxPending = opts.maxPendingAudioBytes ?? 1024 * 1024;
  const ackMs = opts.playbackAckTimeoutMs ?? 10_000;
  if (![maxFrame, maxPending, ackMs].every((n) => Number.isSafeInteger(n) && n > 0))
    throw new Error("Invalid voice gateway bounds");
  const ns = opts.io.of(opts.namespace ?? "/agentium-voice");
  if (opts.authMiddleware) ns.use(opts.authMiddleware);
  ns.on("connection", (socket: any) => {
    let session: VoiceSession | undefined;
    let controller: AbortController | undefined;
    let disconnected = false;
    let recovering = false;
    let pendingBytes = 0;
    let sequence = 0;
    const generations = new Set<string>();
    const pending = new Map<number, { bytes: number; generationId?: string; timer: ReturnType<typeof setTimeout> }>();
    const clearAudio = () => {
      for (const item of pending.values()) clearTimeout(item.timer);
      pending.clear();
      generations.clear();
      pendingBytes = 0;
    };
    const error = (message: string) => socket.emit("voice.error", { error: message });
    const stop = async () => {
      const old = session;
      session = undefined;
      recovering = false;
      controller?.abort();
      controller = undefined;
      clearAudio();
      await old?.close();
    };
    const fail = (message: string) => {
      error(message);
      void stop().catch(() => {});
    };
    socket.on(
      "voice.start",
      async (data: { agentName: string; userId?: string; sessionId?: string; apiKey?: string }) => {
        if (controller || session) return error("A voice session is already starting or active");
        const agent = opts.agents[data?.agentName];
        if (!agent) return error("Unknown voice agent");
        if (disconnected) return;
        const reservation = new AbortController();
        controller = reservation;
        try {
          const trusted = opts.authMiddleware ? socket.data?.auth : undefined;
          if (opts.authMiddleware && (!trusted || typeof trusted.userId !== "string" || !trusted.userId))
            throw new Error("Authenticated voice identity is missing");
          const created = await agent.connect({
            signal: reservation.signal,
            userId: trusted?.userId ?? data.userId,
            tenantId: trusted?.tenantId,
            sessionId: trusted?.sessionId ?? (opts.authMiddleware ? undefined : data.sessionId),
          });
          if (disconnected || reservation.signal.aborted || controller !== reservation) {
            await created.close();
            return;
          }
          session = created;
          recovering = false;
          created.on("audio", (ev) => {
            if (session !== created) return;
            if (ev.data.byteLength > maxFrame || pendingBytes + ev.data.byteLength > maxPending)
              return fail("Voice output backpressure limit exceeded");
            const id = sequence++;
            const timer = setTimeout(() => fail("Voice playback acknowledgement timed out"), ackMs);
            pending.set(id, { bytes: ev.data.byteLength, generationId: ev.generationId, timer });
            if (ev.generationId) generations.add(ev.generationId);
            pendingBytes += ev.data.byteLength;
            socket.emit("voice.audio", {
              data: ev.data.toString("base64"),
              mimeType: ev.mimeType ?? "audio/pcm",
              generationId: ev.generationId,
              sequence: id,
              format: agent.audioFormats.output,
            });
          });
          for (const event of [
            "transcript",
            "text",
            "usage",
            "generation_start",
            "turn_complete",
            "go_away",
            "session_resume",
          ] as const)
            created.on(event, (ev: unknown) => {
              if (session === created) socket.emit(`voice.${event}`, ev);
            });
          created.on("tool_call_start", (ev) => {
            if (session === created) socket.emit("voice.tool.call", ev);
          });
          created.on("recovery", (state) => {
            if (session !== created) return;
            recovering = state.status !== "recovered";
            socket.emit("voice.recovery", state);
          });
          created.on("tool_result", (ev) => {
            if (session === created) socket.emit("voice.tool.result", ev);
          });
          created.on("interrupted", () => {
            if (session !== created) return;
            clearAudio();
            socket.emit("voice.clear");
            socket.emit("voice.interrupted");
          });
          created.on("error", (ev) => {
            if (session === created) error(ev.error.message);
          });
          created.on("disconnected", () => {
            if (session === created) {
              session = undefined;
              recovering = false;
              controller = undefined;
              clearAudio();
              socket.emit("voice.stopped");
            }
          });
          socket.emit("voice.started", {
            userId: trusted?.userId ?? data.userId,
            formats: agent.audioFormats,
            playbackAcknowledgements: true,
          });
        } catch (cause) {
          if (controller === reservation) controller = undefined;
          if (!disconnected) error(cause instanceof Error ? cause.message : "Voice connection failed");
        }
      },
    );
    socket.on(
      "voice.playback.ack",
      (data: { sequence: number; generationId?: string; playedCharacters?: number; complete?: boolean }) => {
        const item = pending.get(data?.sequence);
        if (!item) return;
        if (data.generationId && data.generationId !== item.generationId) return fail("Playback generation mismatch");
        clearTimeout(item.timer);
        pending.delete(data.sequence);
        pendingBytes -= item.bytes;
        if (data.generationId && (data.complete || data.playedCharacters !== undefined))
          try {
            session?.acknowledgePlayback?.({
              generationId: data.generationId,
              playedCharacters: data.playedCharacters,
              complete: data.complete,
            });
            if (data.complete) generations.delete(data.generationId);
          } catch {
            fail("Invalid playback acknowledgement");
          }
      },
    );
    socket.on("voice.playback.complete", (data: { generationId: string }) => {
      if (typeof data?.generationId !== "string" || !generations.has(data.generationId)) return;
      try {
        session?.acknowledgePlayback?.({ generationId: data.generationId, complete: true });
        generations.delete(data.generationId);
      } catch {
        fail("Invalid playback completion");
      }
    });
    socket.on("voice.audio", (data: { data: string }) => {
      // Capture may continue while reconnecting; discard frames instead of buffering/replaying them.
      if (!session || recovering || typeof data?.data !== "string") return;
      if (
        data.data.length > Math.ceil(maxFrame / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.data)
      )
        return fail("Invalid or oversized audio frame");
      try {
        const bytes = Buffer.from(data.data, "base64");
        if (!bytes.length || bytes.byteLength > maxFrame) throw new Error();
        session.sendAudio(bytes);
      } catch {
        fail("Invalid audio frame");
      }
    });
    socket.on("voice.text", (data: { text: string }) => {
      if (!session) return;
      if (recovering) return error("Voice session is recovering; retry text after voice.recovery reports recovered");
      if (typeof data?.text !== "string" || data.text.length > 10_000) return fail("Invalid voice text");
      try {
        session.sendText(data.text);
      } catch {
        fail("Voice text failed");
      }
    });
    socket.on("voice.commit", () => {
      if (recovering) return;
      try {
        session?.commitAudio();
      } catch {
        fail("Voice input commit failed");
      }
    });
    socket.on("voice.interrupt", () => {
      clearAudio();
      try {
        session?.interrupt();
      } catch {
        fail("Voice interruption failed");
      }
      socket.emit("voice.clear");
    });
    socket.on("voice.stop", async () => {
      try {
        await stop();
        socket.emit("voice.stopped");
      } catch {
        error("Voice close failed");
      }
    });
    socket.on("disconnect", () => {
      disconnected = true;
      void stop().catch(() => {});
    });
  });
}
