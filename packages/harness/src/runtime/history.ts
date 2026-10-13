import { createHash, randomUUID } from "node:crypto";
import {
  type ChatMessage,
  groupConversationTurns,
  type ModelProvider,
  validateConversationTransform,
} from "@agentium/core";
import type { HarnessIdentity } from "./session-bindings.js";

export interface HistoryArchiveReference {
  id: string;
  conversationId: string;
  messageCount: number;
  /** SHA-256 of the UTF-8 JSON message array; retrieval must match exactly. */
  digest: string;
}
export interface HistoryArchiveScope {
  identity: HarnessIdentity;
  sessionId: string;
}
/** Host-owned storage. write must acknowledge successful storage before resolving. */
export interface HistoryArchive {
  write(
    scope: HistoryArchiveScope,
    reference: HistoryArchiveReference,
    messages: readonly ChatMessage[],
  ): Promise<void>;
  read(scope: HistoryArchiveScope, reference: HistoryArchiveReference): Promise<readonly ChatMessage[]>;
}
export interface ResidentHistoryPolicy {
  /** Per-conversation limit at safe model/session boundaries, including pinned host instructions. */
  maxMessages: number;
  /** Optional per-conversation bound on UTF-8 JSON bytes. */
  maxBytes?: number;
  archive: HistoryArchive;
  /** Explicit host attestation for custom provider envelopes; default rejects unknown opaque data. */
  canEvict?: (messages: readonly ChatMessage[], provider?: ModelProvider) => boolean;
}
export class HistoryRetentionError extends Error {
  readonly code = "history_retention_unsupported";
  constructor(message: string) {
    super(message);
    this.name = "HistoryRetentionError";
  }
}
const digest = (messages: readonly ChatMessage[]) =>
  createHash("sha256").update(JSON.stringify(messages)).digest("hex");
export function validateHistoryPolicy(policy: ResidentHistoryPolicy): void {
  for (const value of [policy.maxMessages, policy.maxBytes])
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
      throw new TypeError("History limits must be positive safe integers");
  if (!policy.archive || typeof policy.archive.write !== "function" || typeof policy.archive.read !== "function")
    throw new TypeError("Bounded resident history requires a host archive");
}
function knownReplay(message: ChatMessage): boolean {
  const extras = message.providerExtras;
  return (
    !extras ||
    Object.keys(extras).every((key) =>
      ["responsesReplay", "responsesReasoning", "anthropicContent", "harnessContext"].includes(key),
    )
  );
}
/** Pure planning: never split tool batches, provider envelopes, or the latest user turn. */
export function planHistoryRetention(
  messages: readonly ChatMessage[],
  policy: ResidentHistoryPolicy,
  provider?: ModelProvider,
) {
  const fits = (items: readonly ChatMessage[]) =>
    items.length <= policy.maxMessages &&
    (policy.maxBytes === undefined || Buffer.byteLength(JSON.stringify(items)) <= policy.maxBytes);
  if (fits(messages)) return { resident: [...messages], archived: [] as ChatMessage[] };
  const systems = messages.filter((message) => message.role === "system");
  const turns = groupConversationTurns(messages.filter((message) => message.role !== "system"));
  const keep = [turns.at(-1) ?? []];
  if (!fits([...systems, ...keep.flat()]))
    throw new HistoryRetentionError("Resident history limit cannot fit host instructions and the current intact turn");
  let index = turns.length - 2;
  for (; index >= 0; index--) {
    if (!fits([...systems, ...turns[index], ...keep.flat()])) break;
    keep.unshift(turns[index]);
  }
  const archived = turns.slice(0, index + 1).flat();
  if (
    provider?.capabilities?.historyEviction === "unsupported" ||
    (archived.some((message) => !knownReplay(message)) &&
      provider?.capabilities?.historyEviction !== "closed_turns" &&
      !policy.canEvict?.(structuredClone(archived), provider))
  )
    throw new HistoryRetentionError("Provider continuation has no declared safe closed-turn eviction policy");
  const resident = [...systems, ...keep.flat()];
  validateConversationTransform(messages, resident);
  return { resident, archived };
}
export async function archiveHistory(
  messages: readonly ChatMessage[],
  policy: ResidentHistoryPolicy,
  scope: HistoryArchiveScope,
  conversationId: string,
  provider?: ModelProvider,
): Promise<{ resident: ChatMessage[]; reference?: HistoryArchiveReference }> {
  const { resident, archived } = planHistoryRetention(messages, policy, provider);
  if (!archived.length) return { resident };
  const reference = { id: randomUUID(), conversationId, messageCount: archived.length, digest: digest(archived) };
  await policy.archive.write(structuredClone(scope), structuredClone(reference), structuredClone(archived));
  return { resident, reference };
}
export async function retrieveHistory(
  archive: HistoryArchive,
  scope: HistoryArchiveScope,
  reference: HistoryArchiveReference,
): Promise<ChatMessage[]> {
  const messages = await archive.read(structuredClone(scope), structuredClone(reference));
  if (!Array.isArray(messages) || messages.length !== reference.messageCount || digest(messages) !== reference.digest)
    throw new HistoryRetentionError("Archived history does not match its canonical reference");
  validateConversationTransform(messages, messages);
  return structuredClone([...messages]);
}

/** Completed child transcripts need no resident continuation; preserve them entirely in the archive. */
export async function archiveCompletedConversation(
  messages: readonly ChatMessage[],
  policy: ResidentHistoryPolicy,
  scope: HistoryArchiveScope,
  conversationId: string,
): Promise<HistoryArchiveReference | undefined> {
  if (!messages.length) return undefined;
  validateConversationTransform(messages, messages);
  const pending = new Set(messages.flatMap((message) => (message.toolCalls ?? []).map((call) => call.id)));
  for (const message of messages) if (message.role === "tool" && message.toolCallId) pending.delete(message.toolCallId);
  if (pending.size) throw new HistoryRetentionError("Cannot archive an unfinished child tool exchange as completed");
  const reference = { id: randomUUID(), conversationId, messageCount: messages.length, digest: digest(messages) };
  await policy.archive.write(structuredClone(scope), structuredClone(reference), structuredClone(messages));
  return reference;
}
