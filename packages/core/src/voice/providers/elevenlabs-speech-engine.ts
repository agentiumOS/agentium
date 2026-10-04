import { randomUUID } from "node:crypto";
import type { ChatMessage } from "../../models/types.js";
import type { VoiceBrain } from "../speech-types.js";
export interface SpeechEngineTranscriptMessage {
  role: "user" | "agent";
  content: string;
}
export interface SpeechEngineSessionPort {
  conversationId: string;
  sendResponse(response: AsyncIterable<{ type: "response.output_text.delta"; delta: string }>): unknown;
}
/** Supply this callback to the official SDK's authenticated engine.attach(...). Never disable SDK authentication. */
export function createElevenLabsSpeechEngineHandler(brain: VoiceBrain) {
  const seen = new WeakMap<object, string>();
  return (
    transcript: readonly SpeechEngineTranscriptMessage[],
    signal: AbortSignal,
    session: SpeechEngineSessionPort,
  ): unknown => {
    signal.throwIfAborted();
    if (
      transcript.length > 2048 ||
      transcript.some(
        (entry) =>
          typeof entry.content !== "string" || entry.content.length > 64_000 || !["user", "agent"].includes(entry.role),
      )
    )
      throw new Error("Speech Engine transcript exceeds supported bounds");
    const latest = transcript.at(-1);
    if (latest?.role !== "user" || typeof latest.content !== "string") return;
    const identity = JSON.stringify(transcript);
    if (seen.get(session) === identity) return;
    seen.set(session, identity);
    const history: ChatMessage[] = transcript.map((entry) => ({
      role: entry.role === "agent" ? "assistant" : "user",
      content: entry.content,
    }));
    // Speech Engine supplies authoritative conversation history; never append it again to another session store.
    const input = {
      text: latest.content,
      history,
      sessionId: session.conversationId,
      turnId: randomUUID(),
      generationId: randomUUID(),
    };
    return session.sendResponse(
      (async function* () {
        for await (const chunk of brain.respond(input, signal)) {
          signal.throwIfAborted();
          if (chunk.type === "text") yield { type: "response.output_text.delta" as const, delta: chunk.text };
        }
      })(),
    );
  };
}
