import type { ChatMessage } from "../models/types.js";
import type { StorageDriver } from "../storage/driver.js";
import type { Session } from "./types.js";

const NAMESPACE = "sessions";

export interface SessionManagerConfig {
  /** Maximum messages kept in session history. Oldest are trimmed first. Default: unlimited. */
  maxMessages?: number;
}

export interface AppendResult {
  /** Messages that were trimmed from the session because maxMessages was exceeded. */
  overflow: ChatMessage[];
}

export class SessionManager {
  private maxMessages?: number;
  private locks = new Map<string, Promise<void>>();

  constructor(
    private storage: StorageDriver,
    config?: SessionManagerConfig,
  ) {
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
      if (this.locks.get(sessionId) === next) {
        this.locks.delete(sessionId);
      }
    }
  }

  async getOrCreate(sessionId: string, userId?: string): Promise<Session> {
    return this.withLock(sessionId, () => this._getOrCreate(sessionId, userId));
  }

  private async _getOrCreate(sessionId: string, userId?: string): Promise<Session> {
    const existing = await this.storage.get<Session>(NAMESPACE, sessionId);
    if (existing) return existing;

    const session: Session = {
      sessionId,
      userId,
      messages: [],
      state: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.storage.set(NAMESPACE, sessionId, session);
    return session;
  }

  async appendMessage(sessionId: string, msg: ChatMessage): Promise<AppendResult> {
    return this.appendMessages(sessionId, [msg]);
  }

  async appendMessages(sessionId: string, msgs: ChatMessage[]): Promise<AppendResult> {
    return this.withLock(sessionId, async () => {
      const session = await this._getOrCreate(sessionId);
      session.messages.push(...msgs);

      let overflow: ChatMessage[] = [];
      if (this.maxMessages && session.messages.length > this.maxMessages) {
        overflow = session.messages.splice(0, session.messages.length - this.maxMessages);
      }

      session.updatedAt = new Date();
      await this.storage.set(NAMESPACE, sessionId, session);
      return { overflow };
    });
  }

  async getHistory(sessionId: string, limit?: number): Promise<ChatMessage[]> {
    const session = await this.storage.get<Session>(NAMESPACE, sessionId);
    if (!session) return [];

    if (limit && limit > 0) {
      return session.messages.slice(-limit);
    }
    return session.messages;
  }

  async updateState(sessionId: string, patch: Record<string, unknown>): Promise<void> {
    return this.withLock(sessionId, async () => {
      const session = await this._getOrCreate(sessionId);
      Object.assign(session.state, patch);
      session.updatedAt = new Date();
      await this.storage.set(NAMESPACE, sessionId, session);
    });
  }

  async getState(sessionId: string): Promise<Record<string, unknown>> {
    const session = await this.storage.get<Session>(NAMESPACE, sessionId);
    return session?.state ?? {};
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.storage.delete(NAMESPACE, sessionId);
  }
}
