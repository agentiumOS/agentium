import type { MessageContent } from "../models/types.js";

/** A live question. Applications own forms and validation beyond these choices. */
export interface InputRequestOptions {
  question: string;
  choices?: readonly string[];
  /** Overrides the runtime's per-question waiting timeout. */
  timeoutMs?: number;
}
export interface InputRequest extends InputRequestOptions {
  id: string;
  runId: string;
}
export interface InputReply {
  requestId: string;
  input: MessageContent;
}
export interface RunInput {
  id?: string;
  input: MessageContent;
  mode: "steer" | "follow_up" | "replace";
}
