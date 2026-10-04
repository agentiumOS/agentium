import type { ChatMessage } from "../models/types.js";
import { groupConversationTurns } from "./context-compactor.js";

/** A soft message limit: retain the latest turn intact even if it exceeds the limit. */
export function retainRecentTurns(messages: ChatMessage[], maxMessages: number): ChatMessage[] {
  if (maxMessages <= 0 || messages.length <= maxMessages) return messages;
  const turns = groupConversationTurns(messages);
  const retained: ChatMessage[][] = [];
  let count = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (retained.length > 0 && count + turn.length > maxMessages) break;
    retained.unshift(turn);
    count += turn.length;
  }
  return retained.flat();
}
