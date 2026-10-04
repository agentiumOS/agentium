import { durableCanonical } from "@agentium/core";
import { watchId } from "./definition.js";
import type { WatchEvent, WatchIdentity, WatchSource } from "./types.js";

type Result<T> = Promise<{ data: T }>;
type RequestOptions = { signal: AbortSignal };
interface GmailMessage {
  id?: string | null;
  internalDate?: string | null;
  snippet?: string | null;
  payload?: { headers?: Array<{ name?: string | null; value?: string | null }> } | null;
}
/** Structural subset of an already-authenticated Gmail client; no SDK or credentials are loaded. */
export interface GmailWatchClient {
  users: {
    getProfile(
      params: { userId: string },
      options: RequestOptions,
    ): Result<{ historyId?: string | null; emailAddress?: string | null }>;
    watch(
      params: {
        userId: string;
        requestBody: { topicName: string; labelIds?: string[]; labelFilterBehavior?: "INCLUDE" };
      },
      options: RequestOptions,
    ): Result<{ historyId?: string | null; expiration?: string | null }>;
    stop(params: { userId: string }, options: RequestOptions): Promise<unknown>;
    history: {
      list(
        params: {
          userId: string;
          startHistoryId: string;
          historyTypes: string[];
          maxResults: number;
          pageToken?: string;
        },
        options: RequestOptions,
      ): Result<{
        historyId?: string | null;
        nextPageToken?: string | null;
        history?: Array<{
          id?: string | null;
          messagesAdded?: Array<{ message?: { id?: string | null; labelIds?: string[] | null } | null }>;
        }>;
      }>;
    };
    messages: {
      list(
        params: { userId: string; maxResults: number; pageToken?: string; labelIds?: string[] },
        options: RequestOptions,
      ): Result<{ messages?: Array<{ id?: string | null }>; nextPageToken?: string | null }>;
      get(
        params: { userId: string; id: string; format: "metadata"; metadataHeaders: string[] },
        options: RequestOptions,
      ): Result<GmailMessage>;
    };
  };
}
export interface GmailWatchOptions {
  id: string;
  mailbox: string;
  identity: WatchIdentity;
  topicName: string;
  labelIds?: string[];
  client: GmailWatchClient;
  /** Host verifies Pub/Sub signature, audience and subscription ownership before decoding. */
  verifyPush?: (raw: unknown) => Promise<{
    identity: WatchIdentity;
    messageId: string;
    data: { emailAddress: string; historyId: string };
  }>;
}
function cursor(value: unknown): string {
  if (typeof value !== "string" || !/^\d{1,256}$/.test(value)) throw new Error("Invalid Gmail history cursor");
  return value;
}
function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = error as { code?: number; response?: { status?: number } };
  return status.code === 404 || status.response?.status === 404;
}
/** Optional Gmail source: daily renewal/polling are scheduled by DurableWatch, not in this constructor. */
export function gmailWatchSource(options: GmailWatchOptions): WatchSource {
  const { client, id, mailbox, topicName, verifyPush } = options;
  const identity = { ...options.identity };
  const labels = options.labelIds ? [...options.labelIds] : undefined;
  for (const value of [id, mailbox, topicName, identity.actorId, identity.tenantId, ...(labels ?? [])]) watchId(value);
  if (!topicName.startsWith("projects/") || !topicName.includes("/topics/"))
    throw new Error("Gmail watch requires an explicit Pub/Sub topic name");
  const userId = mailbox;
  const profile = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    const { data } = await client.users.getProfile({ userId }, { signal });
    if (data.emailAddress?.toLowerCase() !== mailbox.toLowerCase())
      throw new Error("Authenticated Gmail client mailbox differs from source binding");
    return cursor(data.historyId);
  };
  const event = async (messageId: string, eventId: string, signal: AbortSignal): Promise<WatchEvent> => {
    signal.throwIfAborted();
    const { data } = await client.users.messages.get(
      { userId, id: messageId, format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"] },
      { signal },
    );
    if (data.id !== messageId) throw new Error("Gmail returned a different message");
    const occurredAt = Number(data.internalDate);
    if (!Number.isSafeInteger(occurredAt) || occurredAt < 0 || !data.internalDate)
      throw new Error("Invalid Gmail message timestamp");
    return {
      id: eventId,
      occurredAt,
      data: {
        messageId,
        snippet: data.snippet ?? "",
        headers: (data.payload?.headers ?? [])
          .filter((h) => ["from", "to", "subject", "date"].includes(h.name?.toLowerCase() ?? ""))
          .map((h) => ({ name: h.name ?? "", value: h.value ?? "" })),
      },
    };
  };
  const source: WatchSource = {
    id,
    scope: mailbox,
    capabilities: { idempotentActivation: true, polling: true, push: Boolean(verifyPush) },
    baseline: profile,
    async activate(key, signal) {
      await profile(signal); // Verify authenticated account independently of untrusted push payload claims.
      signal.throwIfAborted();
      const { data } = await client.users.watch(
        {
          userId,
          requestBody: {
            topicName,
            ...(labels?.length ? { labelIds: labels, labelFilterBehavior: "INCLUDE" as const } : {}),
          },
        },
        { signal },
      );
      cursor(data.historyId);
      const expiresAt = Number(data.expiration);
      if (!Number.isSafeInteger(expiresAt) || expiresAt < 0 || !data.expiration)
        throw new Error("Invalid Gmail watch expiry");
      return { reference: key, expiresAt };
    },
    async stop(subscription, signal) {
      if (subscription) {
        await profile(signal);
        signal.throwIfAborted();
        await client.users.stop({ userId }, { signal });
      }
    },
    compareCursors(left, right) {
      const a = BigInt(cursor(left));
      const b = BigInt(cursor(right));
      return a < b ? -1 : a > b ? 1 : 0;
    },
    async read(start, limits, signal) {
      cursor(start);
      let pageToken: string | undefined;
      let committed = start;
      const events: WatchEvent[] = [];
      const seen = new Set<string>();
      // Only history.list's 404 means the checkpoint expired. A vanished message is
      // independent of history validity and must not suppress other newly added messages.
      const expiredHistory = Symbol("expired Gmail history");
      try {
        for (let page = 0; page < limits.maxPagesPerWake; page++) {
          signal.throwIfAborted();
          const { data } = await client.users.history
            .list(
              {
                userId,
                startHistoryId: start,
                historyTypes: ["messageAdded"],
                maxResults: Math.min(500, limits.maxEventsPerWake),
                ...(pageToken ? { pageToken } : {}),
              },
              { signal },
            )
            .catch((error: unknown) => {
              if (isNotFound(error)) throw expiredHistory;
              throw error;
            });
          // Bound response records too; a malicious/incorrect adapter cannot hide work in empty histories.
          if ((data.history?.length ?? 0) > Math.min(500, limits.maxEventsPerWake))
            throw new Error("Gmail history page exceeds bound");
          for (const history of data.history ?? []) {
            const historyId = cursor(history.id);
            if ((history.messagesAdded?.length ?? 0) > limits.maxEventsPerWake)
              throw new Error("Gmail history event bound exceeded");
            for (const added of history.messagesAdded ?? []) {
              const messageId = added.message?.id;
              watchId(messageId);
              if (labels?.length && !labels.some((label) => added.message?.labelIds?.includes(label))) continue;
              const eventId = `${historyId}:${messageId}:added`;
              if (seen.has(eventId)) continue;
              if (seen.size >= limits.maxEventsPerWake) throw new Error("Gmail history event bound exceeded");
              seen.add(eventId);
              try {
                events.push(await event(messageId, eventId, signal));
              } catch (error) {
                if (!isNotFound(error)) throw error;
                signal.throwIfAborted();
              }
            }
          }
          committed = cursor(data.historyId);
          if (!data.nextPageToken) return { cursor: committed, events, resynced: false };
          watchId(data.nextPageToken);
          pageToken = data.nextPageToken;
        }
        throw new Error("Gmail history page bound exceeded; cursor unchanged");
      } catch (error) {
        if (error !== expiredHistory) throw error;
      }
      // Expired history: establish a conservative baseline before bounded full sync.
      committed = await profile(signal);
      pageToken = undefined;
      events.length = 0;
      seen.clear();
      for (let page = 0; page < limits.maxPagesPerWake; page++) {
        signal.throwIfAborted();
        const { data } = await client.users.messages.list(
          {
            userId,
            maxResults: Math.min(500, limits.maxResyncEvents),
            ...(labels?.length ? { labelIds: labels } : {}),
            ...(pageToken ? { pageToken } : {}),
          },
          { signal },
        );
        if ((data.messages?.length ?? 0) > Math.min(500, limits.maxResyncEvents))
          throw new Error("Gmail resync page exceeds bound");
        for (const message of data.messages ?? []) {
          watchId(message.id);
          if (seen.has(message.id)) continue;
          if (events.length >= limits.maxResyncEvents)
            throw new Error("Gmail resync event bound exceeded; cursor unchanged");
          seen.add(message.id);
          events.push(await event(message.id, `resync:${committed}:${message.id}`, signal));
        }
        if (!data.nextPageToken) return { cursor: committed, events, resynced: true };
        watchId(data.nextPageToken);
        pageToken = data.nextPageToken;
      }
      throw new Error("Gmail resync page bound exceeded; cursor unchanged");
    },
  };
  if (verifyPush)
    source.verifyTrigger = async (raw) => {
      const verified = await verifyPush(raw);
      if (
        durableCanonical(verified.identity) !== durableCanonical(identity) ||
        verified.data.emailAddress.toLowerCase() !== mailbox.toLowerCase()
      )
        throw new Error("Verified Gmail push does not own this source");
      watchId(verified.messageId);
      return {
        ...identity,
        sourceId: id,
        sourceScope: mailbox,
        eventId: verified.messageId,
        cursor: cursor(verified.data.historyId),
      };
    };
  return source;
}
