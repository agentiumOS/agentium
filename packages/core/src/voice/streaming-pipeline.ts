import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { RunOpts } from "../agent/types.js";
import type { StreamChunk } from "../models/types.js";
import {
  type AudioFrame,
  type PlaybackAck,
  type SpeechRecognizer,
  type SpeechRecognizerSession,
  type SpeechSynthesizer,
  type SpeechSynthesizerSession,
  type TranscriptEvent,
  type VoiceBrain,
  type VoiceBrainInput,
  type VoiceTransport,
  validateAudioFrame,
} from "./speech-types.js";
import { TurnCoordinator } from "./turn-coordinator.js";

/** Structural Agent adapter: the coordinator owns history, this Agent must have session memory disabled. */
export class AgentVoiceBrain implements VoiceBrain {
  constructor(
    private agent: { readonly memory?: unknown; stream(input: string, opts?: RunOpts): AsyncIterable<StreamChunk> },
    private scope: Pick<RunOpts, "userId" | "tenantId" | "dependencies"> = {},
  ) {
    if (agent.memory)
      throw new Error(
        "AgentVoiceBrain requires an Agent without memory; the voice coordinator owns playback-confirmed conversation history",
      );
  }
  async *respond(input: VoiceBrainInput, signal: AbortSignal): AsyncGenerator<{ type: "text"; text: string }> {
    const history = input.history.slice();
    if (history.at(-1)?.role === "user" && history.at(-1)?.content === input.text) history.pop();
    for await (const chunk of this.agent.stream(input.text, {
      ...this.scope,
      sessionId: input.sessionId,
      history,
      ephemeral: true,
      signal,
    })) {
      signal.throwIfAborted();
      if (chunk.type === "text" && chunk.text) yield { type: "text", text: chunk.text };
    }
  }
}
export interface StreamingVoicePipelineConfig {
  recognizer: SpeechRecognizer;
  synthesizer: SpeechSynthesizer;
  brain: VoiceBrain;
  transport: VoiceTransport;
  sessionId?: string;
  language?: string;
  voice?: string;
  maxTurnMs?: number;
}
/** Streaming recognition -> existing Agent runtime -> streamed synthesis; one generation owns all downstream work. */
export class StreamingVoicePipeline extends EventEmitter {
  readonly coordinator: TurnCoordinator;
  private input?: SpeechRecognizerSession;
  private controller = new AbortController();
  private synthesis?: SpeechSynthesizerSession;
  private activeWork?: Promise<void>;
  private closePromise?: Promise<void>;
  private synthesisClosures = new WeakMap<SpeechSynthesizerSession, Promise<void>>();
  private opened = false;
  private closed = false;
  private lastInputSequence = -1;
  readonly timings: Array<{ turnId: string; firstTextMs?: number; firstAudioMs?: number; durationMs: number }> = [];
  constructor(private config: StreamingVoicePipelineConfig) {
    super();
    this.coordinator = new TurnCoordinator(config.sessionId);
    this.on("error", () => {});
    if (config.maxTurnMs !== undefined && (!Number.isFinite(config.maxTurnMs) || config.maxTurnMs <= 0))
      throw new Error("Invalid voice turn timeout");
  }
  async open(): Promise<void> {
    if (this.closed || this.opened) throw new Error("Voice pipeline is closed or already opened");
    this.opened = true;
    const input = await this.config.recognizer.open(
      {
        format: this.config.transport.inputFormat,
        sessionId: this.coordinator.sessionId,
        turnId: "input",
        generationId: randomUUID(),
        language: this.config.language,
      },
      this.controller.signal,
    );
    if (this.closed) {
      await input.close();
      throw new Error("Voice pipeline closed during input initialization");
    }
    this.input = input;
    void (async () => {
      try {
        for await (const event of input.events) {
          if (this.closed) return;
          void this.submitTranscript(event).catch((error) => this.emit("error", error));
        }
      } catch (error) {
        if (!this.closed) this.emit("error", error);
      }
    })();
  }
  async sendAudio(frame: AudioFrame): Promise<void> {
    if (!this.input || this.closed) throw new Error("Voice input is not open");
    validateAudioFrame(frame, this.config.transport.inputFormat);
    if (frame.sequence <= this.lastInputSequence) throw new Error("Duplicate or out-of-order input audio");
    this.lastInputSequence = frame.sequence;
    await this.input.sendAudio(frame);
  }
  async flushInput(): Promise<void> {
    if (!this.input || this.closed) throw new Error("Voice input is not open");
    await this.input.flush();
  }
  async submitTranscript(event: TranscriptEvent): Promise<void> {
    if (this.closed || event.role !== "user") return;
    if (this.coordinator.isCommitted(event.segmentId)) return;
    this.emit("transcript", event);
    if (event.text.trim() && this.coordinator.generationId)
      void this.interrupt().catch((error) => this.emit("error", error));
    if (!this.coordinator.transcript(event)) return;
    const turn = this.coordinator.begin();
    const started = Date.now();
    const timing: { turnId: string; firstTextMs?: number; firstAudioMs?: number; durationMs: number } = {
      turnId: turn.turnId,
      durationMs: 0,
    };
    const timer = setTimeout(() => {
      if (this.coordinator.generationId === turn.generationId)
        void this.interrupt().catch((error) => this.emit("error", error));
    }, this.config.maxTurnMs ?? 60_000);
    const work = (async () => {
      let synth: SpeechSynthesizerSession | undefined;
      try {
        synth = await this.config.synthesizer.open(
          {
            format: this.config.transport.outputFormat,
            sessionId: this.coordinator.sessionId,
            ...turn,
            language: this.config.language,
            voice: this.config.voice,
          },
          turn.signal,
        );
        if (!this.coordinator.accepts(turn.generationId)) {
          return;
        }
        this.synthesis = synth;
        const playback = (async () => {
          for await (const frame of synth!.frames) {
            if (!this.coordinator.accepts(frame.generationId)) continue;
            validateAudioFrame(frame, this.config.transport.outputFormat, 1024 * 1024);
            if (timing.firstAudioMs === undefined) timing.firstAudioMs = Date.now() - started;
            await this.config.transport.play(frame, turn.signal);
          }
        })();
        // Observe rejection immediately while the brain may still be producing text.
        void playback.catch((error) => {
          if (this.coordinator.generationId === turn.generationId) {
            this.emit("error", error);
            void this.interrupt().catch((failure) => this.emit("error", failure));
          }
        });
        for await (const chunk of this.config.brain.respond(
          {
            text: event.text,
            history: this.coordinator.getHistory(),
            sessionId: this.coordinator.sessionId,
            turnId: turn.turnId,
            generationId: turn.generationId,
          },
          turn.signal,
        )) {
          if (!this.coordinator.accepts(turn.generationId)) return;
          if (chunk.type !== "text" || !chunk.text) continue;
          if (timing.firstTextMs === undefined) timing.firstTextMs = Date.now() - started;
          this.coordinator.appendText(turn.generationId, chunk.text);
          this.emit("text", { ...turn, text: chunk.text });
          await synth.sendText(chunk.text);
        }
        if (!this.coordinator.accepts(turn.generationId)) return;
        await synth.flush();
        await playback;
        this.coordinator.generated(turn.generationId);
        this.emit("generation_end", { turnId: turn.turnId, generationId: turn.generationId });
        if (!this.config.transport.playbackAcknowledgements) this.coordinator.finish(false);
      } catch (error) {
        if (!turn.signal.aborted) {
          this.coordinator.finish(true);
          throw error;
        }
      } finally {
        clearTimeout(timer);
        if (synth) await this.closeSynthesis(synth);
        if (this.synthesis === synth) this.synthesis = undefined;
        timing.durationMs = Date.now() - started;
        this.timings.push(timing);
        if (this.timings.length > 200) this.timings.shift();
      }
    })();
    this.activeWork = work;
    await work;
  }
  acknowledgePlayback(ack: PlaybackAck): void {
    this.coordinator.acknowledge(ack);
    if (ack.complete && this.coordinator.generationId === ack.generationId) this.coordinator.finish(false);
  }
  private closeSynthesis(session: SpeechSynthesizerSession): Promise<void> {
    let closing = this.synthesisClosures.get(session);
    if (!closing) {
      closing = Promise.resolve().then(() => session.close());
      this.synthesisClosures.set(session, closing);
    }
    return closing;
  }
  async interrupt(): Promise<void> {
    const generationId = this.coordinator.generationId;
    this.coordinator.finish(true);
    const synthesis = this.synthesis;
    this.synthesis = undefined;
    // Clear queued playback immediately, independently of provider cleanup.
    const results = await Promise.allSettled([
      generationId ? Promise.resolve().then(() => this.config.transport.clear(generationId)) : undefined,
      synthesis ? this.closeSynthesis(synthesis) : undefined,
    ]);
    this.emit("interrupted", { generationId });
    const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, "Voice interruption cleanup failed");
  }
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.controller.abort();
    const input = this.input;
    this.input = undefined;
    this.closePromise = (async () => {
      const results = await Promise.allSettled([this.interrupt(), Promise.resolve().then(() => input?.close())]);
      // Do not await arbitrary noncooperating provider code: generation IDs suppress its output.
      void this.activeWork?.catch(() => {});
      const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (failures.length) throw new AggregateError(failures, "Voice pipeline cleanup failed");
    })();
    return this.closePromise;
  }
}
