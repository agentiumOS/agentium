import type { ChatMessage } from "../models/types.js";
import type { StorageDriver } from "../storage/driver.js";
import type { Session } from "./types.js";

/**
 * Like `SessionManager` but writes each message as an individual entry instead
 * of re-serializing the whole conversation on every turn. Periodically rolls up
 * the loose entries into a snapshot to bound read latency.
 *
 * Storage layout (per sessionId):
 *
 *   ns="sessions:meta"       key=<sessionId>           -> Session minus messages
 *   ns="sessions:snapshot"   key=<sessionId>           -> ChatMessage[] (collapsed)
 *   ns="sessions:msg"        key=<sessionId>:<seq>     -> ChatMessage (incremental)
 *
 * `seq` is a zero-padded monotonically increasing integer so that
 * `list(ns, sessionId + ":")` returns entries in chronological order.
 */
export interface IncrementalSessionConfig {
  /** Take a full snapshot every N message appends. Default: 25. */
  snapshotFrequency?: number;
  /** Maximum messages kept in session history (oldest trimmed). Default: unlimited. */
  maxMessages?: number;
}

const NS_META = "sessions:meta";
const NS_SNAP = "sessions:snapshot";
const NS_MSG = "sessions:msg";

function padSeq(n: number): string {
  return n.toString().padStart(10, "0");
}

interface SessionMeta {
  sessionId: string;
  userId?: string;
  state: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  /** Monotonically increasing counter for incremental message keys. */
  nextSeq: number;
  /** Number of messages stored since the last snapshot was taken. */
  appendsSinceSnapshot: number;
}

export class IncrementalSessionManager {
  private snapshotFrequency: number;
  private maxMessages?: number;
  private locks = new Map<string, Promise<void>>();

  constructor(
    private storage: StorageDriver,
    config?: IncrementalSessionConfig,
  ) {
    this.snapshotFrequency = config?.snapshotFrequency ?? 25;
    this.maxMessages = config?.maxMessages;
  }

  private async withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(sessionId) ?? Promise.resolve();
    let resolve!: () => void;
    const next = new Promise<void>((r) => {
      resolve = r;
    });
    this.locks.set(sessionId, next);
    try {
      await prev;
      return await fn();
    } finally {
      resolve();
      if (this.locks.get(sessionId) === next) this.locks.delete(sessionId);
    }
  }

  private async getOrInitMeta(sessionId: string, userId?: string): Promise<SessionMeta> {
    const existing = await this.storage.get<SessionMeta>(NS_META, sessionId);
    if (existing) {
      // Re-hydrate Date instances (storage drivers may have JSON-serialized them).
      return {
        ...existing,
        createdAt: existing.createdAt instanceof Date ? existing.createdAt : new Date(existing.createdAt),
        updatedAt: existing.updatedAt instanceof Date ? existing.updatedAt : new Date(existing.updatedAt),
      };
    }
    const meta: SessionMeta = {
      sessionId,
      userId,
      state: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      nextSeq: 0,
      appendsSinceSnapshot: 0,
    };
    await this.storage.set(NS_META, sessionId, meta);
    return meta;
  }

  private async readMessages(sessionId: string): Promise<ChatMessage[]> {
    const snapshot = (await this.storage.get<ChatMessage[]>(NS_SNAP, sessionId)) ?? [];
    const loose = await this.storage.list<ChatMessage>(NS_MSG, `${sessionId}:`);
    // `list` doesn't guarantee order; sort by key suffix (which is zero-padded seq).
    loose.sort((a, b) => a.key.localeCompare(b.key));
    return [...snapshot, ...loose.map((e) => e.value)];
  }

  async getOrCreate(sessionId: string, userId?: string): Promise<Session> {
    return this.withLock(sessionId, async () => {
      const meta = await this.getOrInitMeta(sessionId, userId);
      const messages = await this.readMessages(sessionId);
      return {
        sessionId: meta.sessionId,
        userId: meta.userId,
        state: meta.state,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        messages,
      };
    });
  }

  async appendMessage(sessionId: string, msg: ChatMessage): Promise<void> {
    return this.appendMessages(sessionId, [msg]);
  }

  async appendMessages(sessionId: string, msgs: ChatMessage[]): Promise<void> {
    if (msgs.length === 0) return;
    return this.withLock(sessionId, async () => {
      const meta = await this.getOrInitMeta(sessionId);
      for (const msg of msgs) {
        const seq = meta.nextSeq++;
        await this.storage.set(NS_MSG, `${sessionId}:${padSeq(seq)}`, msg);
      }
      meta.appendsSinceSnapshot += msgs.length;
      meta.updatedAt = new Date();

      if (meta.appendsSinceSnapshot >= this.snapshotFrequency) {
        await this.snapshot(sessionId, meta);
      } else {
        await this.storage.set(NS_META, sessionId, meta);
      }
    });
  }

  /**
   * Collapse all loose `sessions:msg` entries into a single `sessions:snapshot`
   * entry and delete them. Also applies `maxMessages` trimming.
   */
  private async snapshot(sessionId: string, meta: SessionMeta): Promise<void> {
    let all = await this.readMessages(sessionId);
    if (this.maxMessages && all.length > this.maxMessages) {
      all = all.slice(all.length - this.maxMessages);
    }
    await this.storage.set(NS_SNAP, sessionId, all);
    const loose = await this.storage.list<ChatMessage>(NS_MSG, `${sessionId}:`);
    for (const entry of loose) {
      await this.storage.delete(NS_MSG, entry.key);
    }
    meta.appendsSinceSnapshot = 0;
    await this.storage.set(NS_META, sessionId, meta);
  }

  /**
   * Force an immediate snapshot. Useful for graceful drains.
   */
  async snapshotNow(sessionId: string): Promise<void> {
    return this.withLock(sessionId, async () => {
      const meta = await this.storage.get<SessionMeta>(NS_META, sessionId);
      if (!meta) return;
      await this.snapshot(sessionId, {
        ...meta,
        createdAt: meta.createdAt instanceof Date ? meta.createdAt : new Date(meta.createdAt),
        updatedAt: new Date(),
      });
    });
  }

  async getHistory(sessionId: string, limit?: number): Promise<ChatMessage[]> {
    const messages = await this.readMessages(sessionId);
    if (limit && limit > 0) return messages.slice(-limit);
    return messages;
  }

  async updateState(sessionId: string, patch: Record<string, unknown>): Promise<void> {
    return this.withLock(sessionId, async () => {
      const meta = await this.getOrInitMeta(sessionId);
      Object.assign(meta.state, patch);
      meta.updatedAt = new Date();
      await this.storage.set(NS_META, sessionId, meta);
    });
  }

  async getState(sessionId: string): Promise<Record<string, unknown>> {
    const meta = await this.storage.get<SessionMeta>(NS_META, sessionId);
    return meta?.state ?? {};
  }

  async deleteSession(sessionId: string): Promise<void> {
    return this.withLock(sessionId, async () => {
      await this.storage.delete(NS_META, sessionId);
      await this.storage.delete(NS_SNAP, sessionId);
      const loose = await this.storage.list<ChatMessage>(NS_MSG, `${sessionId}:`);
      for (const entry of loose) {
        await this.storage.delete(NS_MSG, entry.key);
      }
    });
  }
}
