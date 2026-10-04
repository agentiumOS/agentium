import type { ChatMessage } from "@agentium/core";

export interface HarnessIdentity {
  userId: string;
  tenantId: string;
}
export interface HarnessSessionSnapshot {
  conversations?: Record<string, ChatMessage[]>;
  history: ChatMessage[];
  state: Record<string, unknown>;
  revision: number;
  replayable: boolean;
}
export interface HarnessSessionLease {
  read(): HarnessSessionSnapshot;
  commit(snapshot: Omit<HarnessSessionSnapshot, "revision">): void;
  release(): void;
}
export class HarnessSessionConflict extends Error {
  readonly code = "session_conflict";
  constructor() {
    super("A writer already owns this tenant/session");
  }
}
export interface HarnessSessionStore {
  readonly guarantees: { durable: boolean; compareAndSwap: boolean; singleWriter: "process" | "distributed" };
  acquire(identity: HarnessIdentity, sessionId: string): Promise<HarnessSessionLease>;
}
export function harnessSessionKey(identity: HarnessIdentity, sessionId: string): string {
  return JSON.stringify([identity.tenantId, identity.userId, sessionId]);
}
/** One writer per scoped session; deliberately rejects rather than silently interleaving. */
export class InMemoryHarnessSessionStore implements HarnessSessionStore {
  readonly guarantees = { durable: false, compareAndSwap: false, singleWriter: "process" as const };
  private records = new Map<string, HarnessSessionSnapshot>();
  private active = new Set<string>();
  async acquire(identity: HarnessIdentity, sessionId: string): Promise<HarnessSessionLease> {
    const key = harnessSessionKey(identity, sessionId);
    if (this.active.has(key)) throw new HarnessSessionConflict();
    this.active.add(key);
    let released = false;
    const check = () => {
      if (released) throw new Error("Session lease has been released");
    };
    return {
      read: () => {
        check();
        return structuredClone(this.records.get(key) ?? { history: [], state: {}, revision: 0, replayable: true });
      },
      commit: (snapshot) => {
        check();
        const revision = (this.records.get(key)?.revision ?? 0) + 1;
        this.records.set(key, structuredClone({ ...snapshot, revision }));
      },
      release: () => {
        if (!released) {
          released = true;
          this.active.delete(key);
        }
      },
    };
  }
  /** Imported display-only transcripts are readable but never represented as complete replay state. */
  importLegacy(identity: HarnessIdentity, sessionId: string, history: ChatMessage[]): void {
    const key = harnessSessionKey(identity, sessionId);
    if (this.active.has(key)) throw new HarnessSessionConflict();
    this.records.set(key, { history: structuredClone(history), state: {}, revision: 0, replayable: false });
  }
}
export interface ScopedResource<T = unknown> {
  value: T;
  ownership: "host" | "runtime";
  dispose?: () => Promise<void>;
}
export interface SessionResourceLease<T> {
  value: T;
  release: () => Promise<void>;
}
/** Session resources live until explicit closeSession; run resources use their returned lease. */
export class HarnessResourcePool {
  private sessions = new Map<string, Map<string, { resource: ScopedResource; users: number }>>();
  private pending = new Map<string, Promise<ScopedResource>>();
  async acquire<T>(
    identity: HarnessIdentity,
    sessionId: string,
    id: string,
    scope: "host" | "session" | "run",
    initialize: () => Promise<ScopedResource<T>>,
  ): Promise<SessionResourceLease<T>> {
    if (scope === "run" || scope === "host") {
      const resource = await initialize();
      if (scope === "host" && resource.ownership !== "host") {
        try {
          await resource.dispose?.();
        } catch {
          /* preserve the ownership error */
        }
        throw new Error("Host resources must be externally owned");
      }
      let released = false;
      return {
        value: resource.value,
        release: async () => {
          if (!released) {
            released = true;
            if (resource.ownership === "runtime") await resource.dispose?.();
          }
        },
      };
    }
    const key = harnessSessionKey(identity, sessionId);
    let resources = this.sessions.get(key);
    if (!resources) {
      resources = new Map();
      this.sessions.set(key, resources);
    }
    let entry = resources.get(id);
    if (!entry) {
      const pendingKey = JSON.stringify([key, id]);
      let promise = this.pending.get(pendingKey) as Promise<ScopedResource<T>> | undefined;
      if (!promise) {
        promise = initialize();
        this.pending.set(pendingKey, promise);
      }
      try {
        const resource = await promise;
        entry = resources.get(id);
        if (!entry) {
          entry = { resource, users: 0 };
          resources.set(id, entry);
        }
      } finally {
        this.pending.delete(pendingKey);
      }
    }
    entry.users++;
    let released = false;
    return {
      value: entry.resource.value as T,
      release: async () => {
        if (!released) {
          released = true;
          entry!.users--;
        }
      },
    };
  }
  async closeSession(identity: HarnessIdentity, sessionId: string): Promise<readonly string[]> {
    const key = harnessSessionKey(identity, sessionId);
    const resources = this.sessions.get(key);
    if (!resources) return [];
    if (
      [...resources.values()].some((entry) => entry.users > 0) ||
      [...this.pending.keys()].some((pending) => JSON.parse(pending)[0] === key)
    )
      throw new HarnessSessionConflict();
    this.sessions.delete(key);
    const failures: string[] = [];
    for (const [id, entry] of [...resources].reverse()) {
      try {
        if (entry.resource.ownership === "runtime") await entry.resource.dispose?.();
      } catch {
        failures.push(id);
      }
    }
    return failures;
  }
}
