import { randomUUID } from "node:crypto";
import type { ChatMessage } from "../models/types.js";
import type { PlaybackAck, TranscriptEvent, VoiceTurnRecord } from "./speech-types.js";

/** One owner for committed speech, generation cancellation, and playback-confirmed history. */
export class TurnCoordinator {
  private segments = new Map<string, TranscriptEvent>();
  private history: ChatMessage[] = [];
  private active?: {
    controller: AbortController;
    record: VoiceTurnRecord;
    heardCharacters: number;
    complete: boolean;
    outputDone: boolean;
  };
  readonly records: VoiceTurnRecord[] = [];
  staleFrames = 0;
  constructor(
    readonly sessionId: string = randomUUID(),
    private maxHistoryMessages = 200,
    private maxTextChars = 64_000,
  ) {}
  isCommitted(segmentId: string): boolean {
    return this.segments.get(segmentId)?.kind === "final";
  }
  generated(generationId: string): void {
    if (this.active?.record.generationId === generationId) this.active.outputDone = true;
  }
  transcript(event: TranscriptEvent): boolean {
    if (!event.segmentId || typeof event.text !== "string" || event.text.length > this.maxTextChars)
      throw new Error("Invalid transcript segment");
    if (this.segments.get(event.segmentId)?.kind === "final") return false;
    this.segments.set(event.segmentId, { ...event });
    if (this.segments.size > 1024) this.segments.delete(this.segments.keys().next().value!);
    if (event.kind !== "final" || !event.text.trim()) return false;
    this.addHistory({ role: event.role, content: event.text });
    return true;
  }
  begin(): { turnId: string; generationId: string; signal: AbortSignal } {
    this.finish(true);
    const record: VoiceTurnRecord = {
      turnId: randomUUID(),
      generationId: randomUUID(),
      generatedText: "",
      heardText: "",
      delivery: "unknown",
      interrupted: false,
    };
    this.active = { controller: new AbortController(), record, heardCharacters: 0, complete: false, outputDone: false };
    return { turnId: record.turnId, generationId: record.generationId, signal: this.active.controller.signal };
  }
  get generationId(): string | undefined {
    return this.active?.record.generationId;
  }
  accepts(generationId: string): boolean {
    const accepted = this.active?.record.generationId === generationId && !this.active.controller.signal.aborted;
    if (!accepted) this.staleFrames++;
    return accepted;
  }
  appendText(generationId: string, text: string): void {
    if (!this.accepts(generationId)) return;
    if (this.active!.record.generatedText.length + text.length > this.maxTextChars)
      throw new Error("Voice generated text limit exceeded");
    this.active!.record.generatedText += text;
  }
  acknowledge(ack: PlaybackAck): void {
    if (!this.active || this.active.record.generationId !== ack.generationId) return;
    if (ack.complete && !this.active.outputDone)
      throw new Error("Playback completion arrived before generation finished");
    const length = this.active.record.generatedText.length;
    const played = ack.complete ? length : ack.playedCharacters;
    if (!Number.isSafeInteger(played) || played! < this.active.heardCharacters || played! > length)
      throw new Error("Invalid playback acknowledgement");
    this.active.heardCharacters = played!;
    this.active.complete = !!ack.complete;
  }
  finish(interrupted: boolean): VoiceTurnRecord | undefined {
    const active = this.active;
    if (!active) return undefined;
    active.controller.abort();
    this.active = undefined;
    const record = active.record;
    record.interrupted = interrupted;
    record.heardText = record.generatedText.slice(0, active.heardCharacters);
    record.delivery = active.complete ? "confirmed" : active.heardCharacters ? "partial" : "unknown";
    if (record.generatedText)
      this.addHistory({
        role: "assistant",
        content:
          record.heardText +
          (record.delivery === "confirmed" ? "" : "\n[Speech delivery unconfirmed beyond this point]"),
      });
    this.records.push({ ...record });
    if (this.records.length > 200) this.records.shift();
    return { ...record };
  }
  getHistory(): ChatMessage[] {
    return structuredClone(this.history);
  }
  private addHistory(message: ChatMessage): void {
    this.history.push(message);
    while (this.history.length > this.maxHistoryMessages) this.history.shift();
  }
}
