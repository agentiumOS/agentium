import type { ChatMessage } from "../models/types.js";
import { type ConversationGrouping, groupConversationTurns } from "./context-compactor.js";

function signature(message: ChatMessage): string {
  return JSON.stringify(message);
}

function isProtected(message: ChatMessage): boolean {
  return (
    message.role === "tool" ||
    (message.role === "assistant" && Boolean(message.toolCalls?.length || message.providerExtras))
  );
}

/**
 * Host messages are immutable. Closed historical tool/replay groups may be removed
 * atomically; a retained or current group must keep every opaque/call/result item.
 */
export function validateConversationTransform(
  before: readonly ChatMessage[],
  after: readonly ChatMessage[],
  grouping: ConversationGrouping = "turn",
): void {
  if (
    !Array.isArray(after) ||
    after.some((message) => !message || !["system", "user", "assistant", "tool"].includes(message.role))
  ) {
    throw new Error("Conversation transform must return valid chat messages");
  }
  const systems = (messages: readonly ChatMessage[]) => messages.filter((m) => m.role === "system").map(signature);
  if (JSON.stringify(systems(before)) !== JSON.stringify(systems(after))) {
    throw new Error("Conversation transform cannot remove, add, or alter host instructions");
  }
  const originalTurns = groupConversationTurns(
    before.filter((m) => m.role !== "system"),
    grouping,
  );
  groupConversationTurns(
    after.filter((m) => m.role !== "system"),
    grouping,
  );
  const retained = after.filter(isProtected).map(signature);
  const available = new Map<string, number>();
  for (const message of before.filter(isProtected))
    available.set(signature(message), (available.get(signature(message)) ?? 0) + 1);
  for (const item of retained) {
    const count = available.get(item) ?? 0;
    if (!count) throw new Error("Conversation transform cannot introduce or alter provider/tool continuation items");
    available.set(item, count - 1);
  }
  let cursor = 0;
  for (let i = 0; i < originalTurns.length; i++) {
    const turn = originalTurns[i];
    const protectedItems = turn.filter(isProtected).map(signature);
    if (!protectedItems.length) continue;
    const present = protectedItems.some((item) => retained.slice(cursor).includes(item));
    const pending = new Set(turn.flatMap((m) => (m.toolCalls ?? []).map((call) => call.id)));
    for (const message of turn) if (message.role === "tool" && message.toolCallId) pending.delete(message.toolCallId);
    if (!present && i !== originalTurns.length - 1 && pending.size === 0) continue;
    for (const item of protectedItems) {
      if (retained[cursor++] !== item)
        throw new Error("Conversation transform must preserve intact provider/tool continuation groups");
    }
  }
  if (cursor !== retained.length) throw new Error("Conversation transform reordered continuation groups");

  const sourceMessages = before.filter((m) => m.providerExtras?.harnessContext);
  for (const message of after) {
    if (!message.providerExtras?.harnessContext) continue;
    if (message.role !== "user" || !sourceMessages.some((source) => signature(source) === signature(message))) {
      throw new Error("Conversation transform cannot promote or alter retrieved source provenance");
    }
  }
  // A source may be removed, but not stripped of its source-data envelope.
  for (const source of sourceMessages) {
    if (after.some((m) => m.content === source.content && signature(m) !== signature(source))) {
      throw new Error("Conversation transform cannot strip retrieved source provenance");
    }
  }
}
